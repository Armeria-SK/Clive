import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { findGitDir, inspectRepo, parseGitConfig, unusualKey } from '../src/tools/hooks/git-repo.ts';
import { tempDir } from './helpers.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;

// git init の形（HEAD・objects・refs）を手で作る
function makeGitDir(dir: string, config: string): string {
  mkdirSync(join(dir, 'objects'), { recursive: true });
  mkdirSync(join(dir, 'refs'), { recursive: true });
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, 'config'), config);
  return dir;
}
const PLAIN = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n[user]\n\tname = x\n\temail = x@example.com\n[remote "origin"]\n\turl = https://example.com/a.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n';

function repoWith(t: { after: (fn: () => void) => void }, config: string): string {
  const root = tempDir(t);
  makeGitDir(join(root, '.git'), config);
  return root;
}

test('ふつうの設定のリポジトリは「ふつう」と読む', t => {
  const info = inspectRepo(repoWith(t, PLAIN));
  assert.deepEqual(info, { found: true, configOk: true, badKey: '', unreadable: false, hooksPath: false, hooksFiles: false });
});

test('コードを動かせる項目がひとつでもあれば、ふつうでないと読む（項目の名前を返す）', t => {
  const bad: Array<[string, string]> = [
    ['[core]\n\tfsmonitor = ./hook.sh\n', 'core.fsmonitor'], ['[core]\n\tpager = x\n', 'core.pager'], ['[core]\n\tsshCommand = x\n', 'core.sshcommand'], ['[core]\n\teditor = x\n', 'core.editor'],
    ['[diff "x"]\n\ttextconv = ./t.sh\n', 'diff.x.textconv'], ['[diff]\n\texternal = ./t.sh\n', 'diff.external'], ['[filter "lfs"]\n\tclean = x\n', 'filter.lfs.clean'], ['[alias]\n\tco = !sh\n', 'alias.co'],
    ['[pager]\n\tlog = x\n', 'pager.log'], ['[gpg]\n\tprogram = x\n', 'gpg.program'], ['[credential]\n\thelper = !x\n', 'credential.helper'], ['[include]\n\tpath = ../x\n', 'include.path'],
    ['[includeIf "gitdir:/x"]\n\tpath = ../x\n', 'includeif.gitdir:/x.path'], ['[remote "o"]\n\turl = x\n\tuploadpack = ./x\n', 'remote.o.uploadpack'], ['[url "x"]\n\tinsteadOf = y\n', 'url.x.insteadof'],
    ['[core]\n\tFSMonitor = x\n', 'core.fsmonitor'], ['[CORE]\n\tFsMonitor = x\n', 'core.fsmonitor'], ['[sequence]\n\teditor = x\n', 'sequence.editor'], ['[merge "x"]\n\tdriver = ./d\n', 'merge.x.driver'],
    ['[remote "o"]\n\turl = ext::sh -c x\n', 'remote.o.url = ext::sh -c x'], ['[remote "o"]\n\tpushurl = fd::3\n', 'remote.o.pushurl = fd::3'], ['[user]\n\tsigningkey = x\n', 'user.signingkey'],
    ['[core]\n\tbare\n\tfsmonitor\n', 'core.fsmonitor'], ['[submodule "m"]\n\tupdate = !x\n', 'submodule.m.update'], ['[difftool "x"]\n\tcmd = x\n', 'difftool.x.cmd'], ['[http]\n\tproxy = x\n', 'http.proxy'],
  ];
  const wrong: string[] = [];
  for (const [config, key] of bad) {
    const info = inspectRepo(repoWith(t, PLAIN + config));
    if (info.configOk || !info.badKey.startsWith(key.split(' = ')[0]!)) wrong.push(`${config.trim()} → ${JSON.stringify(info)}`);
  }
  assert.deepEqual(wrong, []);
});

