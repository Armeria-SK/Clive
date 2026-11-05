// ツールの設定ファイル（security-self-api.md の審査 4）。git・curl・wget・npm・シェルの起動ファイル・PowerShell のプロファイルなどは、
// あとで動く許可済みのコマンド（git status・curl・シェルの起動）に、設定でコードを読み込ませられる。そこへの書き込み・消すこと・名前の変更は、
// 許可フォルダの中でも外でも、シェルからは今回だけにする。ここは、その場所の一覧と、調べる関数

import { homedir } from 'node:os';
import { join } from 'node:path';
import { isInside } from './scope.ts';

export type Env = Readonly<Record<string, string | undefined>>;

// ホームの下（ファイルは名前そのもの、フォルダは中すべて）
const HOME_PATHS = [
  '.gitconfig', '.gitattributes', '.config/git', '.curlrc', '_curlrc', '.config/curlrc', '.wgetrc', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmrc', '.config/yarn', '.config/pnpm', '.config/pip', '.pip', '.pypirc',
  '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.inputrc', '.config/fish', '.config/powershell', '.jq', '.ripgreprc', '.cargo/config', '.cargo/config.toml',
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
  out.push(...POSIX_SYSTEM, ...windowsSystem(env));
  return out;
}

// どこにあっても、この名前のファイルは PowerShell のプロファイル（読み込まれるたびに動く）
const PROFILE_NAME = /^(?:microsoft\.powershell_profile|microsoft\.vscode_profile|microsoft\.powershellise_profile)\.ps1$/iu;

export function isToolConfigPath(abs: string, env: Env = process.env): boolean {
  const name = abs.split(/[\\/]/u).pop() ?? '';
  if (PROFILE_NAME.test(name)) return true;
  return toolConfigPaths(env).some(p => isInside(p, abs));
}

// フォルダの下に、ツールの設定ファイルがある（そのフォルダごと書く・消すと、設定まで届く）
export function containsToolConfig(dir: string, env: Env = process.env): boolean {
  return toolConfigPaths(env).some(p => isInside(dir, p));
}
