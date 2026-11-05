import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { parseGitConfig } from '../src/tools/hooks/git-repo.ts';
import { gitVersionAtLeast, prepareGitRun, sanitizeGitConfig } from '../src/tools/shell/git-env.ts';
import { tempDir } from './helpers.ts';

// 審査で見つかった: ホームの ~/.gitconfig（と、Git for Windows の etc/gitconfig など）は、リポジトリの設定の検査に入っていなかった。
// そこに仕込まれた core.fsmonitor などは、許可された `git status` で動く。git を、コードを動かせる項目を落とした設定だけで動かす

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const slash = (p: string): string => p.replaceAll('\\', '/');

const EVIL = `[user]
\tname = Taro Yamada
\temail = taro@example.com
[core]
\tautocrlf = input
\tfsmonitor = /evil/hook.sh
\tsshCommand = evil-ssh
\thooksPath = /evil/hooks
\tpager = evil-pager
\teditor = evil-editor
[alias]
\tx = !touch /tmp/pwned
[diff "x"]
\ttextconv = /evil/conv.sh
[filter "lfs"]
\tclean = evil clean
[include]
\tpath = /evil/more.cfg
[includeIf "gitdir:/"]
\tpath = /evil/more2.cfg
[url "https://evil.example/"]
\tinsteadOf = https://github.com/
[credential]
\thelper = manager
[credential "https://evil.example"]
\thelper = !evil-helper
[credential "https://dev.azure.com"]
\tuseHttpPath = true
[http]
\tsslBackend = schannel
\tproxy = http://evil:8080
[safe]
\tdirectory = *
[init]
\tdefaultBranch = main
[gpg]
\tprogram = evil-gpg
[commit]
\tgpgsign = true
`;

test('git の設定の洗い出し: コードを動かせる項目を落とし、名前・メール・ふつうの設定・安全な認証の補助だけ残す', () => {
  const kept = parseGitConfig(sanitizeGitConfig([EVIL]))!.map(e => [e.key, e.value]);
  assert.deepEqual(kept, [
    ['user.name', 'Taro Yamada'], ['user.email', 'taro@example.com'], ['core.autocrlf', 'input'],
    ['credential.helper', 'manager'], ['credential.https://dev.azure.com.usehttppath', 'true'], ['http.sslbackend', 'schannel'],
    ['safe.directory', '*'], ['init.defaultbranch', 'main'],
  ]);
  // 値の引用符・バックスラッシュ・日本語は、書き出して読み直しても同じ
  const tricky = '[user]\n\tname = "Taro \\"T\\" Yamada\\\\"\n\temail = ひらがな@example.com\n';
  assert.deepEqual(parseGitConfig(sanitizeGitConfig([tricky]))!.map(e => [e.key, e.value]), [['user.name', 'Taro "T" Yamada\\'], ['user.email', 'ひらがな@example.com']]);
  // 複数のファイルは、順に重ねる。壊れたファイルは丸ごと捨てる
  const merged = parseGitConfig(sanitizeGitConfig(['[user]\n\tname = A\n', '[user\nbroken', '[user]\n\temail = b@example.com\n']))!.map(e => e.key);
  assert.deepEqual(merged, ['user.name', 'user.email']);
  for (const helper of ['cache --timeout=3600', 'store', 'osxkeychain', 'manager-core', 'wincred', 'libsecret']) assert.equal(sanitizeGitConfig([`[credential]\n\thelper = ${helper}\n`]).includes('helper'), true, helper);
  for (const helper of ['!evil', '/path/to/evil', 'evil', '"manager; evil"', 'cache --evil=x', 'store --file=/etc/passwd; x']) assert.equal(sanitizeGitConfig([`[credential]\n\thelper = ${helper}\n`]).includes('helper'), false, helper);
});

test('git のバージョン: GIT_CONFIG_GLOBAL が効くのは 2.32 から', () => {
  assert.equal(gitVersionAtLeast('git version 2.54.0.windows.1', 2, 32), true);
  assert.equal(gitVersionAtLeast('git version 2.32.0', 2, 32), true);
  assert.equal(gitVersionAtLeast('git version 2.31.1', 2, 32), false);
  assert.equal(gitVersionAtLeast('git version 1.9.5', 2, 32), false);
  assert.equal(gitVersionAtLeast('git version 3.0.0', 2, 32), true);
  assert.equal(gitVersionAtLeast('something else', 2, 32), false);
});

