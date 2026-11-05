// git を、ホームとシステムの設定の「コードを動かせる項目」を落とした設定だけで動かす（security-self-api.md の審査 4）。
// リポジトリの設定は git-repo.ts が調べるが、ホームの ~/.gitconfig・~/.config/git/config・システムの gitconfig（Git for Windows の etc/gitconfig など）は
// 調べていなかった。そこに core.fsmonitor・alias・core.sshCommand などがあれば、許可された `git status` で動く。
// 選んだ方法: 見て判定する（Git for Windows のシステム設定は credential.helper など一覧外の項目が普通にあり、すべて今回だけになってしまう）のではなく、
// 一覧に入る項目だけを写した設定を Clive のデータのフォルダに作り、GIT_CONFIG_GLOBAL でそれだけを読ませ、GIT_CONFIG_NOSYSTEM でシステム設定を読ませない（git 2.32 以上）。
// 名前・メール・autocrlf・認証の補助（manager など）は残るので、commit や push は今までどおり使える

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

// 子プロセスに足す環境変数。洗い出した設定を、データのフォルダに（変わったときだけ）書く
export function gitEnvFor(options: { dataDir: string; env: Env; gitExe?: string }): Record<string, string> {
  const file = join(options.dataDir, 'git-global', 'gitconfig');
  const texts = gitConfigSources(options.env, options.gitExe).flatMap(source => readSmall(source) ?? []);
  const next = sanitizeGitConfig(texts);
  try {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== next) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, next, 'utf8');
    }
  } catch { /* 書けなければ、読めない設定を指すことになり、git は何も読まない（安全側） */ }
  return { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' };
}
