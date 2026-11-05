import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(info, { found: true, configOk: true, badKey: '', unreadable: false, hooksPath: false, hooksFiles: false, remotes: ['origin'] });
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

// 審査で見つかった: git の is_git_directory は commondir を辿って objects/ と refs/ を探す。HEAD と commondir だけのフォルダも git のフォルダ
test('commondir: HEAD と commondir だけのフォルダも git のフォルダ。commondir の先の設定を読む（core.worktree も「ふつうでない」）', t => {
  const root = tempDir(t);
  makeGitDir(join(root, 'c'), `${PLAIN}[diff "x"]\n\ttextconv = ./t.sh\n`);
  mkdirSync(join(root, 'x'));
  writeFileSync(join(root, 'x', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, 'x', 'commondir'), '../c\n');
  const via = inspectRepo(join(root, 'x'));
  assert.equal(via.found, true, 'objects と refs が commondir の先にあるフォルダを見つける');
  assert.equal(via.configOk, false);
  assert.equal(via.badKey, 'diff.x.textconv');
  assert.equal(findGitDir(join(root, 'x'))?.gitDir, join(root, 'x'));
  // 絶対パスの commondir
  writeFileSync(join(root, 'x', 'commondir'), `${join(root, 'c')}\n`);
  assert.equal(inspectRepo(join(root, 'x')).badKey, 'diff.x.textconv');
  // 上のリポジトリがふつうでも、commondir のフォルダのほうを使う（git と同じ順: その階層自身が先）
  const outer = repoWith(t, PLAIN);
  mkdirSync(join(outer, 'x'));
  writeFileSync(join(outer, 'x', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(outer, 'x', 'commondir'), `${join(root, 'c')}\n`);
  assert.equal(inspectRepo(join(outer, 'x')).configOk, false);

  // core.worktree は作業フォルダを別の場所に向ける。ふつうの項目に入れない
  assert.equal(inspectRepo(repoWith(t, `${PLAIN}[core]\n\tworktree = ../elsewhere\n`)).badKey, 'core.worktree');
});

test('commondir・gitdir: 読めない・先が無い・大きすぎるものは「読めない」（今回だけ）', t => {
  const root = tempDir(t);
  makeGitDir(join(root, 'c'), PLAIN);
  const bad: Array<[string, string]> = [['dangling commondir', '../nowhere\n'], ['empty commondir', '\n'], ['commondir without objects', '../c/hooks\n']];
  for (const [label, body] of bad) {
    const dir = join(root, label.replaceAll(' ', '-'));
    mkdirSync(dir);
    writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(dir, 'commondir'), body);
    const info = inspectRepo(dir);
    assert.equal(info.unreadable, true, label);
  }
  // commondir がフォルダ（読めない）
  const asDir = join(root, 'commondir-is-dir');
  mkdirSync(join(asDir, 'commondir'), { recursive: true });
  writeFileSync(join(asDir, 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(inspectRepo(asDir).unreadable, true);
  // 大きすぎる
  const big = join(root, 'big');
  mkdirSync(big);
  writeFileSync(join(big, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(big, 'commondir'), `../c\n${'x'.repeat(10_000)}`);
  assert.equal(inspectRepo(big).unreadable, true);
  // gitdir（worktree の管理フォルダの中にある、作業フォルダの .git を指すファイル）が読めない
  const admin = join(root, 'admin');
  makeGitDir(admin, '');
  writeFileSync(join(admin, 'commondir'), '../c\n');
  mkdirSync(join(admin, 'gitdir'));
  assert.equal(inspectRepo(admin).unreadable, true);
  writeFileSync(join(root, 'ok-admin-gitdir'), 'x');
});

// 本物の git との突き合わせ: HEAD と commondir だけのフォルダで git log -p を動かすと、commondir の先の textconv が本当に動く
test('本物の git: commondir だけのフォルダは git のフォルダで、その設定のコードが動く。ガードはそのフォルダを見つける', { skip: !gitAvailable && 'git が無い' }, t => {
  const root = tempDir(t);
  const git = (args: string[], cwd = root) => spawnSync('git', args, { encoding: 'utf8', cwd });
  mkdirSync(join(root, 'wt'));
  mkdirSync(join(root, 'x'));
  git(['init', '--bare', '-q', 'c']);
  writeFileSync(join(root, 'wt', 'a.txt'), 'hello\n');
  git(['--git-dir=c', '--work-tree=wt', 'add', 'a.txt']);
  git(['--git-dir=c', '--work-tree=wt', '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'one']);
  const marker = join(root, 'marker');
  const hook = join(root, 'hook.sh');
  writeFileSync(hook, `#!/bin/sh\necho ran > "${marker.replaceAll('\\', '/')}"\ncat "$1"\n`, { mode: 0o755 });
  appendFileSync(join(root, 'c', 'config'), `[diff "x"]\n\ttextconv = ${hook.replaceAll('\\', '/')}\n`);
  mkdirSync(join(root, 'c', 'info'), { recursive: true });
  writeFileSync(join(root, 'c', 'info', 'attributes'), '* diff=x\n');
  writeFileSync(join(root, 'x', 'HEAD'), `ref: ${git(['--git-dir=c', 'symbolic-ref', 'HEAD']).stdout.trim()}\n`);
  writeFileSync(join(root, 'x', 'commondir'), '../c\n');
  assert.equal(git(['-C', 'x', 'rev-parse', '--git-dir']).stdout.trim(), '.', '本物の git は x を git のフォルダとして読む');
  const info = inspectRepo(join(root, 'x'));
  assert.equal(info.found, true);
  assert.equal(info.configOk, false);
  assert.equal(info.badKey, 'diff.x.textconv');
  git(['-C', 'x', 'log', '-p', '--oneline']);
  assert.equal(existsSync(marker), true, '前提: 本物の git は textconv のコードを動かす（ガードが見つけないと、許す になってしまう形）');
});

// 審査で見つかった: git の validate_headref は HEAD の中身も見る（`ref:` のあとの refs/、先頭の 40 桁以上の 16 進数、refs/ へのシンボリックリンク）。
// HEAD があるだけで git のフォルダとしていたので、HEAD が不正なおとりのフォルダ a/b でガードは止まり、git は b を飛ばして上の裏のリポジトリ a を使った（a の設定の textconv が `git log -p` で動く）
const HEADS: Array<[string, string]> = [
  ['ふつう', 'ref: refs/heads/main\n'], ['改行なし', 'ref: refs/heads/main'], ['ref: と refs/ の間が空白なし', 'ref:refs/heads/x'], ['タブ', 'ref:\trefs/heads/x'], ['refs/ だけ', 'ref: refs/'],
  ['40 桁', 'a'.repeat(40)], ['40 桁のあとにごみ', `${'b'.repeat(40)} trailing`], ['64 桁', 'c'.repeat(64)], ['大文字の 40 桁', 'A'.repeat(40)],
  ['ごみ', 'x'], ['空', ''], ['refs/ でない', 'ref: heads/main'], ['39 桁', 'a'.repeat(39)], ['先頭に空白', ' ref: refs/heads/x'], ['refs の後ろに / なし', 'ref: refs'],
  ['REFS/', 'ref: REFS/heads/x'], ['先頭に改行', '\nref: refs/heads/x'], ['Ref:', 'Ref: refs/heads/x'], ['全角空白（UTF-8）', 'ref:\u3000refs/heads/x'], ['0xA0 の 1 バイト', 'ref:\u00a0refs/heads/x'], ['0x85 の 1 バイト', 'ref:\u0085refs/heads/x'], ['垂直タブ', 'ref:\vrefs/heads/x'], ['フォームフィード', 'ref:\frefs/heads/x'], ['CR', 'ref:\rrefs/heads/x'],
];

function decoy(t: { after: (fn: () => void) => void }, head: string | Buffer): { a: string; b: string } {
  const root = tempDir(t);
  const a = makeGitDir(join(root, 'a'), PLAIN);
  const b = join(a, 'b');
  mkdirSync(join(b, 'objects'), { recursive: true });
  mkdirSync(join(b, 'refs'), { recursive: true });
  writeFileSync(join(b, 'HEAD'), head);
  return { a, b };
}

test('HEAD の中身: 本物の git が b を git のフォルダとするときだけ、ガードも b をふつうの git のフォルダとする。そうでなければ今回だけ（読めない）か、上を使う', { skip: !gitAvailable && 'git が無い' }, t => {
  const wrong: string[] = [];
  for (const [label, head] of HEADS) {
    const { a, b } = decoy(t, label.includes('UTF-8') ? head : Buffer.from(head, 'latin1'));
    const real = spawnSync('git', ['-C', b, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).stdout.trim().replaceAll('\\', '/');
    const gitUsesB = real.replace(/\/+$/u, '') === b.replaceAll('\\', '/');
    const found = findGitDir(b);
    const guardOkAtB = found?.gitDir === b && found.broken !== true;
    if (gitUsesB !== guardOkAtB) wrong.push(`${label}: git は ${gitUsesB ? 'b' : '上'} を使う、ガードは ${guardOkAtB ? 'b' : found?.broken ? '読めない' : '上'}`);
  }
  assert.deepEqual(wrong, []);
});

test('HEAD が不正なおとり a/b: 上の裏のリポジトリ a の設定の textconv が動く。ガードは今回だけ（読めない）にする', t => {
  const { a, b } = decoy(t, 'x');
  appendFileSync(join(a, 'config'), '[diff "x"]\n\ttextconv = ./conv.sh\n');
  const info = inspectRepo(b);
  assert.equal(info.found, true);
  assert.equal(info.unreadable || !info.configOk, true, JSON.stringify(info));
  // git は b を飛ばして上を使うが、git の版で認める範囲が変わりうるので、b は「読めない」（今回だけ）にする
  assert.equal(findGitDir(b)?.broken, true);
  assert.equal(info.unreadable, true);
  // 上の a だけを調べても、textconv は見つかる
  assert.equal(inspectRepo(a).configOk, false);
  // HEAD が有効なら、b 自身の設定を調べる
  writeFileSync(join(b, 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(findGitDir(b)?.gitDir, b);
  assert.equal(inspectRepo(b).configOk, true, 'b の設定は空');
});

test('HEAD が不正で objects/ と refs/ が無いフォルダは、git のフォルダではないので上へ進む。HEAD が無いフォルダも同じ', t => {
  const root = tempDir(t);
  const a = makeGitDir(join(root, 'a'), PLAIN);
  const b = join(a, 'b');
  mkdirSync(b);
  writeFileSync(join(b, 'HEAD'), 'garbage');
  assert.equal(findGitDir(b)?.gitDir, a);
  const c = join(a, 'c');
  mkdirSync(join(c, 'objects'), { recursive: true });
  mkdirSync(join(c, 'refs'), { recursive: true });
  assert.equal(findGitDir(c)?.gitDir, a, 'HEAD が無ければ上へ（git と同じ）');
});

test('HEAD が refs/ へのシンボリックリンクなら有効、それ以外なら不正（POSIX）', { skip: (process.platform === 'win32' || !gitAvailable) && 'シンボリックリンクを作れない環境、または git が無い' }, t => {
  const ok = decoy(t, '');
  rmSync(join(ok.b, 'HEAD'));
  symlinkSync('refs/heads/main', join(ok.b, 'HEAD'));
  const real = spawnSync('git', ['-C', ok.b, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(real, ok.b, '本物の git は b を使う');
  assert.equal(findGitDir(ok.b)?.gitDir, ok.b);
  assert.equal(findGitDir(ok.b)?.broken, undefined);
  const bad = decoy(t, '');
  rmSync(join(bad.b, 'HEAD'));
  symlinkSync('elsewhere', join(bad.b, 'HEAD'));
  assert.equal(spawnSync('git', ['-C', bad.b, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).stdout.trim(), bad.a, '本物の git は上を使う');
  assert.equal(findGitDir(bad.b)?.broken, true);
});

test('HEAD がフォルダのとき: 本物の git は認めず上を使う。ガードは今回だけ（読めない）にする', { skip: !gitAvailable && 'git が無い' }, t => {
  const { a, b } = decoy(t, '');
  rmSync(join(b, 'HEAD'));
  mkdirSync(join(b, 'HEAD'));
  assert.equal(spawnSync('git', ['-C', b, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).stdout.trim().replaceAll('\\', '/'), a.replaceAll('\\', '/'), '本物の git は上を使う');
  assert.equal(findGitDir(b)?.broken, true);
});

test('HEAD が読めないとき（POSIX）: 本物の git は認めず上を使う。ガードは今回だけ（読めない）にする', { skip: (process.platform === 'win32' || process.getuid?.() === 0 || !gitAvailable) && '読めなくできない環境、または git が無い' }, t => {
  const { a, b } = decoy(t, 'ref: refs/heads/main\n');
  chmodSync(join(b, 'HEAD'), 0);
  try {
    assert.equal(spawnSync('git', ['-C', b, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).stdout.trim(), a, '本物の git は上を使う');
    assert.equal(findGitDir(b)?.broken, true);
  } finally { chmodSync(join(b, 'HEAD'), 0o644); }
});

// 審査の指摘（深い審査）: git の is_git_directory は objects/・refs/ を access() で見るだけで、Windows ではファイルでも通る。
// そのフォルダの設定の diff.external が、許可された `git diff --no-index` で動く。フォルダでないものがあれば「読めない」（今回だけ）にする
const EVIL_EXT = `${PLAIN}[diff]\n\texternal = /evil/ext.sh\n`;

function folderWith(t: { after: (fn: () => void) => void }, objects: 'dir' | 'file' | 'none', refs: 'dir' | 'file' | 'none'): string {
  const root = tempDir(t);
  const fake = join(root, 'fake');
  mkdirSync(fake);
  writeFileSync(join(fake, 'HEAD'), 'ref: refs/heads/main');
  writeFileSync(join(fake, 'config'), EVIL_EXT);
  for (const [name, kind] of [['objects', objects], ['refs', refs]] as const) {
    if (kind === 'dir') mkdirSync(join(fake, name));
    else if (kind === 'file') writeFileSync(join(fake, name), '', { mode: 0o755 });
  }
  return fake;
}

test('objects/・refs/ がフォルダでないとき: 本物の git が git のフォルダとするなら、ガードは設定を調べて今回だけにする（フォルダでないものがあれば「読めない」）', { skip: !gitAvailable && 'git が無い' }, t => {
  const kinds = ['dir', 'file', 'none'] as const;
  const wrong: string[] = [];
  for (const objects of kinds) for (const refs of kinds) {
    const fake = folderWith(t, objects, refs);
    const real = spawnSync('git', ['-C', fake, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).stdout.trim().replaceAll('\\', '/');
    const gitUses = real.replace(/\/+$/u, '') === fake.replaceAll('\\', '/');
    const info = inspectRepo(fake);
    const looksLikeGit = objects === 'file' || refs === 'file';
    // git が使う、または git のフォルダに見えるのに、ガードが「ふつうの設定」として通すことは無い
    const passes = info.found && !info.unreadable && info.configOk;
    if ((gitUses || looksLikeGit) && (passes || (!info.found && looksLikeGit))) wrong.push(`objects=${objects} refs=${refs}: git は ${gitUses ? 'このフォルダ' : '別'}、ガードは ${JSON.stringify(info)}`);
    if (objects === 'dir' && refs === 'dir') assert.equal(info.badKey, 'diff.external', 'どちらもフォルダなら、設定を読む');
    if ((objects === 'file' || refs === 'file') && looksLikeGit) assert.equal(info.unreadable, true, `objects=${objects} refs=${refs}`);
  }
  assert.deepEqual(wrong, []);
});

test('深さの上限（64 階層）に着いても、上のリポジトリを見落とさない（読めない、今回だけ）', t => {
  const root = tempDir(t);
  makeGitDir(join(root, '.git'), EVIL_EXT);
  let dir = root;
  for (let i = 0; i < 70; i++) dir = join(dir, 'd');
  mkdirSync(dir, { recursive: true });
  const info = inspectRepo(dir);
  assert.equal(info.found, true, '上限で「リポジトリなし」にしてはいけない');
  assert.equal(info.unreadable || !info.configOk, true, JSON.stringify(info));
  // 上限の内側なら、ふつうに見つかる
  let near = root;
  for (let i = 0; i < 10; i++) near = join(near, 'd');
  assert.equal(findGitDir(near)?.gitDir, join(root, '.git'));
});

// commondir・gitdir ファイルは、git と同じに、末尾の改行と CR だけを落とす（空白・NBSP は落とさない）
const ADMIN: Array<[string, string]> = [
  ['LF', '../c\n'], ['CRLF', '../c\r\n'], ['改行なし', '../c'], ['改行が続く', '../c\n\n'], ['CR だけ', '../c\r'],
  ['末尾に空白', '../c '], ['末尾に NBSP', '../c '], ['末尾にタブ', '../c\t'], ['先頭に空白', ' ../c'], ['途中に改行', '../c\nx'], ['空', ''], ['末尾に全角空白', '../c　'],
];

function worktreeLike(t: { after: (fn: () => void) => void }, commondir: string): string {
  const root = tempDir(t);
  makeGitDir(join(root, 'c'), `${PLAIN}[diff]\n\texternal = /evil/ext.sh\n`);
  const w = join(root, 'w');
  mkdirSync(w);
  writeFileSync(join(w, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(w, 'commondir'), commondir);
  return w;
}

test('commondir ファイル: 本物の git が使うときだけ、ガードも使う。末尾の空白・NBSP は git も落とさない', { skip: !gitAvailable && 'git が無い' }, t => {
  const wrong: string[] = [];
  for (const [label, content] of ADMIN) {
    const w = worktreeLike(t, content);
    const real = spawnSync('git', ['-C', w, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).stdout.trim().replaceAll('\\', '/');
    const gitUses = real.replace(/\/+$/u, '') === w.replaceAll('\\', '/');
    const found = findGitDir(w);
    const guardOk = found?.gitDir === w && found.broken !== true;
    // 危ないのは 2 つ: git が使うのにガードが使わず上へ進む、ガードが使うのに git が使わない。ガードが「読めない」（今回だけ）にするのは安全側
    // （Windows は末尾の空白を落とすので、末尾の空白の commondir を git が使う。Linux は使わない）
    const brokenHere = found?.gitDir === w && found.broken === true;
    if ((gitUses && !guardOk && !brokenHere) || (!gitUses && guardOk)) wrong.push(`${label}: git は ${gitUses ? 'w を使う' : '使わない'}、ガードは ${guardOk ? 'w を使う' : brokenHere ? '読めない' : '上へ'}`);
  }
  assert.deepEqual(wrong, []);
});

test('.git ファイル（gitdir:）: 本物の git が使うときだけ、ガードも使う', { skip: !gitAvailable && 'git が無い' }, t => {
  const files: Array<[string, string]> = [
    ['LF', 'gitdir: ../gd\n'], ['CRLF', 'gitdir: ../gd\r\n'], ['改行なし', 'gitdir: ../gd'], ['改行が続く', 'gitdir: ../gd\n\n'],
    ['gitdir: の後ろの空白なし', 'gitdir:../gd\n'], ['空白 2 つ', 'gitdir:  ../gd\n'], ['末尾に空白', 'gitdir: ../gd \n'], ['末尾に NBSP', 'gitdir: ../gd \n'],
    ['大文字', 'GITDIR: ../gd\n'], ['2 行目', 'gitdir: ../gd\nextra\n'], ['空', ''], ['タブ', 'gitdir:\t../gd\n'],
  ];
  const wrong: string[] = [];
  for (const [label, content] of files) {
    const root = tempDir(t);
    makeGitDir(join(root, 'gd'), `${PLAIN}[diff]\n\texternal = /evil/ext.sh\n`);
    const repo = join(root, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, '.git'), content);
    const real = spawnSync('git', ['-C', repo, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).stdout.trim().replaceAll('\\', '/');
    const gitUses = real.replace(/\/+$/u, '') === join(root, 'gd').replaceAll('\\', '/');
    const found = findGitDir(repo);
    const guardOk = found?.gitDir === join(root, 'gd') && found.broken !== true;
    const brokenHere = found?.broken === true;
    if ((gitUses && !guardOk && !brokenHere) || (!gitUses && guardOk)) wrong.push(`${label}: git は ${gitUses ? 'gd を使う' : '使わない'}、ガードは ${guardOk ? 'gd を使う' : brokenHere ? '読めない' : '上へ'}`);
  }
  assert.deepEqual(wrong, []);
});

// 審査の指摘（深い審査）: push の宛先に使える remote の名前は、設定の remote.<名前>.url がある名前。ブランチの既定の宛先も、その名前か . のどれか（フォルダを指すと、push がそのフォルダのフックを動かす）
test('remote の名前: remote.<名前>.url がある名前だけ（名前にドットがあってもよい）。ブランチの既定の宛先が名前でないものは、ふつうでない', t => {
  const cfg = (extra: string) => `${PLAIN}[remote "my.remote"]\n\turl = ../x\n[remote "fetchonly"]\n\tfetch = +refs/heads/*:refs/remotes/fetchonly/*\n${extra}`;
  assert.deepEqual(inspectRepo(repoWith(t, cfg(''))).remotes, ['origin', 'my.remote']);
  assert.deepEqual(inspectRepo(repoWith(t, PLAIN.replace('[remote "origin"]\n\turl = https://example.com/a.git\n', '[remote "origin"]\n'))).remotes, [], 'url が無い remote は、宛先として使えない');
  assert.deepEqual(inspectRepo(tempDir(t)).remotes, [], 'リポジトリが無ければ空');
  // ブランチの既定の宛先: remote の名前か . なら、ふつう。それ以外（フォルダ）はふつうでない
  assert.equal(inspectRepo(repoWith(t, cfg('[branch "b"]\n\tremote = origin\n\tpushremote = my.remote\n'))).configOk, true);
  assert.equal(inspectRepo(repoWith(t, cfg('[branch "b"]\n\tremote = .\n'))).configOk, true);
  const dir = inspectRepo(repoWith(t, cfg('[branch "b"]\n\tremote = ../victim\n')));
  assert.equal(dir.configOk, false);
  assert.equal(dir.badKey, 'branch.b.remote = ../victim');
  assert.equal(inspectRepo(repoWith(t, cfg('[branch "b"]\n\tpushremote = victim\n'))).badKey, 'branch.b.pushremote = victim');
  assert.equal(inspectRepo(repoWith(t, cfg('[branch "b"]\n\tremote = fetchonly\n'))).configOk, false, 'url の無い名前は宛先として使えない');
});
