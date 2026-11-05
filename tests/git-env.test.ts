import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseGitConfig } from '../src/tools/hooks/git-repo.ts';
import { gitEnvFor, gitVersionAtLeast, sanitizeGitConfig } from '../src/tools/shell/git-env.ts';
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
  const isolated = gitEnvFor({ dataDir: join(root, 'data'), env: baseEnv });
  assert.equal(isolated.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(isolated.GIT_CONFIG_GLOBAL, join(root, 'data', 'git-global', 'gitconfig'));
  const env = { ...baseEnv, ...isolated };
  git(['status', '--short'], env);
  assert.equal(existsSync(marker), false, '洗い出した設定では、core.fsmonitor は動かない');
  assert.match(git(['var', 'GIT_AUTHOR_IDENT'], env).stdout, /Taro Yamada <taro@example\.com>/u, '名前・メールは残る');
  const listed = git(['config', '--list', '--show-origin'], env).stdout;
  assert.doesNotMatch(listed, /fsmonitor|evil/u);
  assert.match(readFileSync(isolated.GIT_CONFIG_GLOBAL!, 'utf8'), /Taro Yamada/u);
});


test('洗い出した設定のファイルは、書き換えられても、次に git を動かす前に作り直される', t => {
  const root = tempDir(t);
  const home = join(root, 'home');
  mkdirSync(home);
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Taro Yamada\n[core]\n\tfsmonitor = /evil/hook.sh\n');
  const env = { HOME: home, USERPROFILE: home };
  const file = gitEnvFor({ dataDir: join(root, 'data'), env }).GIT_CONFIG_GLOBAL!;
  const good = readFileSync(file, 'utf8');
  assert.match(good, /Taro Yamada/u);
  assert.doesNotMatch(good, /fsmonitor/u);
  writeFileSync(file, '[core]\n\tfsmonitor = /evil/hook.sh\n');
  gitEnvFor({ dataDir: join(root, 'data'), env });
  assert.equal(readFileSync(file, 'utf8'), good);
  // ホームの設定が変われば、写しも変わる
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Hanako\n');
  gitEnvFor({ dataDir: join(root, 'data'), env });
  assert.match(readFileSync(file, 'utf8'), /Hanako/u);
});
