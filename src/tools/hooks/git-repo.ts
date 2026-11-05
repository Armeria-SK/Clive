// git のリポジトリの設定を調べる（security-self-api.md §11.3.3）。git は起こさず、ファイルを読むだけ。
// 設定の項目がすべて「ふつうの設定」の一覧に入っていなければ、そのリポジトリでの git はすべて今回だけ（設定でコードを動かせるため）。

import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, statSync } from 'node:fs';
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
const PLAIN_CORE = new Set(['repositoryformatversion', 'filemode', 'bare', 'logallrefupdates', 'symlinks', 'ignorecase', 'precomposeunicode', 'autocrlf', 'eol', 'safecrlf', 'longpaths', 'hookspath']);
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
interface Found { gitDir: string; commonDir: string; broken?: boolean }

const MAX_ADMIN_FILE = 4096;

// git のフォルダの中の commondir・gitdir ファイルの中身。git と同じに、末尾の改行と CR だけを落とす（空白・NBSP は落とさない。落とすと、git が使わないフォルダを使うことになる）。
// 無ければ undefined、あるのに読めない・大きすぎる・空・途中に改行や NUL があるなら null
function adminFile(dir: string, name: string): string | undefined | null {
  const file = join(dir, name);
  let st;
  try { st = lstatSync(file); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR' ? undefined : null; }
  if (!st.isFile() || st.size > MAX_ADMIN_FILE) return null;
  try {
    const text = readFileSync(file, 'utf8').replace(/[\r\n]+$/u, '');
    return text === '' || /[\r\n\0]/u.test(text) ? null : text;
  } catch { return null; }
}

// フォルダ / フォルダでない（ファイルなど、調べられないものも含む）/ 無い
function kindOf(p: string): 'dir' | 'other' | 'none' {
  try { return statSync(p).isDirectory() ? 'dir' : 'other'; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'none' : 'other';
  }
}

type Examined = { state: 'no' } | { state: 'ok'; commonDir: string } | { state: 'broken' };

// git の validate_headref と同じ（refs.c）: HEAD が refs/ へのシンボリックリンク、`ref:` のあと（git の isspace: 空白・タブ・改行・CR だけ。垂直タブとフォームフィードは空白ではない）を読み飛ばして refs/、または先頭が 40 桁以上の 16 進数。
// none: HEAD が無い。invalid: あるが git は認めない
function headState(p: string): 'none' | 'valid' | 'invalid' {
  const file = join(p, 'HEAD');
  let st;
  try { st = lstatSync(file); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR' ? 'none' : 'invalid'; }
  try {
    if (st.isSymbolicLink()) return readlinkSync(file).startsWith('refs/') ? 'valid' : 'invalid';
    if (!st.isFile()) return 'invalid';
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(255);
      const head = buffer.toString('latin1', 0, readSync(fd, buffer, 0, buffer.length, 0));
      return /^ref:[ \t\n\r]*refs\//u.test(head) || /^[0-9A-Fa-f]{40}/u.test(head) ? 'valid' : 'invalid';
    } finally { closeSync(fd); }
  } catch { return 'invalid'; }
}

// git の is_git_directory と同じ: HEAD があり（validate_headref を通り）、objects/ と refs/ が（commondir があればその先に）ある。commondir・gitdir が読めないときは broken（今回だけ）。
// objects/ と refs/ があるのに HEAD を git が認めないフォルダは、git は飛ばして上を使うが、git の版で認める範囲が変わりうるので broken（今回だけ）にする
function examine(p: string): Examined {
  const head = headState(p);
  if (head === 'none') return { state: 'no' };
  const commondir = adminFile(p, 'commondir');
  if (commondir === null || adminFile(p, 'gitdir') === null) return { state: 'broken' };
  const commonDir = commondir === undefined ? p : isAbsolute(commondir) ? commondir : resolve(p, commondir);
  const objects = kindOf(join(commonDir, 'objects'));
  const refs = kindOf(join(commonDir, 'refs'));
  if (objects === 'dir' && refs === 'dir') return head === 'valid' ? { state: 'ok', commonDir } : { state: 'broken' };
  // git は objects/・refs/ を access() で見るだけなので、Windows ではファイルでも git のフォルダになる。フォルダでないものがあれば broken（今回だけ）
  if (objects === 'other' || refs === 'other') return { state: 'broken' };
  return commondir === undefined ? { state: 'no' } : { state: 'broken' };
}

// git の read_gitfile と同じ: 先頭が「gitdir: 」（空白 1 つ）で、そのあと全部（末尾の改行と CR は落とす）が場所。違う書き方は broken（今回だけ）
function viaGitFile(file: string): Found {
  try {
    const broken: Found = { gitDir: dirname(file), commonDir: dirname(file), broken: true };
    if (statSync(file).size > MAX_ADMIN_FILE) return broken;
    const text = readFileSync(file, 'utf8');
    if (!text.startsWith('gitdir: ')) return broken;
    const place = text.slice(8).replace(/[\r\n]+$/u, '');
    if (place === '' || /[\r\n\0]/u.test(place)) return broken;
    const target = isAbsolute(place) ? place : resolve(dirname(file), place);
    const e = examine(target);
    return e.state === 'ok' ? { gitDir: target, commonDir: e.commonDir } : { gitDir: target, commonDir: target, broken: true };
  } catch { return { gitDir: dirname(file), commonDir: dirname(file), broken: true }; }
}

export function findGitDir(start: string): Found | null {
  let dir = resolve(start);
  for (let depth = 0; depth < 64; depth++) {
    const dotGit = join(dir, '.git');
    if (isFile(dotGit)) return viaGitFile(dotGit);
    if (isDir(dotGit)) {
      const inner = examine(dotGit);
      if (inner.state === 'ok') return { gitDir: dotGit, commonDir: inner.commonDir };
      if (inner.state === 'broken') return { gitDir: dotGit, commonDir: dotGit, broken: true };
    }
    const here = examine(dir);
    if (here.state === 'ok') return { gitDir: dir, commonDir: here.commonDir };
    if (here.state === 'broken') return { gitDir: dir, commonDir: dir, broken: true };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  // 深さの上限に着いた: 上にあるかもしれないリポジトリを見ていないので、「なし」ではなく broken（今回だけ）
  return { gitDir: dir, commonDir: dir, broken: true };
}

export function inspectRepo(start: string): RepoInfo {
  const none: RepoInfo = { found: false, configOk: true, badKey: '', unreadable: false, hooksPath: false, hooksFiles: false };
  const found = findGitDir(start);
  if (!found) return none;
  if (found.broken) return { ...none, found: true, unreadable: true };
  const commonDir = found.commonDir;
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
