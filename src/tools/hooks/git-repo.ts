// git のリポジトリの設定を調べる（security-self-api.md §11.3.3）。git は起こさず、ファイルを読むだけ。
// 設定の項目がすべて「ふつうの設定」の一覧に入っていなければ、そのリポジトリでの git はすべて今回だけ（設定でコードを動かせるため）。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { RepoInfo } from './allowlist-core.ts';

export interface ConfigEntry { key: string; value: string }

const MAX_CONFIG_BYTES = 1_048_576;

// ── 設定ファイルの読み取り（git config の書式）──
export function parseGitConfig(source: string): ConfigEntry[] | null {
  const text = source.replace(/^﻿/u, '');
  const entries: ConfigEntry[] = [];
  let section = '';
  let sub: string | null = null;
  let i = 0;
  const n = text.length;
  const isSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\r';
  while (i < n) {
    while (i < n && (isSpace(text[i]) || text[i] === '\n')) i++;
    if (i >= n) break;
    if (text[i] === '#' || text[i] === ';') { while (i < n && text[i] !== '\n') i++; continue; }
    if (text[i] === '[') {
      i++;
      let name = '';
      while (i < n && /[A-Za-z0-9.-]/u.test(text[i]!)) name += text[i++];
      if (!name) return null;
      sub = null;
      if (name.includes('.')) {
        const dot = name.indexOf('.');
        sub = name.slice(dot + 1).toLowerCase();
        name = name.slice(0, dot);
      } else if (isSpace(text[i])) {
        while (isSpace(text[i])) i++;
        if (text[i] !== '"') return null;
        i++;
        let s = '';
        for (;;) {
          if (i >= n || text[i] === '\n') return null;
          if (text[i] === '"') { i++; break; }
          if (text[i] === '\\') { i++; if (i >= n || text[i] === '\n') return null; }
          s += text[i++];
        }
        sub = s;
      }
      if (text[i] !== ']') return null;
      i++;
      section = name.toLowerCase();
      continue;
    }
    if (!section) return null;
    let name = '';
    if (!/[A-Za-z]/u.test(text[i]!)) return null;
    while (i < n && /[A-Za-z0-9-]/u.test(text[i]!)) name += text[i++];
    while (isSpace(text[i])) i++;
    let value = '';
    if (text[i] === '=') {
      i++;
      while (isSpace(text[i])) i++;
      let quoted = false;
      for (;;) {
        if (i >= n) break;
        const ch = text[i]!;
        if (ch === '\n') { if (quoted) return null; break; }
        if (ch === '\\') {
          const next = text[i + 1];
          if (next === '\n') { i += 2; continue; }
          if (next === '\r' && text[i + 2] === '\n') { i += 3; continue; }
          if (next === undefined || !'ntb\\"'.includes(next)) return null;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'b' ? '\b' : next;
          i += 2;
          continue;
        }
        if (ch === '"') { quoted = !quoted; i++; continue; }
        if (!quoted && (ch === '#' || ch === ';')) { while (i < n && text[i] !== '\n') i++; break; }
        value += ch; i++;
      }
      value = value.replace(/[ \t\r]+$/u, '');
    } else if (i < n && text[i] !== '\n' && text[i] !== '#' && text[i] !== ';') return null;
    entries.push({ key: sub === null ? `${section}.${name.toLowerCase()}` : `${section}.${sub}.${name.toLowerCase()}`, value });
  }
  return entries;
}

// ── ふつうの設定の一覧 ──
const PLAIN_CORE = new Set(['repositoryformatversion', 'filemode', 'bare', 'logallrefupdates', 'symlinks', 'ignorecase', 'precomposeunicode', 'autocrlf', 'eol', 'safecrlf', 'longpaths', 'worktree', 'hookspath']);
const PLAIN_BY_SUB: Record<string, ReadonlySet<string>> = {
  remote: new Set(['url', 'fetch', 'pushurl', 'tagopt', 'prune']),
  branch: new Set(['remote', 'merge', 'rebase', 'pushremote']),
  submodule: new Set(['url', 'active']),
};
const PLAIN_WHOLE = new Set(['gc', 'color', 'i18n', 'log', 'status', 'advice', 'extensions']);
const PLAIN_PLAIN: Record<string, ReadonlySet<string>> = {
  user: new Set(['name', 'email']),
  init: new Set(['defaultbranch']),
  pull: new Set(['rebase', 'ff']),
  push: new Set(['default', 'autosetupremote']),
  fetch: new Set(['prune']),
  lfs: new Set(['repositoryformatversion']),
};
// remote.<名前>.url が transport helper（ext::sh -c … など）のとき、押す・取るでコードが動く
const HELPER_URL = /^[A-Za-z0-9_.+-]+::/u;