// 本物の git: ホームの設定の core.fsmonitor は、ふつうに動く。洗い出した設定だけにすると動かない（名前・メールは残る）
test('本物の git: ホームの ~/.gitconfig に仕込んだ core.fsmonitor は、そのままだと動き、洗い出した設定にすると動かない。名前は残る', { skip: !gitAvailable && 'git が無い' }, t => {
  const root = tempDir(t);
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  const marker = join(root, 'marker');
  const hook = join(root, 'hook.sh');
  writeFileSync(hook, `#!/bin/sh\necho ran > "${slash(marker)}"\nprintf '\\0'\n`, { mode: 0o755 });
  writeFileSync(join(home, '.gitconfig'), `[user]\n\tname = Taro Yamada\n\temail = taro@example.com\n[core]\n\tfsmonitor = ${slash(hook)}\n`);
  const baseEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_TERMINAL_PROMPT: '0' };
  delete (baseEnv as Record<string, string | undefined>).GIT_CONFIG_GLOBAL;
  const git = (args: string[], env: NodeJS.ProcessEnv) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
  assert.equal(git(['init', '-q'], baseEnv).status, 0);
  // 洗い出さないと: 許可された git status で、ホームの設定のコードが動く
  git(['status', '--short'], baseEnv);
  assert.equal(existsSync(marker), true, '前提: ホームの設定の core.fsmonitor は本物の git で動く');
  rmSync(marker);
  const run = prepareGitRun({ dataDir: join(root, 'data'), env: baseEnv });
  const isolated = run.env;
  assert.equal(isolated.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(dirname(dirname(isolated.GIT_CONFIG_GLOBAL!)), join(root, 'data', 'git-run'));
  assert.equal(basename(isolated.GIT_CONFIG_GLOBAL!), 'gitconfig');
  const env = { ...baseEnv, ...isolated };
  git(['status', '--short'], env);
  assert.equal(existsSync(marker), false, '洗い出した設定では、core.fsmonitor は動かない');
  assert.match(git(['var', 'GIT_AUTHOR_IDENT'], env).stdout, /Taro Yamada <taro@example\.com>/u, '名前・メールは残る');
  const listed = git(['config', '--list', '--show-origin'], env).stdout;
  assert.doesNotMatch(listed, /evil|hook\.sh/u);
  assert.match(listed, /command line:\s*core\.fsmonitor=false/u, 'コマンドレベルの上書きだけが fsmonitor を持つ');
  assert.match(readFileSync(isolated.GIT_CONFIG_GLOBAL!, 'utf8'), /Taro Yamada/u);
  run.cleanup();
});


// 審査の指摘: 決まった場所に置くと、確かめを許したあとの同じコマンドの中でそこへ書き込み、続けて動かす git status に読ませられた。毎回新しい置き場所に作り、終わったら消す
test('洗い出した設定は、実行のたびに新しい置き場所に作られ、終わると消える。ホームの設定が変われば、次の実行の写しが変わる', t => {
  const root = tempDir(t);
  const home = join(root, 'home');
  mkdirSync(home);
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Taro Yamada\n[core]\n\tfsmonitor = /evil/hook.sh\n');
  const env = { HOME: home, USERPROFILE: home };
  const data = join(root, 'data');
  const first = prepareGitRun({ dataDir: data, env });
  const second = prepareGitRun({ dataDir: data, env });
  const a = first.env.GIT_CONFIG_GLOBAL!;
  const b = second.env.GIT_CONFIG_GLOBAL!;
  assert.notEqual(a, b, '2 回の実行が同じ置き場所を使う');
  assert.match(a, /[\\/]git-run[\\/][0-9a-f-]{36}[\\/]gitconfig$/u);
  assert.match(readFileSync(a, 'utf8'), /Taro Yamada/u);
  assert.doesNotMatch(readFileSync(a, 'utf8'), /fsmonitor/u);
  first.cleanup();
  assert.equal(existsSync(a), false);
  assert.equal(existsSync(dirname(a)), false, '置き場所のフォルダごと消える');
  assert.equal(existsSync(b), true, '別の実行の置き場所は消えない');
  second.cleanup();
  assert.deepEqual(readdirSync(join(data, 'git-run')), []);
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Hanako\n');
  const third = prepareGitRun({ dataDir: data, env });
  assert.match(readFileSync(third.env.GIT_CONFIG_GLOBAL!, 'utf8'), /Hanako/u);
  third.cleanup();
});

