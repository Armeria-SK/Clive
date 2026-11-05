import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyStatements, noRepo, type MatchCtx } from '../src/tools/hooks/allowlist.ts';
import { lexShell } from '../src/tools/hooks/shell-lex.ts';
import { tempDir } from './helpers.ts';

// 7 回目の審査（致命）: Windows PowerShell 5.1 は、外部のプログラムに渡す空の引数（'' や ""）を黙って捨てる。
// `git grep -e '' -- '-O./x.sh'` をガードは「-e の値が空、-- のあとにパス」と読んで許したが、git に渡るのは `grep -e -- -O./x.sh`
// （-e の値が `--` になり、-O./x.sh がフラグになる）で、本当に x.sh が動いた。rg の `-e '' -- '--pre=./x.sh'` も同じ形。
// 決め: ガードが見る引数の並びと、プログラムが受け取る並びが違う引数は、PowerShell では止める。
// 下の表は、本物の Windows PowerShell 5.1（制限モード）で、引数をそのまま表示する node のスクリプトに渡して測った結果（received）。
// 「ガードの読み」（lexShell の語）と received が違う行は、すべて止める。同じ行は止めない。

const PS_UTF8 = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;';
const PS_CONSTRAINED = "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage';";
const psAvailable = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', 'echo ok'], { encoding: 'utf8' }).stdout.trim() === 'ok';

// [PowerShell で書いた引数, 本物の PowerShell 5.1 が node の process.argv.slice(2) に渡したもの]
const ARGV_TABLE: Array<readonly [string, readonly string[]]> = [
  // 空の引数は消える（1 つめが致命の再現）
  [String.raw`''`, []], [String.raw`""`, []], [String.raw`'a b' ''`, ['a b']], [String.raw`'' 'x'`, ['x']], [String.raw`'x' ''`, ['x']], [String.raw`"" ""`, []], [String.raw`'' --`, ['--']],
  // 二重引用符を含む引数は壊れる
  [String.raw`'a"b'`, ['ab']], [String.raw`'"'`, ['']], [String.raw`'a b"c d'`, ['a bc', 'd']], [String.raw`'a\"b'`, ['a"b']],
  // 空白を含み、バックスラッシュで終わる引数は、最後の " の前の \ になって引用符を壊す
  [String.raw`'a b\'`, ['a b"']], [String.raw`'C:\Program Files\'`, ['C:\\Program Files"']], [String.raw`'a b\\'`, ['a b\\']], [String.raw`'a b\' 'c'`, ['a b" c']],
  // カンマの並び: 空白や空の要素があると、別々の引数として渡る（きっちりつないだ a,b は 1 つの a,b）
  [String.raw`a, b`, ['a', 'b']], [String.raw`a ,b`, ['a', 'b']], [String.raw`a, b, c`, ['a', 'b', 'c']], [String.raw`'a b', 'c'`, ['a b', 'c']], [String.raw`'a', 'b'`, ['a', 'b']],
  [String.raw`'', 'x'`, ['x']], [String.raw`'',''`, []], [String.raw`x, ''`, ['x']],
  // -名前:値 は、1 つの引数 -名前:値 のまま渡る（PowerShell のコマンドレットなら -名前 と 値 の 2 つ）
  [String.raw`-x:y`, ['-x:y']], [String.raw`-n:5`, ['-n:5']], [String.raw`-a:'b c'`, ['-a:b c']], [String.raw`-a:''`, ['-a:']], [String.raw`-n: 5`, ['-n:', '5']], [String.raw`-e:foo -x`, ['-e:foo', '-x']],
  // 書いたとおりに渡るもの
  [String.raw`' '`, [' ']], [String.raw`'  a'`, ['  a']], [String.raw`'a b'`, ['a b']], [String.raw`'a\'`, ['a\\']], [String.raw`'a\\b'`, ['a\\\\b']], [String.raw`'\'`, ['\\']], [String.raw`'a\ b'`, ['a\\ b']],
  [String.raw`a,b`, ['a,b']], [String.raw`a,b,c`, ['a,b,c']], [String.raw`'a,b'`, ['a,b']], [String.raw`'1','2'`, ['1,2']], [String.raw`a,'b c'`, ['a,b c']], [String.raw`a,b c`, ['a,b', 'c']],
  [String.raw`'a;b'`, ['a;b']], [String.raw`'a|b'`, ['a|b']], [String.raw`'a&b'`, ['a&b']], [String.raw`'a<b'`, ['a<b']], [String.raw`'a^b'`, ['a^b']], [String.raw`'a%b'`, ['a%b']], [String.raw`'a!b'`, ['a!b']],
  [String.raw`0x10`, ['0x10']], [String.raw`1e3`, ['1e3']], [String.raw`1.0`, ['1.0']], [String.raw`1.50`, ['1.50']], [String.raw`1kb`, ['1kb']], [String.raw`010`, ['010']], [String.raw`+5`, ['+5']], [String.raw`-5`, ['-5']], [String.raw`1_000`, ['1_000']],
  [String.raw`--`, ['--']], [String.raw`-x=y`, ['-x=y']], [String.raw`--k=v`, ['--k=v']], [String.raw`--k=''`, ['--k=']], [String.raw`/c:''`, ['/c:']], [String.raw`/c:""`, ['/c:']], [String.raw`--k=""x`, ['--k=x']], [String.raw`/s`, ['/s']], [String.raw`/c:'x y'`, ['/c:x y']],
  [String.raw`~`, ['~']], [String.raw`~/x`, ['~/x']], [String.raw`*`, ['*']], [String.raw`?`, ['?']], [String.raw`[a]`, ['[a]']], [String.raw`*.txt`, ['*.txt']], [String.raw`'{a,b}'`, ['{a,b}']],
  [String.raw`'a''b'`, ["a'b"]], [String.raw`"it's"`, ["it's"]], [String.raw`a'b'`, ['ab']], [String.raw`'a'"b"`, ['a', 'b']], [String.raw`'-O./x.sh'`, ['-O./x.sh']], [String.raw`'--pre=./x.sh'`, ['--pre=./x.sh']],
  [String.raw`-ErrorAction Stop`, ['-ErrorAction', 'Stop']], [String.raw`-?`, ['-?']], [String.raw`1..3`, ['1..3']], [String.raw`\\server\share`, ['\\\\server\\share']], [String.raw`x:y`, ['x:y']],
  [String.raw`あ`, ['あ']], [String.raw`'a b あ'`, ['a b あ']],
];

