import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// 再審査の指摘: 持ち主が「今回だけ」の確かめを許したあと、git が設定の core.hooksPath（.husky など）のフックを動かした。確かめの札はそのフックの中身を見せず、指紋にも入らない。
// 許したときにフックを動かせるのは、そのリポジトリ自身の .git/hooks だけ（そこへの書き込みは今回だけの確かめだった）。コマンドの git がその 1 つのリポジトリのものだと言えるときだけ、判定が置き場所を返す

const PLAIN = '[core]\n\trepositoryformatversion = 0\n\tbare = false\n[user]\n\tname = x\n\temail = x@example.com\n[remote "origin"]\n\turl = https://example.com/a.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  mkdirSync(ws, { recursive: true });
  const repo = (name: string, config = PLAIN, hook = true): string => {
    const dir = join(ws, name);
    const git = join(dir, '.git');
    mkdirSync(join(git, 'objects'), { recursive: true });
    mkdirSync(join(git, 'refs'));
    mkdirSync(join(git, 'hooks'));
    writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(git, 'config'), config);
    if (hook) writeFileSync(join(git, 'hooks', 'pre-commit'), '#!/bin/sh\n');
    return dir;
  };
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [], skillsDir: join(ws, 'skills') };
  const bash = (command: string, cwd = ws) => checkShellCommand(command, cwd, { policy, outsideRoots: 'ask', shell: 'bash', windows: false });
  return { ws, repo, bash };
}

test('フックの置き場所: コマンドの git が、設定に core.hooksPath の無い 1 つのリポジトリのものなら、そのリポジトリ自身の .git/hooks を返す', t => {
  const f = fixture(t);
  const a = f.repo('a');
  const v = f.bash('git commit -m x', a);
  assert.equal(v.onceOnly, true);
  assert.equal(v.ownHooksDir, join(a, '.git', 'hooks'));
  assert.equal(f.bash('git status; git -C . log --oneline', a).ownHooksDir, join(a, '.git', 'hooks'), '同じリポジトリを何度調べても同じ');
  assert.equal(f.bash('cd a && git commit -m x').ownHooksDir, join(a, '.git', 'hooks'), 'cd した先のリポジトリ');
});

test('フックの置き場所: 設定に core.hooksPath があれば返さない。札に、そのフックは動かないと書く', t => {
  const f = fixture(t);
  const husky = f.repo('h', `${PLAIN}[core]\n\thooksPath = .husky\n`);
  const v = f.bash('git commit -m x', husky);
  assert.equal(v.onceOnly, true);
  assert.equal(v.ownHooksDir, null);
  assert.match(v.reasons.join('\n'), /core\.hooksPath を設定していますが、そのフックは Clive の git では動きません/u);
  assert.doesNotMatch(v.reasons.join('\n'), /フックが動きうります/u);
});

test('フックの置き場所: git が無い・リポジトリが無い・複数のリポジトリ・cd の先が分からない・設定がふつうでないときは返さない', t => {
  const f = fixture(t);
  const a = f.repo('a');
  f.repo('b');
  assert.equal(f.bash('echo hello', a).ownHooksDir, null, 'git が無い');
  assert.equal(f.bash('git --version').ownHooksDir, null, 'リポジトリが無い');
  assert.equal(f.bash('cd a && git status && cd ../b && git status').ownHooksDir, null, '違う 2 つのリポジトリ');
  assert.equal(f.bash('git status; git -C ../b status', a).ownHooksDir, null, '-C で別のリポジトリ');
  assert.equal(f.bash('cd $x && git commit -m x', a).ownHooksDir, null, 'cd の先が分からない');
  assert.equal(f.bash('git status && cd $x && git commit -m y', a).ownHooksDir, null, '先に調べたリポジトリがあっても、あとで cd の先が分からなくなった');
  const odd = f.repo('odd', `${PLAIN}[alias]\n\tx = !sh\n`);
  assert.equal(f.bash('git commit -m x', odd).ownHooksDir, null, '設定がふつうでない');
});
