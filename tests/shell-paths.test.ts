import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { expandGlob, containsDotGit, protectedInside } from '../src/tools/hooks/path-expand.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellGuardOptions } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// security-self-api.md §11.4: 書き込み先の組み立て（cp・mv・Copy-Item・Rename-Item・New-Item・curl -O・wget）・ワイルドカードの列挙・守る場所の先祖への書き込み

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  const put = (rel: string, body = 'x') => { mkdirSync(join(ws, rel, '..'), { recursive: true }); writeFileSync(join(ws, rel), body); };
  put('SOUL.md'); put('USER.md'); put('notes.md'); put('skills/a/SKILL.md'); put('sub/a.txt'); put('.env', 'SECRET=1');
  put('tmp/SOUL.md'); put('tmp/x.txt'); put('tmp/nested/a.txt'); put('docs/readme.md');
  put('proj/.git/HEAD', 'ref: refs/heads/main\n'); put('proj/src/main.ts');
  const policy: ScopePolicy = {
    roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'SOUL.md'), join(ws, 'USER.md'), join(ws, 'skills')], skillsDir: join(ws, 'skills'),
  };
  const run = (command: string, shell: 'bash' | 'powershell', extra: Partial<ShellGuardOptions> = {}) =>
    checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', ...extra });
  return { base, ws, policy, bash: (c: string, e: Partial<ShellGuardOptions> = {}) => run(c, 'bash', e), ps: (c: string, e: Partial<ShellGuardOptions> = {}) => run(c, 'powershell', e) };
}

const once = (v: { decision: string; onceOnly: boolean }): boolean => v.decision === 'ask' && v.onceOnly;

test('cp・mv: 先がフォルダなら 先/元の名前 が書かれる。守る場所に当たれば今回だけ', t => {
  const f = fixture(t);
  for (const command of [
    'cp tmp/SOUL.md .', 'cp tmp/SOUL.md ./', 'mv tmp/SOUL.md .', 'cp -t . tmp/SOUL.md', 'cp tmp/x.txt tmp/SOUL.md .', 'cp tmp/x.txt SOUL.md', 'cp tmp/x.txt skills/', 'cp -r tmp skills', 'cp tmp/x.txt tmp/SOUL.md sub tmp/nested/a.txt skills',
    'mv sub skills/', 'mv tmp/x.txt USER.md', 'cp -r tmp/. .', 'cp -r tmp/. ./', 'cp -rT tmp .', 'cp -r tmp/* .', 'cp tmp/* .', 'mv tmp/* .', 'cp $f .', 'cp -r $d .',
  ]) {
    const v = f.bash(command);
    assert.equal(once(v), true, `${command}: ${v.decision} ${v.reasons.join(' / ')}`);
  }
  for (const command of [
    'cp tmp/x.txt .', 'cp -r tmp/nested .', 'cp tmp/x.txt sub/', 'cp -- *.md sub/', 'cp -r sub sub2', 'mv tmp/x.txt notes2.md', 'cp tmp/x.txt tmp/nested/a.txt docs', 'cp -r proj/src docs', 'cp -r sub proj', 'mv sub sub3',
    'cp notes.md docs/notes.md', 'cp -T tmp/x.txt docs/y.txt', 'cp -v -- tmp/x.txt .',
  ]) {
    const v = f.bash(command);
    assert.equal(v.decision, 'allow', `${command}: ${v.reasons.join(' / ')}`);
  }
});

