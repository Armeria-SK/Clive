// パスの調べの部品（security-self-api.md §11.4）: ワイルドカードを今あるファイルに展開する・フォルダの中に守る場所があるかを調べる。

import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { isGitDir } from './git-repo.ts';
import { isInside, isRemotePath, isSecretPath, writeApprovalKind, type ProtectedKind, type ScopePolicy } from './scope.ts';

export const GLOB_CAP = 2000;
const WALK_DEPTH = 6;
const WALK_CAP = 4000;
const WILD = /[*?[{]/u;
const WINDOWS = process.platform === 'win32';

// ネットワーク・デバイスのパス（scope.ts の isRemotePath）には触れない。止める側が先に止めるが、SMB の応答待ちで調べが止まらないように
export const isDirectory = (p: string): boolean => { if (isRemotePath(p)) return false; try { return statSync(p).isDirectory(); } catch { return false; } };
export const exists = (p: string): boolean => { if (isRemotePath(p)) return false; try { statSync(p); return true; } catch { return false; } };

// {a,b} の 1 段だけ展開する（入れ子・{1..3} は展開しない）。展開できない形は null
function braces(text: string, budget = 64): string[] | null {
  const open = text.indexOf('{');
  if (open < 0) return [text];
  const close = text.indexOf('}', open);
  if (close < 0) return null;
  const inner = text.slice(open + 1, close);
  if (inner.includes('{') || inner.includes('..') || !inner.includes(',')) return null;
  const out: string[] = [];
  for (const alt of inner.split(',')) {
    const rest = braces(`${text.slice(0, open)}${alt}${text.slice(close + 1)}`, budget);
    if (!rest) return null;
    out.push(...rest);
    if (out.length > budget) return null;
  }
  return out;
}

// powershell: PowerShell のワイルドカード。[..] の中の ^ と ! は否定ではなく、ただの文字（本物の PowerShell 5.1 で、[^x] は ^ と x のどちらかに当たると確かめた）
function segmentRegex(seg: string, caseFold: boolean, powershell: boolean): RegExp {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]!;
    if (ch === '*') re += '[^\\\\/]*';
    else if (ch === '?') re += '[^\\\\/]';
    else if (ch === '[') {
      const end = seg.indexOf(']', i + 2);
      if (end < 0) { re += '\\['; continue; }
      let body = seg.slice(i + 1, end).replace(/\\/gu, '\\\\');
      if (powershell) body = body.replace(/\^/gu, '\\^');
      else if (body.startsWith('!')) body = `^${body.slice(1)}`;
      re += `[${body}]`;
      i = end;
    } else re += ch.replace(/[.+^${}()|\\/]/gu, '\\$&');
  }
  return new RegExp(`^${re}$`, caseFold ? 'iu' : 'u');
}

// secret: 当たったものの中の、秘密のパス（列挙しきれなくても、上限を超えた分まで探す）
export interface Globbed { prefix: string; matches: string[]; complete: boolean; secret?: string }

// 列挙しきれないときに、秘密のパスを探すために数える名前の上限
const SCAN_CAP = 100_000;

