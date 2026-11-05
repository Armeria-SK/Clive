import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// 審査の追加の指摘: git のリポジトリの設定と curl・wget の設定ファイルを、最初の作業フォルダだけで調べていたので、
// `cd sub && git status` は sub の .git/config の core.fsmonitor を見落として「許す」になっていた。
// cd のあとのコマンドは、その時点でいられるすべてのフォルダ（最初と、cd で動いた先すべて）で調べる。cd の先が分からなければ今回だけ

function gitDir(dir: string, config: string): void {
  mkdirSync(join(dir, '.git', 'objects'), { recursive: true });
  mkdirSync(join(dir, '.git', 'refs'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, '.git', 'config'), config);
}

const PLAIN = '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n';
const EVIL = `${PLAIN}\tfsmonitor = /evil/hook.sh\n`;

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  for (const d of ['evil/deep', 'ok', 'plain', 'rc', 'hooky']) mkdirSync(join(ws, d), { recursive: true });
  gitDir(join(ws, 'evil'), EVIL);
  gitDir(join(ws, 'ok'), PLAIN);
  gitDir(join(ws, 'hooky'), PLAIN);
  mkdirSync(join(ws, 'hooky', '.git', 'hooks'));
  writeFileSync(join(ws, 'hooky', '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
  writeFileSync(join(ws, 'rc', '.curlrc'), 'output = "SOUL.md"\n');
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(base, 'appdata') };
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [] };
  const run = (command: string, shell: 'bash' | 'powershell' = 'bash') => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', env, gitIsolated: true });
  return { base, ws, run };
}

const once = (v: { onceOnly: boolean; decision: string }): boolean => v.onceOnly && v.decision === 'ask';
// 今回だけの確かめか、止める（どちらも確かめなしには動かない）。会話の許可で越えられる、ふつうの確かめは含まない
const blocked = (v: { onceOnly: boolean; decision: string }): boolean => v.decision === 'deny' || once(v);

test('cd のあとの git: 動いた先のリポジトリの設定にコードを動かせる項目があれば、今回だけ', t => {
  const f = fixture(t);
  const bash = [
    'cd evil && git status', 'cd evil; git log -p', 'pushd evil && git diff', 'cd ./evil && git status', 'cd evil && cd ../ok && git status', 'chdir evil; git status', '(cd evil && git status)',
    'cd evil || true; git status', 'cd evil && git -C . status', 'cd evil && ls && git status', 'cd evil/deep && git status', 'cd -P evil && git status', 'git -C evil status', 'cd "evil" && git status',
  ];
  const ps = [
    'cd evil; git status', 'Set-Location evil; git status', 'Push-Location evil; git status', 'sl evil; git status', 'Set-Location -Path evil; git status', 'Set-Location -LiteralPath evil; git status',
    'cd evil; git -C . status', 'pushd evil; git status', 'cd evil/deep; git log -p',
  ];
  const wrong = [
    ...bash.filter(c => !once(f.run(c, 'bash'))).map(c => `bash: ${c} → ${f.run(c, 'bash').decision}`),
    ...ps.filter(c => !once(f.run(c, 'powershell'))).map(c => `powershell: ${c} → ${f.run(c, 'powershell').decision}`),
  ];
  assert.deepEqual(wrong, []);
  assert.match(f.run('cd evil && git status').reasons.join(), /core\.fsmonitor/u);
});

test('cd の先が分からない（変数・ワイルドカード・cd -・~ユーザー・popd）と、そのあとの git は今回だけ', t => {
  const f = fixture(t);
  const bash = ['cd $d && git status', 'cd "$d" && git status', 'cd evil* && git status', 'cd - && git status', 'cd ~nobody && git status', 'cd && git status', 'popd && git status', 'cd $(pwd)/sub && git status', 'cd a b && git status', 'pushd && git status'];
  const ps = ['Set-Location $d; git status', 'cd -; git status', 'popd; git status', 'Pop-Location; git status', 'Set-Location evil*; git status', 'cd; git status', 'cd ~nobody; git status'];
  const wrong = [
    ...bash.filter(c => !blocked(f.run(c, 'bash'))).map(c => `bash: ${c} → ${f.run(c, 'bash').decision}`),
    ...ps.filter(c => !blocked(f.run(c, 'powershell'))).map(c => `powershell: ${c} → ${f.run(c, 'powershell').decision}`),
  ];
  assert.deepEqual(wrong, []);
  // 理由は「cd の先が分からず、リポジトリの設定を調べられない」（cwd）。ほかの理由で止まっているだけではない
  // bash の ~ユーザー は字句の読み取りで止まる（書き方を判定できない）ので、この理由は付かない
  const lacks = (c: string, shell: 'bash' | 'powershell'): boolean => { const v = f.run(c, shell); return !(v.decision === 'deny' && shell === 'bash' && c.includes('~nobody')) && !/（cwd）/u.test(v.reasons.join()); };
  const noReason = [...bash.filter(c => lacks(c, 'bash')), ...ps.filter(c => lacks(c, 'powershell'))];
  assert.deepEqual(noReason, []);
});

