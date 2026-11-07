import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { compileWildcard, expandGlob, segmentRegex } from '../src/tools/hooks/path-expand.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { PS_WRITER_ALLOW, tempDir } from './helpers.ts';

// 審査の指摘（深い審査）: PowerShell は、引用符で囲んだ -Path・-FilePath・位置で渡すパスのワイルドカード（* ? [ ]）も解決する（-LiteralPath だけが文字どおり）。
// ガードは引用符つきの語を文字どおりのパスとして調べていたので、`Set-Content -Path 'SOUL.*'` が人格を書き換えても、確かめなしで通った。
// 本物の PowerShell 5.1（制限モード）で確かめた挙動に合わせて、ワイルドカードを含む引用符つきのパスも、当たるものすべてを調べる

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  for (const d of ['skills/a', '.git', 'sub']) mkdirSync(join(ws, d), { recursive: true });
  for (const [f, text] of [['SOUL.md', 'persona'], ['USER.md', 'user'], ['.env', 'SECRET=1'], ['.git/description', 'desc'], ['skills/a/SKILL.md', 'skill'], ['sub/z.txt', 'z'], ['notes.md', 'n'], ['a.txt', 'a']] as const) writeFileSync(join(ws, f), text);
  writeFileSync(join(base, 'config.json'), '{}');
  writeFileSync(join(base, 'clive.db'), '');
  const policy: ScopePolicy = {
    roots: [{ path: ws, mode: 'write' }],
    deny: [realish(join(base, 'config.json')), realish(join(base, 'clive.db'))],
    askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md'), join(ws, 'skills')],
    skillsDir: join(ws, 'skills'),
  };
  const ps = (command: string) => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell: 'powershell', windows: true, allow: PS_WRITER_ALLOW });
  const bash = (command: string) => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell: 'bash', windows: false });
  return { base, ws, ps, bash };
}

const once = (v: { onceOnly: boolean; decision: string }): boolean => v.onceOnly && v.decision === 'ask';
// 消す書き方は、人格などの消せない対象に当たれば止める（deny）。今回だけの確かめより強い
const blocked = (v: { onceOnly: boolean; decision: string }): boolean => v.decision === 'deny' || once(v);

test('PowerShell: 引用符つきの -Path・-FilePath・位置のパスのワイルドカードで、人格・スキル・.git に書く／消すのは今回だけ', t => {
  const f = fixture(t);
  const rows = [
    "Set-Content -Path 'SOUL.*' -Value pwned1", "Set-Content 'US?R.md' pwned2", "Set-Content -Path 'skill[s]/a/SKILL.md' -Value x", "Out-File -FilePath 'SOUL.m?' -InputObject x",
    "Add-Content -Path '.gi[t]/description' -Value x -Force", "Set-Location 'skill[s]'; Set-Content a/SKILL.md x", "'x' > 'SOUL.*'", "'x' | Out-File 'SOUL.*'", "Tee-Object -FilePath 'SOUL.*' -InputObject x",
    "Remove-Item 'SOUL.*'", "Clear-Content 'SOUL.*'", "Move-Item -Path 'SOUL.*' -Destination sub", "Copy-Item sub/z.txt 'skills/a/SKILL.m[d]' -Force", "Add-Content 'SOUL.m?' more",
    "Set-Content -Path 'skills/*/SKILL.md' -Value star", "Set-Content 'skills\\*\\SKILL.md' x", "Rename-Item -Path 'SOUL.*' -NewName gone.md", 'Set-Content -Path "SOUL.*" -Value dq',
    "Set-Content -Path 'SO[U]L.md' -Value x", "Set-Content 'soul.M?' lower", "Set-Content '[^S]OUL.md' x", "Set-Content '[!S]OUL.md' x", "Set-Content '[A-T]OUL.md' x", "Set-Content '[a-t]oul.MD' x", "Move-Item sub/z.txt 'skills/a/S?ILL.md' -Force",
    // 位置・別名・cd した先
    "sc 'SOUL.*' x", "ac 'US?R.md' x", "del 'SOUL.*'", "ri 'USER.*'", "Set-Location 'sk*'; Set-Content a/SKILL.md x", "Push-Location 'skill[s]'; Set-Content a/SKILL.md x", "cd 'sk?lls'; Set-Content a/SKILL.md x",
  ];
  const wrong = rows.filter(c => !once(f.ps(c))).map(c => `${c} → ${f.ps(c).decision}${f.ps(c).onceOnly ? '/once' : ''}`);
  assert.deepEqual(wrong, []);
});

