// パスの調べの部品（security-self-api.md §11.4）: ワイルドカードを今あるファイルに展開する・フォルダの中に守る場所があるかを調べる。

import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { isGitDir } from './git-repo.ts';
import { inDependencies, isInside, isRemotePath, isSecretPath, writeApprovalKind, type ProtectedKind, type ScopePolicy, type SecretScope } from './scope.ts';

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
// 答え合わせ用に残した、正規表現に直す古い作り（tests/shell-wildcard.test.ts が compileWildcard と比べる）。* が並ぶと指数回バックトラックするので、本番では使わない
export function segmentRegex(seg: string, caseFold: boolean, powershell: boolean): RegExp {
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

type CharTest = (ch: string) => boolean;
export type Wildcard = (name: string) => boolean;

const NOT_SEP: CharTest = ch => ch !== '/' && ch !== '\\';

// 1 文字の比べは 1 文字だけの正規表現（戻り読みが起きない）に任せ、大文字小文字の畳み込みを segmentRegex と同じにする
function literalTest(ch: string, caseFold: boolean): CharTest {
  if (!caseFold) return c => c === ch;
  const re = new RegExp(`^${ch.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}$`, 'iu');
  return c => c === ch || re.test(c);
}

// [..] の中身（[ と ] の間）。見慣れた形（文字・a-z の範囲・先頭か末尾の -・bash の先頭の ! ^ による否定）だけ受け取り、それ以外は null（分からない）
function classTest(body: string[], caseFold: boolean, powershell: boolean): CharTest | null {
  const negate = !powershell && (body[0] === '!' || body[0] === '^');
  const items = negate ? body.slice(1) : body;
  if (items.length === 0 || items.some(c => c === '\\' || c === '[' || c === ']')) return null;
  if (items[0] === ':' && items[items.length - 1] === ':') return null;
  for (let k = 0; k < items.length; k++) {
    if (items[k] === '-') { if (k === 0 || k === items.length - 1) continue; return null; }
    if (items[k + 1] === '-' && k + 2 < items.length) {
      if (items[k + 2] === '-' || items[k + 3] === '-') return null;
      k += 2;
    }
  }
  try {
    const re = new RegExp(`[${negate ? '^' : ''}${items.map(c => (c === '^' ? '\\^' : c)).join('')}]`, caseFold ? 'iu' : 'u');
    return c => re.test(c);
  } catch { return null; }
}

type Token = CharTest | null;
// [ から数えて、その [..] の終わりの ] の位置（無ければ -1）
type ClassEnd = (chars: string[], at: number) => number;

// segmentRegex・compileWildcard の読み方: [ の 2 つあとから数えて最初の ]
const firstClose: ClassEnd = (chars, at) => chars.indexOf(']', at + 2);

// bash の読み方: 先頭の ! ^ のあとの最初の ] は文字。[:名前:] [.x.] [=x=] の中の ] は数えない
const bashClose: ClassEnd = (chars, at) => {
  let j = at + 1;
  if (chars[j] === '!' || chars[j] === '^') j++;
  if (chars[j] === ']') j++;
  for (; j < chars.length; j++) {
    if (chars[j] === ']') return j;
    const kind = chars[j + 1];
    if (chars[j] === '[' && (kind === ':' || kind === '.' || kind === '=')) {
      for (let k = j + 2; k + 1 < chars.length; k++) if (chars[k] === kind && chars[k + 1] === ']') { j = k + 1; break; }
    }
  }
  return -1;
};

// 分からない形（空の [] ・先頭が ] の組・[ の入れ子・逆向きの範囲・[:alpha:]・組の中の \・組の外の ]）は null。loose を渡すと null を返さず、分からない [..] は区切りでない任意の 1 文字、組の外の ] は文字として読む
function tokenize(seg: string, caseFold: boolean, powershell: boolean, loose?: ClassEnd): Token[] | null {
  const chars = Array.from(seg);
  const tokens: Token[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === '*') tokens.push(null);
    else if (ch === '?') tokens.push(NOT_SEP);
    else if (ch === '[') {
      const end = (loose ?? firstClose)(chars, i);
      if (end < 0) { tokens.push(literalTest('[', caseFold)); continue; }
      const test = classTest(chars.slice(i + 1, end), caseFold, powershell) ?? (loose ? NOT_SEP : null);
      if (!test) return null;
      tokens.push(test);
      i = end;
    } else if (ch === ']' && !loose) return null;
    else tokens.push(literalTest(ch, caseFold));
  }
  return tokens;
}

// ワイルドカード（* ? [..]）の 1 つの名前への当てはめを、正規表現ではなく、「いまどこまで読めたか」の集合を 1 文字ずつ進める方法で行う（最悪 O(名前の長さ × パターンの長さ)。* が並んでも指数回帰しない）。
// 当たる名前は segmentRegex と同じ（文字は 1 つずつ正規表現と同じ決まりで比べる）。分からない形は null（tokenize）
export function compileWildcard(seg: string, caseFold: boolean, powershell: boolean): Wildcard | null {
  const tokens = tokenize(seg, caseFold, powershell);
  return tokens && runWildcard(tokens);
}

// compileWildcard が null を返す形のための、当たりすぎる側の照合。展開の答えには使わず、当たりうる秘密のパスを取りこぼさないために使う。
// 分からない [..] は区切りでない任意の 1 文字とみなす。[..] の終わりの読みは 2 通り（segmentRegex と同じ読み・bash の読み）あり、どちらかで当たれば当たる
export function looseWildcard(seg: string, caseFold: boolean, powershell: boolean): Wildcard {
  const readings = [firstClose, bashClose].map(endOf => runWildcard(tokenize(seg, caseFold, powershell, endOf)!));
  return name => readings.some(read => read(name));
}