test('Copy-Item・Move-Item・Rename-Item・New-Item: 同じ組み立て（PowerShell）', t => {
  const f = fixture(t);
  for (const command of [
    'Copy-Item tmp/SOUL.md -Destination .', 'Copy-Item tmp\\SOUL.md .\\', 'Copy-Item -Path tmp/SOUL.md -Destination .', 'Move-Item tmp/SOUL.md .', 'Copy-Item tmp/x.txt SOUL.md', 'Copy-Item tmp/x.txt skills',
    'Rename-Item notes.md -NewName SOUL.md', 'Rename-Item -Path notes.md -NewName USER.md', 'New-Item -Path . -Name SOUL.md', 'New-Item -Path skills -Name new -ItemType Directory', 'New-Item -Path . -Name $n',
    'Copy-Item tmp\\* .', 'Copy-Item tmp/* . -Recurse', 'Copy-Item -Recurse tmp/. .', 'Get-ChildItem tmp | Copy-Item -Destination .', 'Copy-Item $f .', 'Rename-Item notes.md -NewName $n', 'Set-Content -Path skills/a.md x', 'Remove-Item skills -Recurse',
  ]) {
    const v = f.ps(command);
    assert.equal(once(v), true, `${command}: ${v.decision} ${v.reasons.join(' / ')}`);
  }
  for (const command of [
    'Copy-Item tmp/x.txt .', 'Copy-Item tmp/x.txt -Destination docs', 'Copy-Item -Recurse tmp/nested .', 'Move-Item tmp/x.txt notes2.md', 'Rename-Item notes.md -NewName notes2.md', 'New-Item -Path docs -Name b.md',
    'New-Item -ItemType Directory out', 'Copy-Item *.md docs', 'Copy-Item tmp/x.txt docs/y.txt',
  ]) {
    const v = f.ps(command);
    assert.equal(v.decision, 'allow', `${command}: ${v.reasons.join(' / ')}`);
  }
});

test('ワイルドカード: 書く・消す側は当たるものを全部調べ、読む側も秘密のパスに当たれば止める', t => {
  const f = fixture(t);
  for (const command of ['rm *.md', 'rm -- *.md', 'rm -rf -- *', 'rm -rf -- s*', 'rm -rf -- pro*', 'rm -rf -- */', 'rm -f -- S*', 'rm -rf -- **/*.tmp', 'echo x > S*', 'mv -- *.md docs/', 'rm -r -- skills/*', 'rm -- skills/a/*']) {
    const v = f.bash(command);
    assert.equal(once(v), true, `${command}: ${v.decision} ${v.reasons.join(' / ')}`);
  }
  for (const command of ['rm -- *.txt', 'rm -rf -- sub*', 'rm -f -- tmp/*.txt', 'rm -- docs/*.md', 'rm -rf -- tmp/nested/*', 'rm -f -- ./*.log', 'rm -rf -- tmp/*', 'cat *.md', 'wc -l *.md', 'cat tmp/*', 'grep -r foo docs/*', 'ls *']) {
    const v = f.bash(command);
    assert.equal(v.decision, 'allow', `${command}: ${v.reasons.join(' / ')}`);
  }
  assert.equal(f.bash('cat .e*').decision, 'deny', '列挙した先が秘密のパス');
  assert.equal(f.bash('cat .*').decision, 'deny');
  assert.equal(f.bash('cat ?env').decision, 'allow', '.env に ? は当たらない（ドットを含まない）');
  assert.equal(f.bash('cat **/*.md').decision, 'ask', '列挙しきれないものは、手前のフォルダを調べて確かめる');
  assert.equal(f.bash('cat {notes,tmp/x}.md').decision, 'allow', '{a,b} を展開して調べる');
  assert.equal(f.bash('cat {notes,.env}*').decision, 'deny');
  for (const command of ['Remove-Item *', 'Remove-Item *.md', 'Remove-Item -Recurse -Force *', 'Remove-Item s*', 'Set-Content *.md x', 'Get-ChildItem *.md | Remove-Item', 'Remove-Item skills\\*']) {
    const v = f.ps(command);
    assert.equal(once(v) || v.decision === 'deny', true, `${command}: ${v.decision} ${v.reasons.join(' / ')}`);
  }
  for (const command of ['Remove-Item *.tmp', 'Remove-Item docs\\*.md', 'Get-ChildItem *.md', 'Get-Content *.md', 'Select-String foo *.md', 'Remove-Item tmp\\*.txt']) {
    const v = f.ps(command);
    assert.equal(v.decision, 'allow', `${command}: ${v.reasons.join(' / ')}`);
  }
  assert.equal(f.ps('Get-Content .e*').decision, 'deny');
});

