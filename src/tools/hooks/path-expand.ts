// パスの調べの部品（security-self-api.md §11.4）: ワイルドカードを今あるファイルに展開する・フォルダの中に守る場所があるかを調べる。

import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { isInside, writeApprovalKind, type ProtectedKind, type ScopePolicy } from './scope.ts';

export const GLOB_CAP = 2000;
const WALK_DEPTH = 6;
const WALK_CAP = 4000;
const WILD = /[*?[{]/u;
const WINDOWS = process.platform === 'win32';

export const isDirectory = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
export const exists = (p: string): boolean => { try { statSync(p); return true; } catch { return false; } };

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

export interface Globbed { prefix: string; matches: string[]; complete: boolean }

// 絶対パスのパターン（* ? [..] {a,b}）に、今あるもののうち当たるものを列挙する。dotfiles: PowerShell のワイルドカードか（先頭が . の名前に * が当たる。[..] の中の ^ ! は文字。bash は当たらず、! は否定）
export function expandGlob(pattern: string, dotfiles: boolean): Globbed {
  const alternatives = braces(pattern);
  const first = pattern.split(/[\\/]/u);
  const prefixSegs: string[] = [];
  for (const seg of first) { if (WILD.test(seg)) break; prefixSegs.push(seg); }
  const prefix = prefixSegs.join(sep) || sep;
  if (!alternatives) return { prefix, matches: [], complete: false };
  const matches: string[] = [];
  for (const alt of alternatives) {
    const segs = alt.split(/[\\/]/u);
    const at = segs.findIndex(s => /[*?[]/u.test(s));
    if (at < 0) { if (exists(alt)) matches.push(alt); continue; }
    let level = [segs.slice(0, at).join(sep) || sep];
    for (const seg of segs.slice(at)) {
      if (seg === '**') return { prefix, matches, complete: false };
      const next: string[] = [];
      if (/[*?[]/u.test(seg)) {
        const re = segmentRegex(seg, WINDOWS, dotfiles);
        for (const dir of level) {
          let names: string[];
          try { names = readdirSync(dir); } catch { continue; }
          for (const name of names) {
            if (name.startsWith('.') && !dotfiles && !seg.startsWith('.')) continue;
            if (re.test(name)) next.push(join(dir, name));
            if (next.length > GLOB_CAP) return { prefix, matches, complete: false };
          }
        }
      } else for (const dir of level) next.push(join(dir, seg));
      level = next;
    }
    for (const m of level) if (exists(m)) matches.push(m);
    if (matches.length > GLOB_CAP) return { prefix, matches: matches.slice(0, GLOB_CAP), complete: false };
  }
  return { prefix, matches, complete: true };
}

const LIST_CAP = 20_000;

// PowerShell のワイルドカードを、名前 1 つに当てる（大文字小文字は、Windows では区別しない）
export function wildcardMatches(name: string, pattern: string): boolean {
  return segmentRegex(pattern, WINDOWS, true).test(name);
}

// フォルダの中身（deep なら下の階層まで）の一覧。幅優先で、上限を超えたら途中まで返して complete: false。入れないフォルダ・たどれないリンクがあっても complete: false
export function listTree(dir: string, deep: boolean, cap = LIST_CAP): { entries: string[]; complete: boolean } {
  const entries: string[] = [];
  const queue = [dir];
  let complete = true;
  while (queue.length) {
    const current = queue.shift()!;
    let items: import('node:fs').Dirent[];
    try { items = readdirSync(current, { withFileTypes: true }); } catch { complete = false; continue; }
    for (const item of items) {
      const full = join(current, item.name);
      entries.push(full);
      if (entries.length >= cap) return { entries, complete: false };
      if (!deep) continue;
      if (item.isSymbolicLink()) { if (isDirectory(full)) complete = false; continue; }
      if (item.isDirectory()) queue.push(full);
    }
  }
  return { entries, complete };
}

// フォルダの下に .git という名前のものがあるか（深さと件数に上限。超えたら「ある」とみなす）
export function containsDotGit(dir: string): boolean {
  let seen = 0;
  const fold = (s: string): string => (WINDOWS ? s.toLowerCase() : s);
  const walk = (current: string, depth: number): boolean => {
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
  return isDirectory(root) && containsDotGit(root) ? 'git' : undefined;
}