test('PowerShell: 引用符つきのワイルドカードが、禁止（秘密のパス・config.json・clive.db）に当たるなら止める', t => {
  const f = fixture(t);
  const rows = [
    "Get-Content '.en[v]'", "Get-Content -Path '.en?'", "Select-String -Path '.en[v]' -Pattern S", "Get-ChildItem -Path '.en[v]'", "Get-Content '..\\config.jso[n]'", "Get-Content '..\\clive.d[b]'",
    "Set-Content '..\\config.jso[n]' x", "Get-Content '..\\conf*.json'", "Get-Content '..\\*.db'", 'Get-Content ".en[v]"', "gc '.e*'", "Get-Content '.*'", "Copy-Item '.en[v]' sub/",
  ];
  const wrong = rows.filter(c => f.ps(c).decision !== 'deny').map(c => `${c} → ${f.ps(c).decision}`);
  assert.deepEqual(wrong, []);
});

test('PowerShell: -LiteralPath・ワイルドカードのない引用符つきのパス・当たるものが無いパスは、これまでどおり', t => {
  const f = fixture(t);
  for (const c of [
    "Set-Content -LiteralPath 'notes[1].md' -Value x", "Set-Content 'notes.md' x", "Get-Content 'a.txt'", "Get-ChildItem 'sub/*.txt'", "Get-ChildItem -Path 'sub/z.t[x]t'",
    "Select-String -Path 'sub/*.txt' -Pattern z", "Set-Content -Path 'notes*.md' -Value x", "Set-Content -Path 'no[ne]x*.md' -Value x", "Remove-Item 'sub/z.*'",
  ]) assert.equal(f.ps(c).decision, 'allow', c);
  // -LiteralPath は文字どおり（* ? はパスに使えない文字で、本物の PowerShell 5.1 はエラーにする）。ワイルドカードとしては展開しない
  assert.equal(f.ps("Set-Content -LiteralPath 'SOUL.m?' -Value x").decision, 'allow');
  assert.equal(f.ps("Get-Content -LiteralPath '.en[v]'").decision, 'allow');
  // -LiteralPath は文字どおり: 人格を指せば、これまでどおり今回だけ
  assert.equal(once(f.ps("Set-Content -LiteralPath 'SOUL.md' -Value x")), true);
  // New-Item・mkdir の -Path は、本物の PowerShell 5.1 でも作るパスとして文字どおりに扱う: スキルのフォルダの中に作るのは、これまでどおり今回だけ
  assert.equal(once(f.ps("New-Item -Path 'skills/a[1]' -ItemType Directory")), true);
  assert.equal(once(f.ps("mkdir 'skills/c[1]'")), true);
  assert.equal(f.ps("New-Item -Path 'sub/a[1]' -ItemType Directory").decision, 'allow');
  // bash は、引用符つきのワイルドカードを展開しない: 文字どおりの名前
  assert.equal(f.bash("echo x > 'SOUL.*'").decision, 'allow');
  assert.equal(f.bash("echo x > 'US?R.md'").decision, 'allow');
});

test('PowerShell: ワイルドカードのエスケープ（バッククォート）つきのパスと、cd の先がワイルドカードのときは、判定できないので止める／確かめる', t => {
  const f = fixture(t);
  for (const c of ["Get-Content 'SOUL.m`?'", "Set-Content 'SOUL`.md' x", "Set-Content -Path 'SO`[U`]L.md' -Value x"]) assert.notEqual(f.ps(c).decision, 'allow', c);
  // cd の先がワイルドカード: そのあとの git・相対パスの書き込みは、フォルダが分からないので今回だけ
  for (const c of ["Set-Location 'sk*'; git status", "cd 'skill[s]'; git status", "Set-Location 'sub'; git status"]) {
    assert.equal(c.includes('sub') ? f.ps(c).decision === 'allow' : once(f.ps(c)), true, c);
  }
});

