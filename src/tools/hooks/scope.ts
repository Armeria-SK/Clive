import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

export function expandPath(input: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Expanded {
  let p = input.replace(/^["']|["']$/gu, '');
  if (/\$\(|`|<\(|>\(/u.test(p)) return { unresolved: 'コマンド置換を含んでいます' };
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = join(homedir(), p.slice(2));
  else if (/^~[A-Za-z]/u.test(p)) return { unresolved: '別のユーザーのホームフォルダです' };
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
  if (unknown !== undefined) return { unresolved: `中身が分からない環境変数 ${unknown} を含んでいます` };
  if (/[*?[\]{}]/u.test(p)) {
    const parts = p.split(/[\\/]/u);
    const first = parts.findIndex(part => /[*?[\]{}]/u.test(part));
    if (parts.slice(first).some(part => part === '..')) return { unresolved: 'glob の後ろに .. があります' };
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

export function windowsHazard(p: string): string | undefined {
  if (/^\\\\[?.]\\/u.test(p)) return '\\\\?\\ や \\\\.\\ で始まるパスは扱いません';
  const withoutDrive = p.replace(/^[A-Za-z]:/u, '');
  if (withoutDrive.includes(':')) return 'NTFS の代替データストリーム（: を含むパス）は扱いません';
  if (p.split(/[\\/]/u).some(part => DEVICE_NAMES.test(part))) return 'デバイス名（CON・NUL など）は扱いません';
  return undefined;
}

export function isSecretPath(abs: string): boolean {
  const normalized = abs.replace(/\\/gu, '/');
  return SECRET_PATTERNS.some(re => re.test(normalized));
}

export interface ScopePolicy {
  roots: ResolvedRoot[];
  deny: string[];
  askOnWrite?: string[];
}

export function needsWriteApproval(abs: string, policy: ScopePolicy): boolean {
  const real = realish(abs);
  return (policy.askOnWrite ?? []).some(p => isInside(p, real) || isInside(p, abs));
}

export type Placement =
  | { kind: 'deny'; reason: string }
  | { kind: 'inside'; mode: RootMode; root: string }
  | { kind: 'outside' };

export function placePath(abs: string, policy: ScopePolicy): Placement {
  const hazard = windowsHazard(abs);
  if (hazard) return { kind: 'deny', reason: hazard };
  const real = realish(abs);
  if (isSecretPath(real) || isSecretPath(abs)) return { kind: 'deny', reason: `秘密情報らしいパスです（${abs}）` };
  for (const d of policy.deny) {
    if (isInside(d, real) || isInside(d, abs)) return { kind: 'deny', reason: `拒否リストのパスです（${d}）` };
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
