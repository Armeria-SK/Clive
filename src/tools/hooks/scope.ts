import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_LANGUAGE, type Language } from '../../config/schema.ts';
import { guardText } from '../../shared/messages/guard.ts';
import { insideGitDir } from './git-repo.ts';

export type RootMode = 'read' | 'write';
export interface ResolvedRoot { path: string; mode: RootMode }

const WINDOWS = process.platform === 'win32';

const KNOWN_VARS = ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'PWD'] as const;

const SECRET_PATTERNS = [
  /(?:^|\/)\.env(?:\.[^/]*)?$/iu,
  /\.(?:pem|key|p12|pfx|keystore|jks)$/iu,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/iu,
  /(?:^|\/)secrets?\//iu,
  /(?:^|\/)\.(?:ssh|aws|gnupg|docker|kube)(?:\/|$)/iu,
  /(?:^|\/)\.(?:netrc|npmrc|pypirc|git-credentials)$/iu,
];

const DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export type Expanded = { path: string } | { unresolved: string };

export function expandPath(input: string, cwd: string, env: NodeJS.ProcessEnv = process.env, language: Language = DEFAULT_LANGUAGE): Expanded {
  let p = input.replace(/^["']|["']$/gu, '');
  if (/\$\(|`|<\(|>\(/u.test(p)) return { unresolved: guardText(language, 'scope.cmd_subst') };
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = join(homedir(), p.slice(2));
  else if (/^~[A-Za-z]/u.test(p)) return { unresolved: guardText(language, 'scope.other_home') };
  let unknown: string | undefined;
  const lookup = (name: string): string => {
    const upper = name.toUpperCase();
    const known = (KNOWN_VARS as readonly string[]).includes(upper);
    const value = known ? (upper === 'HOME' ? env.HOME ?? env.USERPROFILE ?? homedir() : upper === 'PWD' ? cwd : env[upper] ?? env[name]) : undefined;
    if (value === undefined) { unknown ??= name; return ''; }
    return value;
  };
  p = p
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/giu, (_, n: string) => lookup(n))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, n: string) => lookup(n))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_, n: string) => lookup(n))
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/gu, (_, n: string) => lookup(n));
  if (unknown !== undefined) return { unresolved: guardText(language, 'scope.unknown_env', { name: unknown }) };
  if (/[*?[\]{}]/u.test(p)) {
    const parts = p.split(/[\\/]/u);
    const first = parts.findIndex(part => /[*?[\]{}]/u.test(part));
    if (parts.slice(first).some(part => part === '..')) return { unresolved: guardText(language, 'scope.glob_dotdot') };
    p = parts.slice(0, first).join('/') || '.';
  }
  return { path: resolve(cwd, p) };
}

export function realish(abs: string): string {
  let current = abs;
  const rest: string[] = [];
  for (;;) {
    if (existsSync(current)) {
      try { return join(realpathSync.native(current), ...rest.reverse()); } catch { return abs; }
    }
    const parent = dirname(current);
    if (parent === current) return abs;
    rest.push(basename(current));
    current = parent;
  }
}

const fold = (p: string) => (WINDOWS ? p.toLowerCase() : p);

export function isInside(root: string, target: string): boolean {
  const rel = relative(fold(root), fold(target));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function windowsHazard(p: string, language: Language = DEFAULT_LANGUAGE): string | undefined {
  if (/^\\\\[?.]\\/u.test(p)) return guardText(language, 'scope.hazard_prefix');
  const withoutDrive = p.replace(/^[A-Za-z]:/u, '');
  if (withoutDrive.includes(':')) return guardText(language, 'scope.hazard_stream');
  if (p.split(/[\\/]/u).some(part => DEVICE_NAMES.test(part))) return guardText(language, 'scope.hazard_device');
  return undefined;
}

export function isSecretPath(abs: string): boolean {
  const normalized = abs.replace(/\\/gu, '/');
  return SECRET_PATTERNS.some(re => re.test(normalized));
}

export interface ScopePolicy {
  roots: ResolvedRoot[];
  deny: string[];
  // 書き込む前に承認を求める場所（人格・プロフィール・スキルのフォルダ）。.git の段があるパスは、ここに無くても同じに扱う
  askOnWrite?: string[];
  // askOnWrite のうち、スキルのフォルダ（理由の文を分けるため）
  skillsDir?: string;
  language?: Language;
}

// 書き込む前に承認を求める場所の種類。persona: SOUL.md・USER.md、skill: workspace/skills/、git: .git の段があるパス（フックや設定でコマンドを動かせる）
export type ProtectedKind = 'persona' | 'skill' | 'git';

const hasGitSegment = (p: string): boolean => p.split(/[\\/]/u).some(part => fold(part) === '.git');

export function writeApprovalKind(abs: string, policy: ScopePolicy): ProtectedKind | undefined {
  const real = realish(abs);
  if (hasGitSegment(abs) || hasGitSegment(real) || insideGitDir(abs) || insideGitDir(real)) return 'git';
  if (policy.skillsDir && (isInside(policy.skillsDir, real) || isInside(policy.skillsDir, abs))) return 'skill';
  return (policy.askOnWrite ?? []).some(p => isInside(p, real) || isInside(p, abs)) ? 'persona' : undefined;
}

export function needsWriteApproval(abs: string, policy: ScopePolicy): boolean {
  return writeApprovalKind(abs, policy) !== undefined;
}

export type Placement =
  | { kind: 'deny'; reason: string }
  | { kind: 'inside'; mode: RootMode; root: string }
  | { kind: 'outside' };

export function placePath(abs: string, policy: ScopePolicy): Placement {
  const language = policy.language ?? DEFAULT_LANGUAGE;
  const hazard = windowsHazard(abs, language);
  if (hazard) return { kind: 'deny', reason: hazard };
  const real = realish(abs);
  if (isSecretPath(real) || isSecretPath(abs)) return { kind: 'deny', reason: guardText(language, 'scope.secret', { path: abs }) };
  for (const d of policy.deny) {
    if (isInside(d, real) || isInside(d, abs)) return { kind: 'deny', reason: guardText(language, 'scope.deny_list', { path: d }) };
  }
  let best: ResolvedRoot | undefined;
  for (const root of policy.roots) {
    if (isInside(root.path, real) && (!best || root.path.length > best.path.length)) best = root;
  }
  return best ? { kind: 'inside', mode: best.mode, root: best.path } : { kind: 'outside' };
}

export function resolveConfigPath(p: string, base: string): string {
  const expanded = p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(2)) : p;
  return realish(resolve(base, expanded));
}