test('本物の PowerShell 5.1（制限モード）: 引用符つきのワイルドカードで人格が書き換わる。ガードは、その書き方をすべて今回だけにする', { skip: process.platform !== 'win32' && 'Windows の PowerShell が無い' }, t => {
  if (spawnSync('powershell.exe', ['-NoProfile', '-Command', 'echo ok'], { encoding: 'utf8' }).stdout.trim() !== 'ok') { t.skip('powershell.exe が使えない'); return; }
  const f = fixture(t);
  const clm = "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage';";
  const soul = join(f.ws, 'SOUL.md');
  const attempts = ["Set-Content -Path 'SOUL.*' -Value pwned1", "Set-Content 'SOUL.m?' pwned2", "Set-Content -Path 'SO[U]L.md' -Value pwned3", "Add-Content 'SOUL.m[d]' pwned4", "Remove-Item 'SOUL.*'"];
  for (const command of attempts) {
    writeFileSync(soul, 'persona');
    // 本物を動かす前の状態で、ガードの判定を取る（本物が消したあとでは、当たるものが無い）
    const verdict = f.ps(command);
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', clm + command], { cwd: f.ws, encoding: 'utf8' });
    const changed = !existsSync(soul) || readFileSync(soul, 'utf8') !== 'persona';
    assert.equal(changed, true, `前提: 本物の PowerShell は、引用符つきのワイルドカードで SOUL.md を変える: ${command}`);
    assert.equal(blocked(verdict), true, `ガードが通した: ${command}`);
  }
});

test('expandGlob: PowerShell のワイルドカードは、[^S]・[!S] を否定にしない（S と ^ か ! のどれかに当たる。本物の PowerShell 5.1 で確かめた）。bash の [!S] は否定', t => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'SOUL.md'), 'p');
  writeFileSync(join(dir, 'TOUL.md'), 'p');
  const names = (pattern: string, ps: boolean): string[] => expandGlob(join(dir, pattern), ps).matches.map(m => m.slice(dir.length + 1)).sort();
  assert.deepEqual(names('[^S]OUL.md', true), ['SOUL.md']);
  assert.deepEqual(names('[!S]OUL.md', true), ['SOUL.md']);
  assert.deepEqual(names('[^T]OUL.md', true), ['TOUL.md']);
  assert.deepEqual(names('[!S]OUL.md', false), ['TOUL.md']);
  assert.deepEqual(names('[A-S]OUL.md', true), ['SOUL.md']);
  assert.deepEqual(names('SOUL.m?', true), ['SOUL.md']);
});

// 穴 6: ワイルドカードは、正規表現ではなく線形時間の照合（compileWildcard）で当てる。`*?*?…Z` のように * が並ぶと、古い正規表現（segmentRegex）は指数回バックトラックして固まる。
// 古い segmentRegex は答え合わせ用に残してあり、分かる形ではそれと同じ名前に当たること、分からない形（正規表現が例外を投げる形を含む）は null を返すことを確かめる

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

// ふつうの形: 組は [ab] [a-c] [!a] [^a] [a-] [-a] [😀-😁] だけ。これらだけの並びは、必ず分かる（null にならない）
const PLAIN = ['a', 'b', 'A', 'B', 'c', '.', '-', 'x', '_', 'K', 'ſ', 'ß', 'ẞ', '😀', '!', '^', ' ', '{', '}', '(', ')', '+', '$', '|', ',', '*', '*', '?', '?', '[ab]', '[a-c]', '[A-C]', '[!a]', '[^a]', '[!a-c]', '[a-]', '[-a]', '[😀-😁]'];
const ODD = ['[', ']', '[]a]', '[z-a]', '[a-c-e]', '[a-c-]', '[:alpha:]', '[[:alpha:]]', '[[a]', '[a\\b]', '[!]', '[^]', '[]', '\\', '/', '[a-a]', '[--a]', '[+--]', '[ab', '[!]a]'];
const NAME_CHARS = ['a', 'b', 'c', 'A', 'B', '.', '-', 'x', 'K', 'k', 'K', 'ſ', 's', 'S', 'ß', 'ẞ', '😀', '😁', '^', '!', '/', '\\', '[', ']', ' ', '_'];