// ふつうでない項目の名前を返す（無ければ null）
export function unusualKey(entries: readonly ConfigEntry[]): string | null {
  for (const { key, value } of entries) {
    const parts = key.split('.');
    const section = parts[0]!;
    const name = parts.at(-1)!;
    const plain = parts.length === 2
      ? (section === 'core' ? PLAIN_CORE.has(name) : PLAIN_WHOLE.has(section) || (PLAIN_PLAIN[section]?.has(name) ?? false))
      : (PLAIN_BY_SUB[section]?.has(name) ?? (PLAIN_WHOLE.has(section) && section !== 'extensions'));
    if (!plain) return key;
    if (section === 'remote' && parts.length > 2 && (name === 'url' || name === 'pushurl') && (HELPER_URL.test(value.trim()) || value.trim().startsWith('-'))) return `${key} = ${value.slice(0, 20)}`;
  }
  return null;
}

// ── リポジトリの見つけ方（git と同じ: 各階層で .git → その階層自身が裸のリポジトリ → 上）──
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };
const isGitDir = (p: string): boolean => isFile(join(p, 'HEAD')) && isDir(join(p, 'objects')) && isDir(join(p, 'refs'));

interface Found { gitDir: string; broken?: boolean }

function viaGitFile(file: string): Found {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/u.exec(readFileSync(file, 'utf8').split('\n')[0] ?? '');
    if (!m) return { gitDir: dirname(file), broken: true };
    const target = isAbsolute(m[1]!) ? m[1]! : resolve(dirname(file), m[1]!);
    return isGitDir(target) ? { gitDir: target } : { gitDir: target, broken: true };
  } catch { return { gitDir: dirname(file), broken: true }; }
}

export function findGitDir(start: string): Found | null {
  let dir = resolve(start);
  for (let depth = 0; depth < 64; depth++) {
    const dotGit = join(dir, '.git');
    if (isFile(dotGit)) return viaGitFile(dotGit);
    if (isDir(dotGit) && isGitDir(dotGit)) return { gitDir: dotGit };
    if (isGitDir(dir)) return { gitDir: dir };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function commonDirOf(gitDir: string): string {
  try {
    const rel = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    if (rel) return isAbsolute(rel) ? rel : resolve(gitDir, rel);
  } catch { /* commondir が無ければ gitDir 自身 */ }
  return gitDir;
}

export function inspectRepo(start: string): RepoInfo {
  const none: RepoInfo = { found: false, configOk: true, badKey: '', unreadable: false, hooksPath: false, hooksFiles: false };
  const found = findGitDir(start);
  if (!found) return none;
  if (found.broken) return { ...none, found: true, unreadable: true };
  const commonDir = commonDirOf(found.gitDir);
  const files = [...new Set([join(commonDir, 'config'), join(found.gitDir, 'config'), join(found.gitDir, 'config.worktree'), join(commonDir, 'config.worktree')])];
  const entries: ConfigEntry[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return { ...none, found: true, unreadable: true };
      const parsed = parseGitConfig(readFileSync(file, 'utf8'));
      if (!parsed) return { ...none, found: true, unreadable: true };
      entries.push(...parsed);
    } catch { return { ...none, found: true, unreadable: true }; }
  }
  const bad = unusualKey(entries);
  let hooksFiles = false;
  try { hooksFiles = readdirSync(join(commonDir, 'hooks')).some(name => !name.endsWith('.sample')); } catch { /* hooks フォルダが無い */ }
  return {
    found: true, configOk: bad === null, badKey: bad ?? '', unreadable: false,
    hooksPath: entries.some(e => e.key === 'core.hookspath'), hooksFiles,
  };
}
