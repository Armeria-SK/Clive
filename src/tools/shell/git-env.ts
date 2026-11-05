// git を、ホームとシステムの設定の「コードを動かせる項目」を落とした設定だけで動かす（security-self-api.md の審査 4）。
// リポジトリの設定は git-repo.ts が調べるが、ホームの ~/.gitconfig・~/.config/git/config・システムの gitconfig（Git for Windows の etc/gitconfig など）は
// 調べていなかった。そこに core.fsmonitor・alias・core.sshCommand などがあれば、許可された `git status` で動く。
// 選んだ方法: 見て判定する（Git for Windows のシステム設定は credential.helper など一覧外の項目が普通にあり、すべて今回だけになってしまう）のではなく、
// 一覧に入る項目だけを写した設定を Clive のデータのフォルダに作り、GIT_CONFIG_GLOBAL でそれだけを読ませ、GIT_CONFIG_NOSYSTEM でシステム設定を読ませない（git 2.32 以上）。
// 名前・メール・autocrlf・認証の補助（manager など）は残るので、commit や push は今までどおり使える。
// 洗い出した設定のファイルは、シェルを1回動かすごとに、データのフォルダの下の新しい（名前を当てられない）場所に作り、終わったら消す。
// 決まった場所に置くと、確かめを許したあとの同じコマンドの中でそこへ書き込み、続けて動かす git status に読ませられる

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseGitConfig, unusualKey, type ConfigEntry } from '../hooks/git-repo.ts';
import type { Env } from '../hooks/tool-config.ts';

const MAX_CONFIG_BYTES = 1_048_576;

// 認証の補助は、決まった名前だけ（!コマンド・パスは動かすコードになる）
const SAFE_HELPER = /^(?:|manager(?:-core)?|wincred|osxkeychain|libsecret|gnome-keyring|netrc|cache(?: --timeout(?:=|\s)\d+)?|store)$/iu;
// 一覧（git-repo.ts のふつうの設定）のほかに、ホームやシステムの設定に普通にあって、コードを動かさないもの
const EXTRA_PLAIN = new Set(['http.sslbackend', 'http.sslcainfo', 'http.sslcapath', 'http.sslverify', 'safe.directory', 'core.fscache', 'core.preloadindex', 'core.untrackedcache', 'core.fsync', 'feature.manyfiles', 'rebase.autostash', 'merge.ff', 'fetch.parallel', 'submodule.recurse']);

function allowed(entry: ConfigEntry): boolean {
  const parts = entry.key.split('.');
  const name = parts.at(-1)!;
  if (parts[0] === 'credential') return (name === 'helper' && SAFE_HELPER.test(entry.value.trim())) || name === 'usehttppath' || name === 'usehttpspath';
  if (EXTRA_PLAIN.has(entry.key)) return true;
  // リポジトリの設定では読むサブコマンドのときだけ許していたが、ホームの設定では書くサブコマンド（commit など）のフックの場所にもなるので落とす
  if (entry.key === 'core.hookspath') return false;
  // git log が署名の検証のために gpg を動かす
  if (entry.key === 'log.showsignature') return false;
  return unusualKey([entry]) === null && parts[0] !== 'extensions';
}

const quote = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

// 設定の文を重ねて、残す項目だけの設定の文にする。読めない（壊れた）ファイルは丸ごと捨てる
export function sanitizeGitConfig(texts: readonly string[]): string {
  const kept: ConfigEntry[] = [];
  for (const text of texts) {
    const entries = parseGitConfig(text);
    if (!entries) continue;
    for (const entry of entries) if (allowed(entry) && !/[\r\n]/u.test(entry.value)) kept.push(entry);
  }
  let out = '# Clive が作った設定: ホームとシステムの git の設定から、コードを動かせない項目だけを写したもの\n';
  let header = '';
  for (const entry of kept) {
    const parts = entry.key.split('.');
    const section = parts[0]!;
    const name = parts.at(-1)!;
    const sub = parts.length > 2 ? parts.slice(1, -1).join('.') : null;
    const line = sub === null ? `[${section}]` : `[${section} ${quote(sub)}]`;
    if (line !== header) { out += `${line}\n`; header = line; }
    out += `\t${name} = ${quote(entry.value)}\n`;
  }
  return out;
}

export function gitVersionAtLeast(output: string, major: number, minor: number): boolean {
  const m = /git version (\d+)\.(\d+)/u.exec(output);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > major || (a === major && b >= minor);
}

const versionCache = new Map<string, boolean>();
// GIT_CONFIG_GLOBAL を効かせられる git か（2.32 以上）。git が無ければ、動くものも無いので true
export function gitSupportsConfigOverride(gitExe: string | undefined): boolean {
  if (!gitExe) return true;
  const cached = versionCache.get(gitExe);
  if (cached !== undefined) return cached;
  let ok = false;
  try { ok = gitVersionAtLeast(execFileSync(gitExe, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }), 2, 32); } catch { ok = false; }
  versionCache.set(gitExe, ok);
  return ok;
}

function readSmall(file: string): string | undefined {
  try {
    const st = statSync(file);
    return st.isFile() && st.size <= MAX_CONFIG_BYTES ? readFileSync(file, 'utf8') : undefined;
  } catch { return undefined; }
}