test('compileWildcard: 古い segmentRegex と同じ名前に当たる（bash・PowerShell・大文字小文字・Unicode）。分からない形は null', () => {
  const r = rng(20261107);
  const wrong: string[] = [];
  let positives = 0, negatives = 0, unknown = 0;
  for (let i = 0; i < 4000; i++) {
    const tokens = Array.from({ length: 1 + Math.floor(r() * 6) }, () => pick(r, i % 2 === 1 ? [...PLAIN, ...ODD] : PLAIN));
    const pattern = tokens.join('');
    const plainOnly = tokens.every(t => PLAIN.includes(t));
    // 名前: 無作為なものと、パターンの * ? 組を文字に置き換えた「当たりそうな」もの
    const names: string[] = [];
    for (let k = 0; k < 10; k++) names.push(Array.from({ length: Math.floor(r() * 6) }, () => pick(r, NAME_CHARS)).join(''));
    for (let k = 0; k < 14; k++) {
      names.push(tokens.map(t => (t === '*' ? Array.from({ length: Math.floor(r() * 3) }, () => pick(r, NAME_CHARS)).join('') : t === '?' || (t.length > 1 && t.startsWith('[')) ? pick(r, NAME_CHARS) : r() < 0.3 ? t.toLowerCase() : t)).join(''));
    }
    for (const caseFold of [false, true]) for (const powershell of [false, true]) {
      const match = compileWildcard(pattern, caseFold, powershell);
      let old: RegExp | null = null;
      try { old = segmentRegex(pattern, caseFold, powershell); } catch { old = null; }
      if (match === null) {
        unknown++;
        if (plainOnly) wrong.push(`ふつうの形が null: ${JSON.stringify(pattern)}`);
        continue;
      }
      if (old === null) { wrong.push(`古い方が例外なのに null でない: ${JSON.stringify(pattern)}`); continue; }
      for (const name of names) {
        const want = old.test(name);
        if (want) positives++; else negatives++;
        if (match(name) !== want) wrong.push(`${JSON.stringify(pattern)} caseFold=${caseFold} powershell=${powershell} name=${JSON.stringify(name)} 古い=${want}`);
      }
    }
  }
  assert.deepEqual(wrong.slice(0, 20), []);
  // 空振りの試験でないこと: 当たる例・外れる例が十分にあり、分からない形も出ている
  assert.ok(positives > 5000 && negatives > 5000 && unknown > 500, `positives=${positives} negatives=${negatives} unknown=${unknown}`);
});

test('compileWildcard: 古い正規表現と同じに読む例（* は空も、先頭の . はそのまま、未閉じの [ は文字、[a-] は a と -、bash だけ ! ^ が否定、大文字小文字）', () => {
  const m = (pattern: string, name: string, caseFold = false, powershell = false): boolean => {
    const match = compileWildcard(pattern, caseFold, powershell);
    assert.notEqual(match, null, pattern);
    assert.equal(match!(name), segmentRegex(pattern, caseFold, powershell).test(name), `古い正規表現と違う: ${pattern} / ${name}`);
    return match!(name);
  };
  assert.deepEqual([m('*.ts', 'abc.ts'), m('*.ts', 'abc.js'), m('*.ts', '.ts')], [true, false, true]);
  assert.deepEqual([m('a?c', 'abc'), m('a?c', 'ac'), m('a?c', 'abbc')], [true, false, false]);
  assert.deepEqual([m('[ab]*', 'ax'), m('[ab]*', 'cx'), m('[ab]*', 'a')], [true, false, true]);
  assert.deepEqual([m('*', 'anything'), m('*', ''), m('**', ''), m('**', 'ab'), m('a**b', 'ab'), m('*a*', 'xax'), m('*a*', 'xxx')], [true, true, true, true, true, true, false]);
  assert.deepEqual([m('.*', '.env'), m('.*', 'env'), m('?', ''), m('?', '😀')], [true, false, false, true]);
  assert.deepEqual([m('[a-]', 'a'), m('[a-]', '-'), m('[a-]', 'b'), m('[a', '[a'), m('[a', 'a'), m('a[', 'a[')], [true, true, false, true, false, true]);
  assert.deepEqual([m('[!S]OUL', 'TOUL'), m('[!S]OUL', 'SOUL'), m('[^S]OUL', 'TOUL'), m('[!S]OUL', 'TOUL', false, true), m('[!S]OUL', '!OUL', false, true), m('[^S]OUL', '^OUL', false, true)], [true, false, true, false, true, true]);
  assert.deepEqual([m('*.TS', 'abc.ts', true), m('*.TS', 'abc.ts'), m('[A-C]x', 'bx', true), m('[A-C]x', 'bx'), m('k', 'K', true), m('k', 'K')], [true, false, true, false, true, false]);
  // 名前の中の / と \ には、* も ? も当たらない
  assert.deepEqual([m('a*', 'a/b'), m('a?b', 'a/b'), m('a*', 'a\\b')], [false, false, false]);
});