test('cd のあとの git でも、問題のない場所・cd より前の git は、これまでどおり許す', t => {
  const f = fixture(t);
  for (const c of ['git status', 'cd ok && git status', 'cd plain && git status', 'cd ok; git log --oneline', 'git status && cd evil', 'git status; cd evil; ls', 'cd evil && ls', 'cd ok && cd . && git status', 'cd . && git status']) {
    assert.equal(f.run(c, 'bash').decision, 'allow', c);
  }
  for (const c of ['git status', 'Set-Location ok; git status', 'cd plain; git status', 'git status; Set-Location evil', 'Set-Location evil; Get-ChildItem']) assert.equal(f.run(c, 'powershell').decision, 'allow', c);
});

test('cd のあとの git: -C の先も、動いた先から数える。フックのあるリポジトリは書く操作だけ今回だけ', t => {
  const f = fixture(t);
  assert.equal(once(f.run('cd ws2 && git -C evil status')), true, 'cd が失敗すれば最初のフォルダのままなので、最初のフォルダからの -C も数える');
  mkdirSync(join(f.ws, 'outer'), { recursive: true });
  gitDir(join(f.ws, 'outer', 'evil2'), EVIL);
  assert.equal(once(f.run('cd outer && git -C evil2 status')), true, 'cd の先から数えた -C');
  assert.equal(once(f.run('git -C evil2 status')), false, 'cd しなければ、ここには無い');
  assert.equal(f.run('cd hooky && git status').decision, 'allow');
  assert.equal(once(f.run('cd hooky && git commit -m x')), true, 'フックは書く操作だけ');
});

test('cd のあとの curl・wget: 動いた先の設定ファイルを数える。先が分からなければ今回だけ。-q・--no-config は付ければ許す', t => {
  const f = fixture(t);
  const curl = 'curl -sS https://example.com/';
  const wget = 'wget --max-redirect=0 https://example.com/';
  assert.equal(f.run(curl).decision, 'allow');
  for (const c of [`cd rc && ${curl}`, `cd rc; ${curl}`, `pushd rc && ${curl}`, `(cd rc && ${curl})`, `cd $d && ${curl}`, `cd - && ${curl}`, `cd $d && ${wget}`, `popd && ${wget}`]) assert.equal(once(f.run(c)), true, c);
  assert.equal(once(f.run('cd rc; curl.exe -sS https://example.com/', 'powershell')), true, 'PowerShell の curl.exe');
  assert.equal(once(f.run('Set-Location $d; curl.exe -sS https://example.com/', 'powershell')), true, 'PowerShell の先が分からない');
  for (const c of [`cd plain && ${curl}`, `cd ok && ${wget}`, `${curl} && cd rc`, `cd rc && curl -q -sS https://example.com/`]) {
    assert.equal(f.run(c).decision, 'allow', c);
  }
  // cd $d 自体は、読むパスが値の分からないふつうの確かめ。-q・--no-config があれば、curl・wget のための今回だけは付かない
  for (const c of ['cd $d && curl -q -sS https://example.com/', 'cd $d && wget --no-config --max-redirect=0 https://example.com/']) assert.equal(f.run(c).onceOnly, false, c);
  assert.match(f.run(`cd rc && ${curl}`).reasons.join(), /curl の設定ファイル/u);
  assert.match(f.run(`cd $d && ${curl}`).reasons.join(), /cd の先/u);
});

// 判定の流れを cd の追い方と共有しているので、cd で動いた先にだけある守る場所（スキルのフォルダ）への書き込みも、これまでどおり見つかる
test('cd で動いた先にだけある守る場所への相対パスの書き込みは、今回だけ', t => {
  const base = tempDir(t);
  const ws = realish(join(base, 'workspace'));
  mkdirSync(join(ws, 'skills'), { recursive: true });
  const policy: ScopePolicy = { roots: [{ path: ws, mode: 'write' }], deny: [], askOnWrite: [join(ws, 'skills')], skillsDir: join(ws, 'skills') };
  const run = (command: string, shell: 'bash' | 'powershell' = 'bash') => checkShellCommand(command, ws, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', gitIsolated: true });
  assert.equal(once(run('cd skills && echo x > a.md')), true);
  assert.equal(once(run('Set-Location skills; Set-Content a.md x', 'powershell')), true);
  assert.equal(run('cd . && echo x > a.md').decision, 'allow');
  assert.equal(run('echo x > a.md').decision, 'allow');
});