test('途中で止まった実行の残り（古い置き場所）は、次の実行が消す。新しいものは消さない', t => {
  const root = tempDir(t);
  const data = join(root, 'data');
  const runs = join(data, 'git-run');
  mkdirSync(join(runs, 'old-run'), { recursive: true });
  mkdirSync(join(runs, 'fresh-run'), { recursive: true });
  writeFileSync(join(runs, 'old-run', 'gitconfig'), '[core]\n');
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  utimesSync(join(runs, 'old-run'), old, old);
  const run = prepareGitRun({ dataDir: data, env: { HOME: join(root, 'h') } });
  assert.equal(existsSync(join(runs, 'old-run')), false);
  assert.equal(existsSync(join(runs, 'fresh-run')), true);
  run.cleanup();
});

test('置き場所を作れなくても、無いファイルを指す（git は何も読まない）。cleanup は失敗しても例外にしない', t => {
  const root = tempDir(t);
  const blocker = join(root, 'data');
  writeFileSync(blocker, 'ファイルがあるので、フォルダを作れない');
  const run = prepareGitRun({ dataDir: blocker, env: { HOME: join(root, 'h') } });
  assert.equal(existsSync(run.env.GIT_CONFIG_GLOBAL!), false);
  assert.equal(run.env.GIT_CONFIG_NOSYSTEM, '1');
  run.cleanup();
});

// ── コマンドレベルの上書き（GIT_CONFIG_COUNT）──
// 審査の指摘: リポジトリの見つけ方が git とずれると、ガードが見ていないリポジトリの設定が git に読まれる。
// ずれに頼らないように、リポジトリの設定より優先されるコマンドレベルの設定で、プログラムを動かす決まった名前の項目を打ち消す