test('ふつうの項目（git が使う設定のうち、コードを動かさないもの）は、まとめて通す', t => {
  const config = `${PLAIN}[core]\n\thooksPath = .husky\n\tautocrlf = input\n\tlongpaths = true\n[extensions]\n\tworktreeConfig = true\n[color]\n\tui = auto\n[color "diff"]\n\tmeta = bold\n[gc]\n\tauto = 0\n[log]\n\tdate = iso\n[status]\n\tshowUntrackedFiles = all\n[advice]\n\tdetachedHead = false\n[init]\n\tdefaultBranch = main\n[pull]\n\trebase = false\n[push]\n\tdefault = simple\n\tautoSetupRemote = true\n[fetch]\n\tprune = true\n[submodule "m"]\n\turl = https://e/m.git\n\tactive = true\n[lfs]\n\trepositoryformatversion = 0\n[remote "o"]\n\turl = git@github.com:a/b.git\n\tpushurl = ssh://h/b.git\n\ttagopt = --no-tags\n\tprune = true\n[branch "feature/a.b"]\n\tremote = o\n\trebase = true\n\tpushremote = o\n`;
  const info = inspectRepo(repoWith(t, config));
  assert.equal(info.configOk, true, info.badKey);
  assert.equal(info.hooksPath, true);
});

test('読めない・壊れた設定は「読めない」', t => {
  for (const config of ['[core\n\tbare = false\n', 'bare = false\n', '[core]\n\t= x\n', '[core]\n\tbare = "unclosed\n', '[core]\n\tbare = \\q\n']) {
    assert.equal(inspectRepo(repoWith(t, config)).unreadable, true, JSON.stringify(config));
  }
  const root = tempDir(t);
  makeGitDir(join(root, '.git'), PLAIN);
  mkdirSync(join(root, '.git', 'config.worktree'));
  assert.equal(inspectRepo(root).unreadable, true);
  const big = repoWith(t, `${PLAIN}# ${'x'.repeat(1_100_000)}\n`);
  assert.equal(inspectRepo(big).unreadable, true);
});

test('設定の書式: コメント・引用符・行の継続・大文字小文字・同じ行の定義', () => {
  const entries = parseGitConfig('# c\n; c\n[Core] # c\n  FileMode = "true" ; c\n[remote "Or.igin"]\nurl = a \\\n  b\n\tpushurl = "x # y" # z\n[Branch "A"]\nbare\n[core]  bare = false\n')!;
  assert.deepEqual(entries.map(e => [e.key, e.value]), [
    ['core.filemode', 'true'], ['remote.Or.igin.url', 'a   b'], ['remote.Or.igin.pushurl', 'x # y'], ['Branch.A.bare', ''], ['core.bare', 'false'],
  ].map(([k, v]) => [k!.replace('Branch.A', 'branch.A'), v]));
  assert.equal(parseGitConfig('[old.sub]\nkey = 1\n')![0]!.key, 'old.sub.key');
  assert.equal(unusualKey(parseGitConfig('[core]\n\tbare = false\n')!), null);
  assert.equal(parseGitConfig('\uFEFF[core]\nbare = true\n')![0]!.key, 'core.bare');
});

test('リポジトリの見つけ方: 上へたどる・.git でない名前の裸のリポジトリ・壊れた .git は上へ・gitdir ファイル', t => {
  const root = repoWith(t, PLAIN);
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  assert.equal(inspectRepo(join(root, 'a', 'b')).configOk, true);
  assert.equal(findGitDir(join(root, 'a', 'b'))?.gitDir, join(root, '.git'));

  // 上のリポジトリがふつうでなく、間に空の .git フォルダがあっても、git は上のリポジトリを使う
  const outer = repoWith(t, `${PLAIN}[core]\n\tfsmonitor = x\n`);
  mkdirSync(join(outer, 'inner', '.git'), { recursive: true });
  assert.equal(inspectRepo(join(outer, 'inner')).configOk, false);

  // .git という名前でないフォルダの裸のリポジトリ
  const plain = tempDir(t);
  makeGitDir(join(plain, 'fake'), `${PLAIN}[diff "x"]\n\ttextconv = ./t.sh\n`);
  const fake = inspectRepo(join(plain, 'fake'));
  assert.equal(fake.found, true);
  assert.equal(fake.configOk, false);
  assert.equal(fake.badKey, 'diff.x.textconv');

  // worktree: .git が gitdir: を書いたファイルで、設定は共通のフォルダにある
  const wt = tempDir(t);
  const common = makeGitDir(join(wt, 'main', '.git'), `${PLAIN}[core]\n\tfsmonitor = x\n`);
  const wtDir = join(common, 'worktrees', 'w');
  makeGitDir(wtDir, '');
  writeFileSync(join(wtDir, 'commondir'), '../..\n');
  mkdirSync(join(wt, 'w'), { recursive: true });
  writeFileSync(join(wt, 'w', '.git'), `gitdir: ${wtDir}\n`);
  const viaFile = inspectRepo(join(wt, 'w'));
  assert.equal(viaFile.configOk, false);
  assert.equal(viaFile.badKey, 'core.fsmonitor');
  writeFileSync(join(wt, 'w', '.git'), 'gitdir: ../nowhere\n');
  assert.equal(inspectRepo(join(wt, 'w')).unreadable, true);

  // config.worktree も読む
  const cw = repoWith(t, PLAIN);
  writeFileSync(join(cw, '.git', 'config.worktree'), '[core]\n\tfsmonitor = x\n');
  assert.equal(inspectRepo(cw).configOk, false);

  assert.equal(inspectRepo(tempDir(t)).found, false);
});