test('compileWildcard: 分からない形は null（空の組・先頭が ] の組・[ の入れ子・逆向きの範囲・[:alpha:]・組の中の \\・組の外の ]）。古い正規表現は、これらの多くで例外を投げる', () => {
  for (const pattern of ['[]', '[]a]', '[!]a]', '[[a]', '[[:alpha:]]', '[:alpha:]', '[z-a]', '[a\\b]', '[a-c-e]', '[--a]', 'a]', ']*', '*]']) {
    assert.equal(compileWildcard(pattern, false, false), null, `bash: ${pattern}`);
    assert.equal(compileWildcard(pattern, true, true), null, `powershell: ${pattern}`);
  }
  // bash の [!] [^] は、否定だけで中身が空（古い正規表現では「どんな 1 文字にも当たる」）。PowerShell では ! と ^ は文字なので、1 文字の組
  for (const pattern of ['[!]', '[^]']) assert.equal(compileWildcard(pattern, false, false), null, `bash: ${pattern}`);
  assert.notEqual(compileWildcard('[!]', false, true), null);
  assert.equal(compileWildcard('[^]', false, true)!('^'), true);
  assert.equal(compileWildcard('[^]', false, true)!('a'), false);
});

// 子プロセスで測る: 退行して指数回帰に戻っても、テスト全体が固まらずに、この試験だけが落ちる
function timedInChild(body: string, args: string[], limitMs = 8000): { ms: number; value: any } {
  const code = `const timed = f => { const t0 = performance.now(); const value = f(); return { ms: performance.now() - t0, value }; };\n${body}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, ...args], { encoding: 'utf8', timeout: limitMs });
  assert.equal(r.error, undefined, `${limitMs}ms で終わらなかった（指数回帰）: ${r.error?.message}`);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop()!);
}
const hooksUrl = (file: string): string => pathToFileURL(join(import.meta.dirname, '..', 'src', 'tools', 'hooks', file)).href;
const STARS = '*?*?*?*?*?*?*?*?*?*?Z';

test('compileWildcard: * が 10 個並ぶパターンを、200 文字の a に当てても 1 秒未満（古い正規表現は固まる）', () => {
  for (const [pattern, want] of [[STARS, false], ['*a*a*a*a*a*a*a*a*a*a*Z', false], ['*?*?*?*?*?*?*?*?*?*?', true], ['[ab]*[ab]*[ab]*[ab]*[ab]*[ab]*[ab]*[ab]*Z', false]] as const) {
    const { ms, value } = timedInChild(`const { compileWildcard } = await import(process.argv[1]); const match = compileWildcard(process.argv[2], true, true); console.log(JSON.stringify(timed(() => match('a'.repeat(200)))));`, [hooksUrl('path-expand.ts'), pattern]);
    assert.equal(value, want, pattern);
    assert.ok(ms < 1000, `${pattern}: ${ms}ms`);
  }
});