function overridesOf(env: Record<string, string>): Array<[string, string]> {
  const count = Number(env.GIT_CONFIG_COUNT);
  return Array.from({ length: count }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`]!, env[`GIT_CONFIG_VALUE_${i}`]!]);
}

test('コマンドレベルの上書き: プログラムを動かす決まった名前の項目を打ち消す。フックの置き場所は、空のフォルダ', t => {
  const root = tempDir(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const run = prepareGitRun({ dataDir: join(root, 'data'), env: { HOME: home, USERPROFILE: home } });
  const list = overridesOf(run.env);
  const map = new Map(list);
  for (const [key, value] of [['core.fsmonitor', 'false'], ['core.pager', 'cat'], ['core.editor', 'true'], ['sequence.editor', 'true'], ['core.sshCommand', 'ssh'], ['core.askPass', ''], ['core.gitProxy', 'none'],
    ['gpg.program', 'gpg'], ['gpg.openpgp.program', 'gpg'], ['gpg.x509.program', 'gpgsm'], ['gpg.ssh.program', 'ssh-keygen'], ['gpg.ssh.defaultKeyCommand', 'ssh-add -L'], ['protocol.ext.allow', 'never']] as const) {
    assert.equal(map.get(key), value, key);
  }
  const hooks = map.get('core.hooksPath')!;
  assert.equal(dirname(hooks), dirname(run.env.GIT_CONFIG_GLOBAL!), 'フックの置き場所は、この実行の置き場所の中');
  assert.deepEqual(readdirSync(hooks), [], '空のフォルダ');
  // 認証の補助: まず空にして（リポジトリの設定の補助を捨てる）、洗い出した設定にある安全な補助だけを足し直す。ホームの設定に補助が無ければ、空にするだけ
  assert.deepEqual(list.filter(([k]) => k === 'credential.helper'), [['credential.helper', '']]);
  run.cleanup();
  assert.equal(existsSync(hooks), false, '終わると消える');
  // 同じ名前を 2 回入れない（あとのほうが勝つので、順序に頼る認証の補助だけ）
  const keys = list.map(([k]) => k).filter(k => k !== 'credential.helper');
  assert.equal(new Set(keys).size, keys.length);
});

test('コマンドレベルの上書き: ホームの設定の安全な認証の補助は、空にしたあとに足し直す', t => {
  const root = tempDir(t);
  const home = join(root, 'home');
  mkdirSync(home);
  writeFileSync(join(home, '.gitconfig'), '[credential]\n\thelper = manager\n\thelper = !evil\n\thelper = cache --timeout=3600\n');
  const run = prepareGitRun({ dataDir: join(root, 'data'), env: { HOME: home, USERPROFILE: home } });
  assert.deepEqual(overridesOf(run.env).filter(([k]) => k === 'credential.helper'), [['credential.helper', ''], ['credential.helper', 'manager'], ['credential.helper', 'cache --timeout=3600']]);
  run.cleanup();
});

test('本物の git: リポジトリの設定の fsmonitor・フック・sshCommand・gpg.program・credential.helper は、上書きがあると動かない（無いと動く）', { skip: !gitAvailable && 'git が無い' }, t => {
  const root = tempDir(t);
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  const marker = (name: string): string => join(root, `m-${name}`);
  const script = (name: string): string => {
    const file = join(root, `s-${name}.sh`);
    writeFileSync(file, `#!/bin/sh\necho ran > "${slash(marker(name))}"\ncase "${name}" in fsmonitor) printf '\\0';; esac\nexit 0\n`, { mode: 0o755 });
    return slash(file);
  };
  writeFileSync(join(root, 'empty-global'), '');
  const baseEnv: Record<string, string> = {
    ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'empty-global'), GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e',
  };
  for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) delete baseEnv[key];
  const git = (args: string[], env: Record<string, string>, input?: string) => spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', ...(input === undefined ? {} : { input }) });
  assert.equal(git(['init', '-q'], baseEnv).status, 0);
  git(['config', 'core.fsmonitor', script('fsmonitor')], baseEnv);
  git(['config', 'core.sshCommand', script('ssh')], baseEnv);
  git(['config', 'gpg.program', script('gpg')], baseEnv);
  git(['config', 'commit.gpgsign', 'true'], baseEnv);
  git(['config', 'credential.helper', `!${script('credential')}`], baseEnv);
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho ran > "${slash(marker('hook'))}"\nexit 0\n`, { mode: 0o755 });
  // 上書きの gpg.program=gpg が指す PATH の gpg は偽物にして、動いたことだけ記録する（本物の gpg は、鍵のデーモンを残す）
  const fakeBin = join(root, 'bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'gpg'), `#!/bin/sh\necho ran > "${slash(marker('pathgpg'))}"\nexit 1\n`, { mode: 0o755 });
  const withFakeGpg = (env: Record<string, string>): Record<string, string> => ({ ...env, PATH: `${fakeBin}${delimiter}${env.PATH ?? env.Path ?? ''}` });
  const exercise = (env: Record<string, string>): void => {
    git(['status', '--short'], env);
    git(['ls-remote', 'ssh://example.invalid/x'], env);
    git(['commit', '-q', '--allow-empty', '-m', 'x'], env);
    git(['credential', 'fill'], env, 'protocol=https\nhost=example.invalid\n\n');
  };
  const names = ['fsmonitor', 'ssh', 'gpg', 'hook', 'credential'];
  // 前提: 上書きが無ければ、どれも動く
  exercise(baseEnv);
  assert.deepEqual(names.filter(n => !existsSync(marker(n))), [], '前提: 本物の git は、リポジトリの設定のプログラムを動かす');
  for (const n of names) rmSync(marker(n));
  const run = prepareGitRun({ dataDir: join(root, 'data'), env: baseEnv });
  exercise(withFakeGpg({ ...baseEnv, ...run.env }));
  assert.deepEqual(names.filter(n => existsSync(marker(n))), [], '上書きがあっても動いた');
  assert.equal(existsSync(marker('pathgpg')), true, 'gpg.program=gpg の上書きは、PATH の gpg を指す');
  run.cleanup();
});
