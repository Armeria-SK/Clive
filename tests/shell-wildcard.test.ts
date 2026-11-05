import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { expandGlob } from '../src/tools/hooks/path-expand.ts';
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