test('curl -O・wget の既定の名前: URL の最後の名前で作業場所に書く', t => {
  const f = fixture(t);
  for (const command of [
    'curl -O https://example.com/SOUL.md', 'curl -sSLO https://example.com/USER.md', 'curl --remote-name https://example.com/SOUL.md', 'wget https://example.com/USER.md', 'wget -P . https://example.com/USER.md',
    'wget -P skills https://example.com/a.txt', 'curl -O --output-dir skills https://example.com/a.txt', 'curl -O https://example.com/%53OUL.md', 'curl -O https://example.com/SOUL.md?x=1',
  ]) {
    const v = f.bash(command);
    assert.equal(once(v), true, `${command}: ${v.decision} ${v.reasons.join(' / ')}`);
  }
  for (const command of ['curl -O https://example.com/notes.txt', 'curl -O --output-dir sub https://example.com/SOUL.md', 'wget -P sub https://example.com/USER.md', 'wget https://example.com/', 'wget -O out.txt https://example.com/SOUL.md', 'curl https://example.com/SOUL.md']) {
    const v = f.bash(command);
    assert.equal(v.decision, 'allow', `${command}: ${v.reasons.join(' / ')}`);
  }
});

test('.git を含むフォルダを丸ごと書く・動かす・消すのは今回だけ（フックが書かれる）', t => {
  const f = fixture(t);
  for (const command of ['cp -r proj docs', 'cp -r proj/. docs', 'mv proj docs', 'rm -rf proj', 'cp -r . docs2', 'cp -r proj/* docs', 'cp -a proj docs/']) {
    assert.equal(once(f.bash(command)), true, command);
  }
  assert.equal(f.bash('cp -r proj/src docs').decision, 'allow');
  assert.equal(f.bash('rm -rf proj/src').decision, 'allow');
});

test('path-expand: 列挙・.git の探索・守る場所の先祖', t => {
  const f = fixture(t);
  const names = (p: string, dot = false) => expandGlob(join(f.ws, p), dot).matches.map(m => m.slice(f.ws.length + 1)).sort();
  assert.deepEqual(names('*.md'), ['SOUL.md', 'USER.md', 'notes.md']);
  assert.deepEqual(names('*'), ['USER.md', 'SOUL.md', 'docs', 'notes.md', 'proj', 'skills', 'sub', 'tmp'].sort());
  assert.deepEqual(names('*', true).includes('.env'), true, 'PowerShell は先頭が . の名前にも当たる');
  assert.deepEqual(names('.e*'), ['.env']);
  assert.deepEqual(names('s?b'), ['sub']);
  assert.deepEqual(names('[SU]*.md'), ['SOUL.md', 'USER.md']);
  assert.deepEqual(names('[!SU]*.md'), ['notes.md']);
  assert.deepEqual(names('tmp/*/a.txt'), ['tmp\\nested\\a.txt'.replaceAll('\\', process.platform === 'win32' ? '\\' : '/')]);
  assert.deepEqual(names('{notes,docs/readme}.md'), ['docs\\readme.md'.replaceAll('\\', process.platform === 'win32' ? '\\' : '/'), 'notes.md']);
  assert.equal(expandGlob(join(f.ws, '**', '*.md'), false).complete, false);
  assert.equal(expandGlob(join(f.ws, '{1..3}.md'), false).complete, false);
  assert.equal(expandGlob(join(f.ws, 'nothing*'), false).complete, true);
  assert.equal(containsDotGit(join(f.ws, 'proj')), true);
  assert.equal(containsDotGit(join(f.ws, 'sub')), false);
  assert.equal(protectedInside(f.ws, f.policy), 'persona');
  assert.equal(protectedInside(join(f.ws, 'proj'), f.policy), 'git');
  assert.equal(protectedInside(join(f.ws, 'sub'), f.policy), undefined);
  assert.equal(protectedInside(join(f.ws, 'skills'), f.policy), 'skill');
  assert.equal(protectedInside(join(f.ws, 'docs'), f.policy), undefined);
});