const ctx = (): MatchCtx => ({ shell: 'powershell', windows: true, repo: noRepo, selfHosts: [] });
const guardView = (expr: string): string[] | undefined => {
  const lexed = lexShell(`rg -n zz -- ${expr}`, 'powershell');
  return lexed.ok && lexed.statements[0] ? lexed.statements[0].words.slice(4).map(w => w.text) : undefined;
};
const verdict = (command: string) => classifyStatements(command, ctx());
const hasWinArgs = (command: string): boolean => verdict(command).results.some(r => r.reasons.some(x => x.level === 'deny' && /^list\.winargs/u.test(x.key)));

test('PowerShell 5.1 が外部のプログラムに渡す引数の表: ガードの読みと違う行は止め、同じ行は止めない', () => {
  const wrong: string[] = [];
  for (const [expr, received] of ARGV_TABLE) {
    const view = guardView(expr);
    const command = `rg -n zz -- ${expr}`;
    const lexFail = view === undefined;
    const same = !lexFail && JSON.stringify(view) === JSON.stringify(received);
    const got = verdict(command);
    if (lexFail) { if (got.level !== 'deny') wrong.push(`${expr}: 読めない書き方が ${got.level}`); continue; }
    if (!same && !hasWinArgs(command)) wrong.push(`${expr}: ガードの読み ${JSON.stringify(view)} と受け取る ${JSON.stringify(received)} が違うのに止めない`);
    if (same && hasWinArgs(command)) wrong.push(`${expr}: 同じなのに止める`);
  }
  assert.deepEqual(wrong, []);
});

test('空の引数: git grep -e \'\' -- -O./x.sh と rg -e \'\' -- --pre=./x.sh は止める。普通の引数は止めない', () => {
  for (const c of [
    `git grep -e '' -- '-O./x.sh'`, `git grep -e "" -- '-O./x.sh'`, `rg -e '' -- '--pre=./x.sh'`, `rg -e "" -- '--pre=./x.sh' .`, `git grep -e x '' -- a.txt`, `rg '' a.txt`, `rg -n x ''`,
    `git log --grep '' -n 1`, `rg -e a "" b`,
  ]) {
    assert.equal(verdict(c).level, 'deny', c);
    assert.equal(hasWinArgs(c), true, c);
  }
  for (const c of [`git grep -e x -- a.txt`, `rg -e x -- a.txt`, `git log --format=%h,%s -n 1`, `rg -e 'a,b' a.txt`, `git log --oneline -n 1`, `rg --glob '*.ts' foo`, `findstr /c:'a b' a.txt`, `findstr /c:'' a.txt`, `rg -n --max-count=2 x a.txt`]) {
    assert.equal(hasWinArgs(c), false, c);
  }
});

test('値が空かもしれない変数（$e・$null）は、フラグの値の位置では今回だけ（捨てられると次の引数がずれるため）。-- のあとなら、これまでどおり', () => {
  for (const c of [`git grep -e $e -- '-O./x.sh'`, `rg -e $e -- '--pre=./x.sh'`, `git grep -e "$e" -- '-O./x.sh'`, `git grep -e $null -- '-O./x.sh'`, `rg $e -- '--pre=./x.sh'`]) assert.equal(verdict(c).level, 'once', c);
  assert.equal(verdict(`git grep -e x -- $d`).level, 'allow');
});

test('-名前:値 とカンマの並び: 外部のプログラムには別の形で渡るので止める。コマンドレットはこれまでどおり', () => {
  for (const c of [`rg -m:5 x a.txt`, `git log -n:5`, `rg -e:foo a.txt`, `git log -n: 5`, `rg -n x a, b`, `git log --oneline a, b`, `rg x a ,b`]) assert.equal(hasWinArgs(c), true, c);
  for (const c of [`Get-ChildItem -Path:sub`, `Get-Content -TotalCount:5 a.txt`, `Get-ChildItem sub, other`, `Select-String -Path a.txt, b.txt -Pattern x`]) assert.equal(hasWinArgs(c), false, c);
});

test('実機（Windows PowerShell 5.1・制限モード）: 表の received は本当にそう渡る', { skip: !psAvailable && 'Windows の PowerShell が無い' }, t => {
  const dir = tempDir(t);
  const printer = join(dir, 'argv.js');
  writeFileSync(printer, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const wrong: string[] = [];
  for (const [expr, received] of ARGV_TABLE) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${PS_UTF8}${PS_CONSTRAINED}node '${printer}' ${expr}`], { encoding: 'utf8' });
    let got: unknown;
    try { got = JSON.parse(r.stdout); } catch { got = `実行できない: ${r.stdout.slice(0, 60)} ${r.stderr.slice(0, 100)}`; }
    if (JSON.stringify(got) !== JSON.stringify(received)) wrong.push(`${expr}: 表 ${JSON.stringify(received)} ≠ 実測 ${JSON.stringify(got)}`);
  }
  assert.deepEqual(wrong, []);
});
