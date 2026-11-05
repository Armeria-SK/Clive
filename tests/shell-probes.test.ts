import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellGuardOptions } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// security-self-api.md §11.10: 1 回目・2 回目の審査で再現された抜けと、設計の途中で見つけた抜けの全部を、
// 本物のファイルがある作業フォルダで、道具の事前判定の直前（checkShellCommand）まで通して確かめる。どれも確かめなしには動かない

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  const put = (rel: string, body = 'x') => { mkdirSync(join(ws, rel, '..'), { recursive: true }); writeFileSync(join(ws, rel), body); };
  put('SOUL.md'); put('USER.md'); put('notes.md'); put('skills/a/SKILL.md'); put('a.tar'); put('a.zip'); put('f.txt');
  put('p.sh', '#!/bin/sh\ntouch pwned\n'); put('p.js', "require('fs').writeFileSync('pwned','x');\n"); put('p.mjs', "import fs from 'node:fs'; fs.writeFileSync('pwned','x');\n"); put('put.bat', '@echo pwned\n');
  put('tpl/hooks/pre-commit', '#!/bin/sh\ntouch pwned\n'); put('tmp/SOUL.md', 'evil persona'); put('tmp/x.txt');
  // git init --template=./tpl で作られたあとのリポジトリ（雛形のフックが入っている）
  put('sub/.git/HEAD', 'ref: refs/heads/main\n'); put('sub/.git/hooks/pre-commit', '#!/bin/sh\ntouch pwned\n'); mkdirSync(join(ws, 'sub', '.git', 'objects')); mkdirSync(join(ws, 'sub', '.git', 'refs'));
  put('sub/.git/config', '[core]\n\trepositoryformatversion = 0\n');
  // textconv を仕込んだ、.git という名前でないフォルダの裸のリポジトリ
  put('fake/HEAD', 'ref: refs/heads/main\n'); mkdirSync(join(ws, 'fake', 'objects')); mkdirSync(join(ws, 'fake', 'refs')); put('fake/config', '[diff "x"]\n\ttextconv = ./t.sh\n'); put('fake/info/attributes', '* diff=x\n');
  put('fsm/.git/HEAD', 'ref: refs/heads/main\n'); mkdirSync(join(ws, 'fsm', '.git', 'objects')); mkdirSync(join(ws, 'fsm', '.git', 'refs')); put('fsm/.git/config', '[core]\n\tfsmonitor = ./hook.sh\n');
  put('inc/.git/HEAD', 'ref: refs/heads/main\n'); mkdirSync(join(ws, 'inc', '.git', 'objects')); mkdirSync(join(ws, 'inc', '.git', 'refs')); put('inc/.git/config', '[include]\n\tpath = ../evil.cfg\n');
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md'), join(ws, 'skills')], skillsDir: join(ws, 'skills') };
  const run = (command: string, shell: 'bash' | 'powershell', extra: Partial<ShellGuardOptions> = {}) =>
    checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', ...extra });
  return { base, ws, policy, bash: (c: string, e: Partial<ShellGuardOptions> = {}) => run(c, 'bash', e), ps: (c: string, e: Partial<ShellGuardOptions> = {}) => run(c, 'powershell', e) };
}

const stopped = (v: { decision: string; onceOnly: boolean }): boolean => v.decision === 'deny' || (v.decision === 'ask' && v.onceOnly);

