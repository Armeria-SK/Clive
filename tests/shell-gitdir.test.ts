import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { containsGitDir, protectedInside } from '../src/tools/hooks/path-expand.ts';
import { realish, writeApprovalKind, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// 再審査の指摘: .git でない名前の裏のリポジトリ（git init --bare up）の hooks/ や config への書き込みは、ただの許可フォルダの中の書き込みとして通った。
// 設定に remote としてその場所が書かれていれば、`git push up` がそのフックを動かす（ローカルの転送の子には、フックの上書きが届かない）。
// git のフォルダ（HEAD があり、objects/ と refs/ がある）の中への書き込みは、名前を問わず .git と同じ「今回だけ」にする

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  const bare = (dir: string): void => {
    for (const d of ['objects', 'refs/heads', 'hooks']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(dir, 'config'), '[core]\n\tbare = true\n');
  };
  bare(join(ws, 'up'));
  writeFileSync(join(ws, 'up', 'hooks', 'pre-receive.sample'), '#!/bin/sh\n');
  bare(join(ws, 'deep', 'nested', 'mirror.git'));
  bare(join(base, 'outside', 'up'));
  mkdirSync(join(ws, 'lonely'), { recursive: true });
  writeFileSync(join(ws, 'lonely', 'HEAD'), 'not a repository\n');
  mkdirSync(join(ws, 'plain'), { recursive: true });
  mkdirSync(join(ws, 'sub'), { recursive: true });
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [], skillsDir: join(ws, 'skills') };
  const ps = (command: string, cwd = ws) => checkShellCommand(command, cwd, { policy, outsideRoots: 'ask', shell: 'powershell', windows: true });
  const bash = (command: string, cwd = ws) => checkShellCommand(command, cwd, { policy, outsideRoots: 'ask', shell: 'bash', windows: false });
  return { base, ws, policy, ps, bash };
}

const once = (v: { onceOnly: boolean; decision: string }): boolean => v.onceOnly && v.decision === 'ask';
const show = (v: { onceOnly: boolean; decision: string }): string => `${v.decision}${v.onceOnly ? '/once' : ''}`;

test('git のフォルダ（HEAD・objects/・refs/）の中への書き込みは、.git でない名前でも git の書き込みとして今回だけ', t => {
  const f = fixture(t);
  assert.equal(writeApprovalKind(join(f.ws, 'up', 'hooks', 'pre-receive'), f.policy), 'git');
  assert.equal(writeApprovalKind(join(f.ws, 'up', 'config'), f.policy), 'git');
  assert.equal(writeApprovalKind(join(f.ws, 'deep', 'nested', 'mirror.git', 'refs', 'heads', 'main'), f.policy), 'git', '深い階層・refs の中');
  assert.equal(writeApprovalKind(join(f.ws, 'lonely', 'a.txt'), f.policy), undefined, 'HEAD だけのフォルダは git のフォルダではない');
  assert.equal(writeApprovalKind(join(f.ws, 'plain', 'a.txt'), f.policy), undefined);
  const ps = [
    'Set-Content up/hooks/pre-receive -Value x', 'Copy-Item evil.sh up/hooks/pre-receive', 'New-Item -Path up/hooks -Name pre-receive', 'Out-File up/hooks/post-update', 'Add-Content up/config -Value x',
    "'x' > up/hooks/update", 'Set-Content up/refs/heads/main x', 'Remove-Item up/hooks/pre-receive', 'Move-Item evil.sh up/hooks/', 'Copy-Item -Recurse sub up', 'Remove-Item up -Recurse', 'Set-Content deep/nested/mirror.git/hooks/pre-receive x',
    'Set-Location up; Set-Content hooks/pre-receive x', "Set-Content 'up/hooks/pre-rec*' x", 'Clear-Content up/config',
  ];
  const wrongPs = ps.filter(c => !once(f.ps(c))).map(c => `${c} → ${show(f.ps(c))}`);
  assert.deepEqual(wrongPs, []);
  const bash = ['echo x > up/hooks/pre-receive', 'cp evil.sh up/hooks/pre-receive', 'tee up/hooks/update', 'rm -rf up', 'mv evil.sh up/hooks/', 'cp -r sub up', 'echo x >> up/config', 'rm -r deep'];
  const wrongBash = bash.filter(c => !once(f.bash(c))).map(c => `${c} → ${show(f.bash(c))}`);
  assert.deepEqual(wrongBash, []);
});

test('git のフォルダでないものや、読むだけの操作は、これまでどおり', t => {
  const f = fixture(t);
  for (const c of ['Set-Content lonely/a.txt x', 'Set-Content plain/a.txt x', 'Get-Content up/config', 'Get-ChildItem up/hooks', 'Copy-Item up/config plain/copy', 'Set-Content sub/a x']) {
    assert.equal(f.ps(c).decision, 'allow', `${c}: ${show(f.ps(c))}`);
  }
  for (const c of ['echo x > plain/b.txt', 'cat up/config', 'cp up/config plain/c']) assert.equal(f.bash(c).decision, 'allow', `${c}: ${show(f.bash(c))}`);
});

test('許可フォルダの外にある git のフォルダへの書き込みも、ふつうの確かめでなく今回だけ', t => {
  const f = fixture(t);
  for (const c of ['Set-Content ../outside/up/hooks/pre-receive x', "'x' > ../outside/up/hooks/update"]) assert.equal(once(f.ps(c)), true, `${c}: ${show(f.ps(c))}`);
  assert.equal(once(f.bash('echo x > ../outside/up/hooks/pre-receive')), true);
  assert.equal(f.ps('Get-Content ../outside/up/config').decision, 'ask', '外を読むのはこれまでどおりふつうの確かめ');
});

test('フォルダごとの書き込み・消去が git のフォルダまで届くかも、名前を問わず調べる', t => {
  const f = fixture(t);
  assert.equal(containsGitDir(join(f.ws, 'deep')), true, '深い階層に裏のリポジトリがある');
  assert.equal(containsGitDir(join(f.ws, 'up')), true, 'そのフォルダ自身');
  assert.equal(containsGitDir(join(f.ws, 'plain')), false);
  assert.equal(containsGitDir(join(f.ws, 'lonely')), false);
  assert.equal(protectedInside(join(f.ws, 'deep'), f.policy), 'git');
  assert.equal(protectedInside(join(f.ws, 'plain'), f.policy), undefined);
});

test('remote の url が この PC のフォルダ・file:// なら、git push は今回だけ。cd した先・複数のフォルダを通っても取りこぼさない', t => {
  const f = fixture(t);
  const git = join(f.ws, 'hk', '.git');
  for (const d of ['objects', 'refs']) mkdirSync(join(git, d), { recursive: true });
  writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(git, 'config'), '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://example.com/a.git\n[remote "up"]\n\turl = ../up\n[remote "mirror"]\n\turl = file:///srv/mirror\n');
  const hk = join(f.ws, 'hk');
  for (const [c, cwd] of [['git push up', hk], ['git push mirror main', hk], ['git push', hk], ['cd hk && git push up', f.ws], ['git -C hk push up', f.ws]] as const) {
    assert.equal(once(f.bash(c, cwd)), true, `${c}: ${show(f.bash(c, cwd))}`);
    assert.match(f.bash(c, cwd).reasons.join('\n'), /この PC のフォルダ/u, c);
  }
  assert.equal(f.bash('git push origin main', hk).decision, 'ask');
  assert.equal(f.bash('git push origin main', hk).onceOnly, false, 'この PC の外の remote はふつうの確かめ');
});