test('フック: core.hooksPath と、hooks/ の .sample 以外のファイル', t => {
  const root = repoWith(t, PLAIN);
  mkdirSync(join(root, '.git', 'hooks'));
  writeFileSync(join(root, '.git', 'hooks', 'pre-commit.sample'), '#!/bin/sh\n');
  assert.deepEqual([inspectRepo(root).hooksFiles, inspectRepo(root).hooksPath], [false, false]);
  writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
  assert.equal(inspectRepo(root).hooksFiles, true);
  assert.equal(inspectRepo(root).configOk, true);
  const hp = repoWith(t, `${PLAIN}[core]\n\thooksPath = ../h\n`);
  assert.deepEqual([inspectRepo(hp).hooksPath, inspectRepo(hp).configOk], [true, true]);
  const wt = tempDir(t);
  const common = makeGitDir(join(wt, 'main', '.git'), PLAIN);
  mkdirSync(join(common, 'hooks'));
  writeFileSync(join(common, 'hooks', 'post-commit'), 'x');
  const wtDir = join(common, 'worktrees', 'w');
  makeGitDir(wtDir, '');
  writeFileSync(join(wtDir, 'commondir'), '../..\n');
  mkdirSync(join(wt, 'w'));
  writeFileSync(join(wt, 'w', '.git'), `gitdir: ${wtDir}\n`);
  assert.equal(inspectRepo(join(wt, 'w')).hooksFiles, true);
});

// 本物の git との突き合わせ: 本物の git が「設定の項目」として数える名前と、このパーサーの名前が同じ
test('本物の git が読む項目の名前と、パーサーの名前が同じ', { skip: !gitAvailable && 'git が無い' }, t => {
  const root = tempDir(t);
  execFileSync('git', ['init', '-q', root]);
  const configs = [
    '[Core]\n\tFileMode = true\n[remote "Or.igin"]\n\turl = a \\\n  b\n\tpushurl = "x # y" # z\n[branch "A"]\n\tbare\n[core]  bare = false\n',
    '[core]\n\tfsmonitor = ./x\n[diff "t"]\n\ttextconv = ./t\n[includeIf "gitdir:/x/"]\n\tpath = ../y\n[ALIAS]\n\tCo = !sh\n',
    '[user]\n\tname = "a b"\n\temail = a@b # c\n[extensions]\n\tworktreeConfig = true\n[color "diff"]\n\tmeta = bold\n',
  ];
  for (const config of configs) {
    writeFileSync(join(root, '.git', 'config'), config);
    const out = execFileSync('git', ['-C', root, 'config', '--local', '--list', '--name-only'], { encoding: 'utf8' });
    const real = out.split('\n').filter(Boolean);
    const mine = parseGitConfig(config)!.map(e => e.key);
    assert.deepEqual(mine, real, config);
  }
  writeFileSync(join(root, '.git', 'config'), '[core]\n\tfsmonitor = ./x\n');
  assert.equal(inspectRepo(root).configOk, false);
  assert.equal(findGitDir(join(root, 'sub'))?.gitDir, join(root, '.git'));
});
