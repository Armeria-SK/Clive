// ツールの設定ファイル（security-self-api.md の審査 4）。git・curl・wget・npm・シェルの起動ファイル・PowerShell のプロファイルなどは、
// あとで動く許可済みのコマンド（git status・curl・シェルの起動）に、設定でコードを読み込ませられる。そこへの書き込み・消すこと・名前の変更は、
// 許可フォルダの中でも外でも、シェルからは今回だけにする。ここは、その場所の一覧と、調べる関数

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isInside } from './scope.ts';

export type Env = Readonly<Record<string, string | undefined>>;

// ホームの下（ファイルは名前そのもの、フォルダは中すべて）
const HOME_PATHS = [
  '.gitconfig', '.gitattributes', '.config/git', '.curlrc', '_curlrc', 'Application Data/.curlrc', 'Application Data/_curlrc', '.config/curlrc', '.wgetrc', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmrc', '.config/yarn', '.config/pnpm', '.config/pip', '.pip', '.pypirc',
  '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.bash_aliases', '.profile', '.kshrc', '.zlogout', '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.inputrc', '.config/fish', '.config/powershell', '.jq', '.ripgreprc', '.cargo/config', '.cargo/config.toml',
  '.docker', '.ssh', '.gnupg', '.aws', '.kube',
  'Documents/WindowsPowerShell', 'Documents/PowerShell', 'OneDrive/Documents/WindowsPowerShell', 'OneDrive/Documents/PowerShell',
];
const APPDATA_PATHS = ['_curlrc', '.curlrc', 'pip', 'npm/etc', 'git', 'Microsoft/Windows/PowerShell'];
const XDG_PATHS = ['git', 'curlrc', 'powershell', 'pip', 'yarn', 'pnpm', 'fish'];
const POSIX_SYSTEM = ['/etc/gitconfig', '/etc/gitattributes', '/etc/wgetrc', '/etc/npmrc', '/etc/profile', '/etc/profile.d', '/etc/bash.bashrc', '/etc/environment', '/etc/zsh', '/etc/pip.conf', '/usr/local/etc/gitconfig', '/usr/local/etc/wgetrc'];

function windowsSystem(env: Env): string[] {
  const programFiles = [...new Set([env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, 'C:\\Program Files', 'C:\\Program Files (x86)'].filter((x): x is string => Boolean(x)))];
  const programData = env.ProgramData ?? 'C:\\ProgramData';
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  return [
    ...programFiles.flatMap(p => [join(p, 'Git', 'etc'), join(p, 'Git', 'mingw64', 'etc'), join(p, 'Git', 'mingw32', 'etc'), join(p, 'PowerShell'), join(p, 'WindowsPowerShell')]),
    join(programData, 'Git'), join(systemRoot, 'System32', 'WindowsPowerShell'), join(systemRoot, 'SysWOW64', 'WindowsPowerShell'),
  ];
}

// 場所の一覧（絶対パス。ファイルもフォルダも）
export function toolConfigPaths(env: Env = process.env): string[] {
  const homes = [...new Set([homedir(), env.HOME, env.USERPROFILE].filter((x): x is string => Boolean(x)))];
  const out: string[] = [];
  for (const home of homes) for (const rel of HOME_PATHS) out.push(join(home, ...rel.split('/')));
  if (env.APPDATA) for (const rel of APPDATA_PATHS) out.push(join(env.APPDATA, ...rel.split('/')));
  if (env.XDG_CONFIG_HOME) for (const rel of XDG_PATHS) out.push(join(env.XDG_CONFIG_HOME, ...rel.split('/')));
  if (env.CURL_HOME) out.push(join(env.CURL_HOME, '.curlrc'), join(env.CURL_HOME, '_curlrc'));
  if (env.WGETRC) out.push(env.WGETRC);
  out.push(...POSIX_SYSTEM, ...windowsSystem(env));
  return out;
}

// どこにあっても、この名前のファイルは PowerShell のプロファイル（読み込まれるたびに動く）
const PROFILE_NAME = /^(?:microsoft\.powershell_profile|microsoft\.vscode_profile|microsoft\.powershellise_profile)\.ps1$/iu;

// どのフォルダにあっても、この名前のファイルは curl・wget の設定（作業フォルダのものも、cd のあとの curl・wget が読む場所になりうる）
const RC_NAME = /^(?:\.curlrc|_curlrc|\.wgetrc)$/iu;

export function isToolConfigPath(abs: string, env: Env = process.env): boolean {
  const name = abs.split(/[\\/]/u).pop() ?? '';
  if (PROFILE_NAME.test(name) || RC_NAME.test(name)) return true;
  return toolConfigPaths(env).some(p => isInside(p, abs));
}

// フォルダの下に、ツールの設定ファイルがある（そのフォルダごと書く・消すと、設定まで届く）
export function containsToolConfig(dir: string, env: Env = process.env): boolean {
  return toolConfigPaths(env).some(p => isInside(dir, p));
}

// ── 読む側: curl・wget が起動のたびに読む設定ファイル ──
// 書き込みの見張りは上。ここは、許可された curl・wget が、保存先（output・output_document）や送り先を変える設定を読み込むのを防ぐために、読まれる設定ファイルがあるかを調べる。
// 場所は、本物の curl 8.19（Windows の System32 と Git for Windows）と GNU Wget 1.21.2 で確かめた。-q（curl は最初の引数）・--no-config（wget）を付けると読まれない。
// 作業フォルダの .curlrc は curl 8.19 では読まれないが、古い curl が読むかは確かめられないので、あれば同じに扱う。
// wget のシステムの設定（/etc/wgetrc）は、管理者が置いたもの（書き換えは上の見張りで今回だけ）で、Debian では既定でも有効な行があるので、調べない

const MAX_RC_BYTES = 1_048_576;

// 空の行・# のコメントだけなら、読まれても何も変わらない
function hasSettings(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    return readFileSync(file, 'utf8').slice(0, MAX_RC_BYTES).split(/\r?\n/u).some(line => !/^\s*(?:#.*)?$/u.test(line));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR';
  }
}

function homesOf(env: Env): string[] {
  const homes = [...new Set([env.HOME, env.USERPROFILE].filter((x): x is string => Boolean(x)))];
  return homes.length > 0 ? homes : [homedir()];
}

// curl が設定として読むファイルのうち、設定が書かれているもの（最初の 1 つ）。cwd は分かるときだけ
export function curlConfigFile(env: Env, cwd?: string): string | undefined {
  const homes = homesOf(env);
  const dirs = [env.CURL_HOME, ...homes, env.APPDATA, ...homes.map(h => join(h, 'Application Data')), cwd].filter((x): x is string => Boolean(x));
  const files = [
    ...dirs.flatMap(d => [join(d, '.curlrc'), join(d, '_curlrc')]),
    ...(env.XDG_CONFIG_HOME ? [join(env.XDG_CONFIG_HOME, 'curlrc')] : []),
    ...homes.map(h => join(h, '.config', 'curlrc')),
  ];
  return files.find(hasSettings);
}

// wget が設定として読むファイルのうち、設定が書かれているもの（最初の 1 つ）
export function wgetConfigFile(env: Env): string | undefined {
  const files = [...(env.WGETRC ? [env.WGETRC] : []), ...homesOf(env).map(h => join(h, '.wgetrc'))];
  return files.find(hasSettings);
}