// 2 回目の審査の HIGH 5 種類（bash の形）
const HIGH_BASH = [
  // (1) その場のコードの別の書き方
  'node --eval=1', 'node --print=1', 'node -e 1', 'python -cprint(1)', 'python -c "print(1)"', 'perl -eprint', 'ruby -e1', 'node -r ./p.js -v', 'node --require=./p.js', 'node --import=./p.mjs', 'python3 -mhttp.server',
  // (2) 「読むだけ」に入れていたコマンドが別のプログラムを動かす
  'tar -I ./p.sh -cf a.tar x', 'tar --use-compress-program=./p.sh -cf a x', 'tar -xf a.tar --to-command=./p.sh', 'tar --checkpoint=1 --checkpoint-action=exec=./p.sh -cf a x', 'zip -T -TT ./p.sh a.zip x',
  'sort --compress-program=./p.sh f.txt', 'rg --pre ./p.sh x', 'bat --pager ./p.sh f.txt', 'sed -n 1ex f.txt', "awk 'BEGIN{system(\"x\")}'", 'LESSOPEN="|./p.sh %s" less f.txt',
  // (3) cmd /c が作業場所の put.bat を動かす
  'cmd /c put', 'forfiles /c "cmd /c put"',
  // (4) git のひな形・フック
  'git init --template=./tpl sub', 'git -C sub commit -m x', 'git clone --template=./tpl a b', 'git -C sub add .', 'git -C sub push', 'git -C fake log -p', 'git -C fsm status', 'git -C inc status',
  // (5) 書き込み先がフォルダのときに守るパスを見落とす
  'cp tmp/SOUL.md .', 'mv tmp/SOUL.md .', 'cp -r tmp/. .', 'tar -xf a.tar', 'unzip a.zip',
  // 設計の途中で見つけた抜け
  "git ls-remote --upload-pack='touch pwned' .", 'git log --output=SOUL.md',
  // MEDIUM・LOW
  'pip install .', 'pip install -e .', 'npm install', 'npm install ./pkg', 'echo x > .git/hooks/pre-commit', 'echo x > sub/.git/hooks/pre-commit', 'cp p.sh sub/.git/hooks/post-commit',
] as const;
const HIGH_PS = [
  'node --eval=1', 'python -cprint(1)', 'node -r ./p.js -v', 'node --import=./p.mjs', 'python3 -mhttp.server', 'cmd /c put', 'forfiles /c "cmd /c put"', 'tar -xf a.tar', 'tar.exe -I ./p.sh -cf a.tar x',
  'git init --template=./tpl sub', 'git -C sub commit -m x', 'git clone --template=./tpl a b', 'git -C fake log -p', 'git ls-remote --upload-pack=x .', 'git log --output=SOUL.md',
  'Copy-Item tmp/SOUL.md -Destination .', 'Copy-Item tmp/SOUL.md', 'Move-Item tmp/SOUL.md', 'copy tmp/SOUL.md', 'Copy-Item tmp\\SOUL.md .\\', 'Move-Item tmp/SOUL.md .', 'Get-ChildItem *.md | Remove-Item', 'Get-ChildItem tmp | Copy-Item -Destination .', 'Expand-Archive a.zip out',
  'pip install .', 'pip install -e .', 'npm install', 'npm install ./pkg', 'Set-Content .git/hooks/pre-commit x', 'Set-Content sub/.git/hooks/pre-commit x',
] as const;
// 止める書き方
// 審査で見つかった: 本物の PowerShell は CR 1 つを文の区切りに、U+0085・U+2028 を語の区切りに読む。ガードは止める
const SEPARATOR_PS = ['Write-Output a\rnode p.js', 'Set-Content README.md\rx', 'Set-Content README.md\u0085x', 'Set-Content README.md\u2028x', 'Set-Content README.md\u2029x'];
const BLOCKED_PS = ["``n`o`de --eval=1", 'ls --% x', 'Write-Output ‘x’', 'Get-ChildItem –Path x', 'Write-Output "$(ls)"'];

test('審査で再現された抜けは、どれも確かめなしには動かない（本物のファイルがある作業フォルダで）', t => {
  const f = fixture(t);
  const wrong: string[] = [];
  for (const command of HIGH_BASH) { const v = f.bash(command); if (!stopped(v)) wrong.push(`bash: ${command} → ${v.decision}${v.onceOnly ? '/once' : ''}`); }
  for (const command of HIGH_PS) { const v = f.ps(command); if (!stopped(v)) wrong.push(`powershell: ${command} → ${v.decision}${v.onceOnly ? '/once' : ''}`); }
  for (const command of SEPARATOR_PS) { const v = f.ps(command); if (v.decision !== 'deny') wrong.push(`powershell: ${JSON.stringify(command)} → ${v.decision}（止めるはず）`); const b = f.bash(command); if (b.decision !== 'deny') wrong.push(`bash: ${JSON.stringify(command)} → ${b.decision}`); }
  for (const command of BLOCKED_PS) { const v = f.ps(command); if (v.decision !== 'deny') wrong.push(`powershell: ${command} → ${v.decision}（止めるはず）`); }
  assert.deepEqual(wrong, []);
});

test('フックが動く git の書く操作は今回だけ。ふつうの git の書く操作は会話の許可で越えられるふつうの確かめ', t => {
  const f = fixture(t);
  mkdirSync(join(f.ws, 'clean', '.git', 'objects'), { recursive: true });
  mkdirSync(join(f.ws, 'clean', '.git', 'refs'));
  writeFileSync(join(f.ws, 'clean', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(f.ws, 'clean', '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  const hooked = f.bash('git -C sub commit -m x');
  assert.equal(hooked.onceOnly, true);
  assert.match(hooked.reasons.join(), /フックが動きうります/u);
  const clean = f.bash('git -C clean commit -m x');
  assert.equal(clean.decision, 'ask');
  assert.equal(clean.onceOnly, false);
  assert.equal(f.bash('git -C clean status').decision, 'allow');
  assert.equal(f.bash('git -C sub log --oneline').decision, 'allow', '読むサブコマンドではフックは動かない');
  assert.equal(f.bash('git -C fake log -p').onceOnly, true);
  assert.match(f.bash('git -C fake log -p').reasons.join(), /diff\.x\.textconv/u);
  assert.match(f.bash('git -C fsm status').reasons.join(), /core\.fsmonitor/u);
});