// 絶対パスのパターン（* ? [..] {a,b}）に、今あるもののうち当たるものを列挙する。dotfiles: PowerShell のワイルドカードか（先頭が . の名前に * が当たる。[..] の中の ^ ! は文字。bash は当たらず、! は否定）
export function expandGlob(pattern: string, dotfiles: boolean): Globbed {
  if (isRemotePath(pattern)) return { prefix: pattern, matches: [], complete: false };
  const alternatives = braces(pattern);
  const first = pattern.split(/[\\/]/u);
  const prefixSegs: string[] = [];
  for (const seg of first) { if (WILD.test(seg)) break; prefixSegs.push(seg); }
  const prefix = prefixSegs.join(sep) || sep;
  if (!alternatives) return { prefix, matches: [], complete: false };
  const matches: string[] = [];
  let secret: string | undefined;
  let scanned = 0;
  const found = (): { secret?: string } => (secret === undefined ? {} : { secret });
  for (const alt of alternatives) {
    const segs = alt.split(/[\\/]/u);
    const at = segs.findIndex(s => /[*?[]/u.test(s));
    if (at < 0) { if (exists(alt)) matches.push(alt); continue; }
    let level = [segs.slice(0, at).join(sep) || sep];
    for (const [index, seg] of segs.slice(at).entries()) {
      if (seg === '**') return { prefix, matches, complete: false, ...found() };
      const next: string[] = [];
      let overflow = false;
      if (/[*?[]/u.test(seg)) {
        const re = segmentRegex(seg, WINDOWS, dotfiles);
        scan: for (const dir of level) {
          let names: string[];
          try { names = readdirSync(dir); } catch { continue; }
          for (const name of names) {
            if (name.startsWith('.') && !dotfiles && !seg.startsWith('.')) continue;
            if (re.test(name)) {
              const full = join(dir, name);
              if (secret === undefined && isSecretPath(full)) secret = full;
              // 上限を超えても、秘密のパスを探すために、名前を数え続ける（一覧には足さない）
              if (next.length < GLOB_CAP) next.push(full); else overflow = true;
            }
            if (++scanned > SCAN_CAP) { overflow = true; break scan; }
          }
        }
      } else for (const dir of level) next.push(join(dir, seg));
      if (overflow) return { prefix, matches: at + index === segs.length - 1 ? [...matches, ...next] : matches, complete: false, ...found() };
      level = next;
    }
    for (const m of level) if (exists(m)) matches.push(m);
    if (matches.length > GLOB_CAP) return { prefix, matches: matches.slice(0, GLOB_CAP), complete: false, ...found() };
  }
  return { prefix, matches, complete: true, ...found() };
}

const LIST_CAP = 20_000;

// PowerShell のワイルドカードを、名前 1 つに当てる（大文字小文字は、Windows では区別しない）
export function wildcardMatches(name: string, pattern: string): boolean {
  return segmentRegex(pattern, WINDOWS, true).test(name);
}

// フォルダの中身（deep なら下の階層まで）の一覧。幅優先で、上限を超えたら途中まで返して complete: false。入れないフォルダ・たどれないリンクがあっても complete: false
// skipHidden: 「.」で始まる名前は、一覧にも入れず、その下へも入らず、秘密を探すときにも数えない（rg が既定で読まないもの）
export function listTree(dir: string, deep: boolean, cap = LIST_CAP, skipHidden = false): { entries: string[]; complete: boolean; secret?: string } {
  if (isRemotePath(dir)) return { entries: [], complete: false };
  const entries: string[] = [];
  const queue = [dir];
  let complete = true;
  let secret: string | undefined;
  let scanned = 0;
  const result = (): { entries: string[]; complete: boolean; secret?: string } => ({ entries, complete, ...(secret === undefined ? {} : { secret }) });
  while (queue.length) {
    const current = queue.shift()!;
    let items: import('node:fs').Dirent[];
    try { items = readdirSync(current, { withFileTypes: true }); } catch { complete = false; continue; }
    for (const item of items) {
      if (skipHidden && item.name.startsWith('.')) continue;
      const full = join(current, item.name);
      if (secret === undefined && isSecretPath(full)) secret = full;
      // 上限を超えても、秘密のパスを探すために、名前を数え続ける（一覧には足さない）
      if (entries.length < cap) entries.push(full);
      if (entries.length >= cap) complete = false;
      if (++scanned > SCAN_CAP) { complete = false; return result(); }
      if (!deep) continue;
      if (item.isSymbolicLink()) { if (isDirectory(full)) complete = false; continue; }
      if (item.isDirectory()) queue.push(full);
    }
  }
  return result();
}

// フォルダの下（そのフォルダ自身も）に、.git という名前のものか、git のフォルダ（HEAD・objects/・refs/ がある。.git でない名前の裏のリポジトリ）があるか（深さと件数に上限。超えたら「ある」とみなす）
export function containsGitDir(dir: string): boolean {
  if (isRemotePath(dir)) return true;
  let seen = 0;
  const fold = (s: string): string => (WINDOWS ? s.toLowerCase() : s);
  const walk = (current: string, depth: number): boolean => {
    if (isGitDir(current)) return true;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (++seen > WALK_CAP) return true;
      if (fold(entry.name) === '.git') return true;
      if (entry.isDirectory() && !entry.isSymbolicLink() && depth < WALK_DEPTH) {
        try { if (lstatSync(join(current, entry.name)).isSymbolicLink()) continue; } catch { continue; }
        if (walk(join(current, entry.name), depth + 1)) return true;
      }
    }
    return false;
  };
  return walk(dir, 0);
}

// フォルダが守る場所（人格・スキル・.git）の親・先祖か（そのフォルダに書く・消すと、守る場所まで届く）。届くなら その種類
export function protectedInside(dir: string, policy: ScopePolicy): ProtectedKind | undefined {
  const root = resolve(dir);
  for (const place of [...(policy.askOnWrite ?? []), ...(policy.skillsDir ? [policy.skillsDir] : [])]) {
    if (isInside(root, place)) return writeApprovalKind(place, policy) ?? 'persona';
  }
  return isDirectory(root) && containsGitDir(root) ? 'git' : undefined;
}