// ホームとシステムの設定のファイル（Git for Windows の etc/gitconfig は git.exe の場所から探す）
export function gitConfigSources(env: Env, gitExe?: string): string[] {
  const homes = [...new Set([env.HOME, env.USERPROFILE, homedir()].filter((x): x is string => Boolean(x)))];
  const system = [
    '/etc/gitconfig', '/usr/local/etc/gitconfig', join(env.ProgramData ?? 'C:\\ProgramData', 'Git', 'config'),
    ...(gitExe ? [join(dirname(dirname(gitExe)), 'etc', 'gitconfig'), join(dirname(dirname(gitExe)), 'mingw64', 'etc', 'gitconfig'), join(dirname(dirname(dirname(gitExe))), 'etc', 'gitconfig'), join(dirname(dirname(dirname(gitExe))), 'mingw64', 'etc', 'gitconfig')] : []),
  ];
  const xdg = env.XDG_CONFIG_HOME ? [join(env.XDG_CONFIG_HOME, 'git', 'config')] : [];
  return [...new Set([...system, ...xdg, ...homes.flatMap(h => [join(h, '.config', 'git', 'config'), join(h, '.gitconfig')])])];
}

const RUN_FOLDER = 'git-run';

// コマンドレベルの設定（GIT_CONFIG_COUNT）は、リポジトリの設定・ホームの設定より優先される（git -c だけがこれより優先される。-c は許可の一覧で今回だけ）。
// プログラムを動かす決まった名前の項目を、リポジトリの見つけ方（git-repo.ts）が git とずれても動かないように、先に打ち消す。
// 打ち消せないもの: diff.external（どんな値でもプログラムとして動かされ、空にすると git diff が動かなくなる）と、名前が決まっていない項目
// （filter.<名前>.clean・smudge、diff.<名前>.textconv・command、merge.<名前>.driver、alias.<名前>、pager.<コマンド>、url.<先>.insteadOf、credential.<URL>.helper、
// remote.<名前>.uploadpack・receivepack・vcs、submodule.<名前>.update、trailer.<名前>.command）。これらは git-repo.ts がリポジトリの設定を調べて今回だけにする
function overrides(hooksDir: string, helpers: readonly string[]): Array<[string, string]> {
  return [
    ['core.fsmonitor', 'false'], ['core.hooksPath', hooksDir], ['core.pager', 'cat'], ['core.editor', 'true'], ['sequence.editor', 'true'],
    ['core.sshCommand', 'ssh'], ['core.askPass', ''], ['core.gitProxy', 'none'],
    ['gpg.program', 'gpg'], ['gpg.openpgp.program', 'gpg'], ['gpg.x509.program', 'gpgsm'], ['gpg.ssh.program', 'ssh-keygen'], ['gpg.ssh.defaultKeyCommand', 'ssh-add -L'],
    ['protocol.ext.allow', 'never'], ['log.showSignature', 'false'],
    // 名前を明示した裏のリポジトリ（--git-dir）だけを使う。上のフォルダをたどって、裏のリポジトリを見つけない（git 2.38 以上）。
    // objects/・refs/ の見え方など、リポジトリの見つけ方が git とずれても、見つけたつもりのないフォルダの設定は読まれない
    ['safe.bareRepository', 'explicit'],
    // 認証の補助は足し算なので、先に空にして（リポジトリの設定の補助を捨てる）、洗い出した設定にある安全な補助だけを足し直す
    ['credential.helper', ''], ...helpers.map((helper): [string, string] => ['credential.helper', helper]),
  ];
}

function countEnv(entries: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = value; });
  return env;
}
// 途中で止まった実行の残りを消す目安（実行は最長でも1時間）
const STALE_MS = 6 * 60 * 60 * 1000;

export interface GitRun {
  // 子プロセスに足す環境変数
  env: Record<string, string>;
  // この実行の置き場所（洗い出した設定のファイルがある）を消す
  cleanup: () => void;
}

function sweepStale(root: string): void {
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) {
    try {
      const path = join(root, name);
      if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
    } catch { /* 消せなければ残す */ }
  }
}

// シェルを1回動かす分の、洗い出した設定とその環境変数。置き場所は毎回新しい。書けなければ、無いファイルを指すことになり、git は何も読まない（安全側）
export function prepareGitRun(options: { dataDir: string; env: Env; gitExe?: string }): GitRun {
  const root = join(options.dataDir, RUN_FOLDER);
  const dir = join(root, randomUUID());
  const file = join(dir, 'gitconfig');
  const hooks = join(dir, 'hooks');
  let helpers: string[] = [];
  try {
    mkdirSync(hooks, { recursive: true });
    sweepStale(root);
    const texts = gitConfigSources(options.env, options.gitExe).flatMap(source => readSmall(source) ?? []);
    const sanitized = sanitizeGitConfig(texts);
    writeFileSync(file, sanitized, { encoding: 'utf8', mode: 0o600 });
    helpers = (parseGitConfig(sanitized) ?? []).filter(e => e.key === 'credential.helper' && e.value !== '').map(e => e.value);
  } catch { /* 上のとおり。フックの置き場所が無くても、フックは動かない */ }
  return {
    env: { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', ...countEnv(overrides(hooks, helpers)) },
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 残っても、次の実行が古いものを消す */ } },
  };
}