function runWildcard(tokens: Token[]): Wildcard {
  const m = tokens.length;
  const fixed = tokens.filter(t => t !== null).length;
  const closeStars = (set: Uint8Array): void => { for (let j = 0; j < m; j++) if (set[j] === 1 && tokens[j] === null) set[j + 1] = 1; };
  let now = new Uint8Array(m + 1);
  let after = new Uint8Array(m + 1);
  return name => {
    const cs = Array.from(name);
    if (cs.length < fixed) return false;
    now.fill(0);
    now[0] = 1;
    closeStars(now);
    for (const ch of cs) {
      after.fill(0);
      let alive = false;
      for (let j = 0; j < m; j++) {
        if (now[j] === 0) continue;
        const token = tokens[j]!;
        if (token === null ? NOT_SEP(ch) : token(ch)) { after[token === null ? j : j + 1] = 1; alive = true; }
      }
      if (!alive) return false;
      closeStars(after);
      const spare = now; now = after; after = spare;
    }
    return now[m] === 1;
  };
}

// secret: 当たったものの中の、秘密のパス（列挙しきれなくても、上限を超えた分まで探す）
export interface Globbed { prefix: string; matches: string[]; complete: boolean; secret?: string }

// 列挙しきれないときに、秘密のパスを探すために数える名前の上限
const SCAN_CAP = 100_000;

// 絶対パスのパターン（* ? [..] {a,b}）に、今あるもののうち当たるものを列挙する。dotfiles: PowerShell のワイルドカードか（先頭が . の名前に * が当たる。[..] の中の ^ ! は文字。bash は当たらず、! は否定）
export function expandGlob(pattern: string, dotfiles: boolean, secrets: SecretScope = 'all'): Globbed {
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
  // 読み切れない形があった。当たるものは緩い照合で、実際より多めに数えている（secret・matches は多めの側。complete は false）
  let loose = false;
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
        // 分からない形の組は、当たるものを正確には数えられないので、展開しきれない扱い（呼ぶ側が確かめにする）。ただし、フォルダの中は緩い照合で探し、秘密のパスを取りこぼさない
        const exact = compileWildcard(seg, WINDOWS, dotfiles);
        if (!exact) loose = true;
        const match = exact ?? looseWildcard(seg, WINDOWS, dotfiles);
        scan: for (const dir of level) {
          let names: string[];
          try { names = readdirSync(dir); } catch { continue; }
          for (const name of names) {
            if (name.startsWith('.') && !dotfiles && !seg.startsWith('.')) continue;
            if (match(name)) {
              const full = join(dir, name);
              if (secret === undefined && isSecretPath(full, secrets)) secret = full;
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
  return { prefix, matches, complete: !loose, ...found() };
}

const LIST_CAP = 20_000;

// PowerShell のワイルドカードを、名前 1 つに当てる（大文字小文字は、Windows では区別しない）
// 分からない形（null）の扱いは、使い道（use）で決める。どちらも、絞り込みを効かせず、ガードが多く読む側に倒す: -Include は「当たる」（含める）、-Exclude は「当たらない」（除かない）
const wildcardCache = new Map<string, Wildcard | null>();
export function wildcardMatches(name: string, pattern: string, use: 'include' | 'exclude'): boolean {
  let match = wildcardCache.get(pattern);
  if (match === undefined) {
    match = compileWildcard(pattern, WINDOWS, true);
    if (wildcardCache.size >= 256) wildcardCache.clear();
    wildcardCache.set(pattern, match);
  }
  return match === null ? use === 'include' : match(name);
}

// フォルダの中身（deep なら下の階層まで）の一覧。幅優先で、上限を超えたら途中まで返して complete: false。入れないフォルダ・たどれないリンクがあっても complete: false
// skipHidden: 「.」で始まる名前は、一覧にも入れず、その下へも入らず、秘密を探すときにも数えない（rg が既定で読まないもの）
// 秘密らしいパスは 2 つに分ける: node_modules の外の最初の 1 つ（secret。止める）と、node_modules の中の分（depSecrets。10 件まで。今回だけの確かめにする）
const DEP_SECRET_CAP = 10;
export function listTree(dir: string, deep: boolean, cap = LIST_CAP, skipHidden = false): { entries: string[]; complete: boolean; secret?: string; depSecrets?: string[] } {
  if (isRemotePath(dir)) return { entries: [], complete: false };
  const entries: string[] = [];
  const queue = [dir];
  let complete = true;
  let secret: string | undefined;
  const depSecrets: string[] = [];
  let scanned = 0;
  const result = (): { entries: string[]; complete: boolean; secret?: string; depSecrets?: string[] } => ({ entries, complete, ...(secret === undefined ? {} : { secret }), ...(depSecrets.length ? { depSecrets } : {}) });
  while (queue.length) {
    const current = queue.shift()!;
    let items: import('node:fs').Dirent[];
    try { items = readdirSync(current, { withFileTypes: true }); } catch { complete = false; continue; }
    for (const item of items) {
      if (skipHidden && item.name.startsWith('.')) continue;
      const full = join(current, item.name);
      if (isSecretPath(full)) {
        if (inDependencies(full)) { if (depSecrets.length < DEP_SECRET_CAP) depSecrets.push(full); } else if (secret === undefined) secret = full;
      }
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
