// 許可の一覧（security-self-api.md §11.3）の、共通の部品: 判定の型・引数の読み取りの仕組み・URL の調べ。
// 表そのもの（コマンドごとのフラグ）は allowlist-tools.ts（bash と外部の道具）・allowlist-git.ts（git）・allowlist-ps.ts（PowerShell のコマンドレット）にある。

import type { GuardMessageKey } from '../../shared/messages/guard.ts';
import type { ShellKind, Word } from './shell-lex.ts';

export type Level = 'allow' | 'ask' | 'once' | 'deny';
export const RANK: Record<Level, number> = { allow: 0, ask: 1, once: 2, deny: 3 };
export const worstLevel = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b);

// 判定の理由。exempt: 持ち主が tools.shell.allow に書いたコマンドで外せる（「一覧に無いコマンド・フラグ・形」の確かめだけ。§11.6）
export interface Reason { key: GuardMessageKey; params: Record<string, string | number>; level: Level; exempt: boolean }
// list: パイプで次のコマンドに流れるファイル（Get-ChildItem の出力など）として読まれる。word は一覧の元のパスで、フォルダなら中のファイル（deep なら下の階層まで）を読むものとして調べる。
// items: フォルダの中身ではなく、当たったもの自身（Get-Item・Resolve-Path）。filter/include/exclude: 名前の絞り込み（絞り込みが分からないときは空 = すべて）
export interface ListSpec { deep: boolean; items: boolean; filter: string[]; include: string[]; exclude: string[] }
// strict: スクリプトブロックの中。パスが分からない読み取りは、確かめでなく今回だけにする
export interface PathRef { word: Word; mode: 'read' | 'write'; recursive: boolean; list?: ListSpec; strict?: boolean }
// 書き込み先を組み立てて調べるもの（11.4）。copy: cp・mv・Copy-Item・Move-Item（先がフォルダなら 先/元の名前）、join: New-Item -Path p -Name n（p/n）、rename: Rename-Item（親/n）
export interface CopyUse { kind: 'copy' | 'join' | 'rename'; sources: Word[]; dest: Word | null; name: Word | null; recursive: boolean; dirFlag: boolean; noTargetDir: boolean }
// remotes: push の宛先に使える remote の名前（設定に remote.<名前>.url があるもの）。無い名前は、git がフォルダ・URL として扱う
// localRemotes: そのうち、url が この PC のフォルダ・file:// を指すもの（git はそのフォルダの git を起こし、そのフックも動く。フックの上書きは、ローカルの転送の子には届かない）
// hooksDir: そのリポジトリ自身のフックの置き場所（共通の git フォルダの hooks/）。見つからなければ空
export interface RepoInfo { found: boolean; configOk: boolean; badKey: string; unreadable: boolean; hooksPath: boolean; hooksFiles: boolean; hooksDir: string; remotes: readonly string[]; localRemotes: readonly string[] }

export interface MatchCtx {
  shell: ShellKind;
  windows: boolean;
  repo: (dashC: string | undefined) => RepoInfo;
  // C2: 実際に起こされるファイルを調べる（無ければ調べない）
  external?: ((name: string) => { ok: boolean; ext: string; detail: string }) | undefined;
  selfHosts: readonly string[];
  // git をホーム・システムの設定の洗い出しつきで動かせるか（git-env.ts。2.32 より古い git は false）。false なら git はすべて今回だけ
  gitIsolated?: boolean | undefined;
  // curl・wget が起動のたびに読む設定ファイル（書かれていれば、その場所）。保存先や送り先を変えられるので、あればその curl・wget は今回だけ（tool-config.ts）
  toolConfig?: ((tool: 'curl' | 'wget') => ToolRc | undefined) | undefined;
  // 文 1 つの判定が終わるたびに呼ばれる（cd で動いた先を、あとの文の判定で数えるため）
  afterStatement?: ((result: StatementResult) => void) | undefined;
}

// file: 読まれる設定ファイルの場所。unknownCwd: cd の先が分からず、調べられない
export type ToolRc = { file: string } | { unknownCwd: true };

export interface StatementResult {
  level: Level;
  reasons: Reason[];
  paths: PathRef[];
  copies: CopyUse[];
  // 書き込み先がパイプから来る（… | Remove-Item など）
  pipeWrite: boolean;
  // 外から読む（curl・wget・iwr・irm）
  fetch: boolean;
  // 消すコマンド（rm・Remove-Item など）。ルートやホームを消す形は止める
  deletes: boolean;
  // cd・Set-Location など。word が null なら、行き先が分からない
  cwd?: { word: Word | null };
  // curl -O・wget の既定の名前: URL の最後の名前で書く先
  remoteNames: Array<{ url: Word; dir: Word | null }>;
}

export class Acc {
  readonly reasons: Reason[] = [];
  readonly paths: PathRef[] = [];
  readonly copies: CopyUse[] = [];
  pipeWrite = false;
  fetch = false;
  deletes = false;
  cwd?: { word: Word | null };
  readonly remoteNames: Array<{ url: Word; dir: Word | null }> = [];
  add(level: Level, key: GuardMessageKey, params: Record<string, string | number> = {}, exempt = false): void {
    if (level === 'allow') return;
    this.reasons.push({ key, params, level, exempt });
  }
  strict = false;
  read(word: Word, recursive = false): void { this.paths.push({ word, mode: 'read', recursive, ...(this.strict ? { strict: true } : {}) }); }
  readList(word: Word, list: ListSpec): void { this.paths.push({ word, mode: 'read', recursive: false, list }); }
  write(word: Word, recursive = false): void { this.paths.push({ word, mode: 'write', recursive }); }
  result(): StatementResult {
    let level: Level = 'allow';
    for (const r of this.reasons) level = worstLevel(level, r.level);
    return {
      level, reasons: this.reasons, paths: this.paths, copies: this.copies, pipeWrite: this.pipeWrite, fetch: this.fetch, deletes: this.deletes,
      remoteNames: this.remoteNames, ...(this.cwd ? { cwd: this.cwd } : {}),
    };
  }
}

// ── C8: 変数の名前 ──
const ENV_PLAIN = new Set(['LC_ALL', 'LC_CTYPE', 'LANG', 'LANGUAGE', 'TZ', 'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'COLUMNS', 'LINES', 'TERM']);
export function envAssignOk(name: string, value: Word | null): boolean {
  if (value === null || value.dynamic || value.glob) return false;
  if (name === 'GIT_PAGER' || name === 'PAGER') return value.text === 'cat';
  return ENV_PLAIN.has(name) && /^[A-Za-z0-9_.@:+-]*$/u.test(value.text);
}
// bash のシェルの変数（小文字だけの名前。proxy を含まない）
export const bashVarOk = (name: string): boolean => /^[a-z][a-z0-9_]*$/u.test(name) && !name.includes('proxy');
const PS_RESERVED = new Set([
  'executioncontext', 'host', 'home', 'profile', 'pwd', 'shellid', 'input', 'args', 'this', 'myinvocation', 'ofs', 'error', 'matches', 'lastexitcode', 'stacktrace',
  'foreach', 'switch', 'sender', 'event', 'eventargs', 'eventsubscriber', 'nestedpromptlevel', 'pid', 'null', 'true', 'false', 'psdefaultparametervalues', 'env',
]);
export function psVarOk(name: string): boolean {
  const n = name.toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/u.test(n)) return false;
  return !n.startsWith('ps') && !n.endsWith('preference') && !PS_RESERVED.has(n);
}

// ── 値の型（C4）──
// opt: 値は付けても付けなくてもよい（付けるときは =値）。var: 変数の名前（C8）。x: 見ない
export type ValueType = 'n' | 's' | 'path-r' | 'path-w' | 'pat' | 'url' | 'name' | 'var' | 'opt' | 'x' | { enum: readonly string[] };

const NUMBER = /^[-+]?[0-9]+(?:\.[0-9]+)?(?:[kKmMgGtT]i?[bB]?)?$/u;

export function checkValue(type: ValueType, word: Word, acc: Acc, cmd: string, flag: string, ctx: MatchCtx, exempt = true): void {
  if (typeof type === 'object') {
    if (word.dynamic || !type.enum.some(v => v.toLowerCase() === word.text.toLowerCase())) acc.add('once', 'list.form', { cmd, detail: `${flag} ${word.text}`.trim() }, exempt);
    return;
  }
  switch (type) {
    case 'n':
      if (!word.dynamic && !NUMBER.test(word.text)) acc.add('once', 'list.form', { cmd, detail: `${flag} ${word.text}`.trim() }, exempt);
      return;
    case 'path-r': if (!(word.text === '-' && !word.dynamic)) acc.read(word); return;
    case 'path-w': if (!(word.text === '-' && !word.dynamic)) acc.write(word); return;
    case 'url': checkUrl(word, acc, ctx, cmd); return;
    case 'var': if (word.dynamic || !(ctx.shell === 'bash' || ctx.shell === 'sh' ? bashVarOk(word.text) : psVarOk(word.text))) acc.add('once', 'list.env', { name: word.text }, false); return;
    default: return;
  }
}

// ── URL（§11.3.4）──
const LOOPBACK_HOST = /^(?:127\.\d{1,3}(?:\.\d{1,3}){0,2}|localhost|0\.0\.0\.0|2130706433|0x7f[0-9a-f]*|::1)$/iu;
const LAN_HOST = /^(?:10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|f[cd][0-9a-f]{2}:.*|fe[89ab][0-9a-f]:.*)$/iu;

// 末尾のドット（localhost.）は同じ名前を指すので落とす
export function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.+$/u, ''); } catch { return null; }
}

export const isLoopbackHost = (host: string, selfHosts: readonly string[]): boolean =>
  LOOPBACK_HOST.test(host) || host.endsWith('.localhost') || selfHosts.some(h => h && h.toLowerCase().replace(/\.+$/u, '') === host.replace(/\.+$/u, ''));

export function checkUrl(word: Word, acc: Acc, ctx: MatchCtx, cmd: string): void {
  acc.fetch = true;
  if (word.dynamic) { acc.add('once', 'list.form', { cmd, detail: word.text }, true); return; }
  let url: URL;
  try { url = new URL(word.text); } catch { acc.add('once', 'list.form', { cmd, detail: word.text }, true); return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { acc.add('once', 'list.form', { cmd, detail: word.text }, true); return; }
  const host = hostOf(word.text) ?? '';
  if (isLoopbackHost(host, ctx.selfHosts)) acc.add('once', 'code.loopback', { host }, false);
  else if (LAN_HOST.test(host) || /\.(?:local|lan|internal)$/u.test(host) || host.endsWith('.home.arpa')) acc.add('ask', 'list.lan', { host });
}

// ── フラグの定義（C3）──
// 書き方: 空白で区切る。 -a（値なし）・-n:n（値の型 n）・--max-depth:n（--max-depth=n と --max-depth n）・-t:f|d|l（選べる値）・--color=never（この形だけ）・--decorate:opt（付けても付けなくてもよい）
export interface FlagDef { type: 'bool' | ValueType; fixed?: boolean }

export function flagMap(def: string, lower = false): Map<string, FlagDef> {
  const map = new Map<string, FlagDef>();
  for (const raw of def.split(/\s+/u).filter(Boolean)) {
    const item = lower ? raw.toLowerCase() : raw;
    const colon = item.indexOf(':');
    if (colon > 0) {
      const name = item.slice(0, colon);
      const t = raw.slice(colon + 1);
      map.set(name, { type: t.includes('|') ? { enum: t.split('|') } : (t as ValueType) });
    } else if (item.includes('=')) map.set(item, { type: 'bool', fixed: true });
    else map.set(item, { type: 'bool' });
  }
  return map;
}

export interface GnuSpec {
  names: readonly string[];
  // ◎: どのフラグもコードを動かさず、ファイルに書かない（値の分からない引数を許す）
  ro?: boolean;
  flags: string;
  // 位置の引数の型。最後が '…' で終わるものは、それ以降も同じ型。例: ['pat', 'path-r…']
  pos?: readonly string[];
  numeric?: boolean;
  // この中のフラグがあれば、最初の位置の引数はパターンでなくなる（grep -e）
  patFlags?: readonly string[];
}

// ddAt: 「--」より前の位置の引数の数（「--」が無ければ全部）
export interface Parsed { pos: Word[]; seen: Set<string>; values: Map<string, Word[]>; ddAt: number }

const SHORT_CLUSTER = /^-[A-Za-z0-9]+$/u;

export function parseGnu(spec: GnuSpec, words: readonly Word[], acc: Acc, ctx: MatchCtx): Parsed {
  const cmd = spec.names[0]!;
  const flags = flagMap(spec.flags);
  const pos: Word[] = [];
  const seen = new Set<string>();
  const values = new Map<string, Word[]>();
  const keep = (flag: string, value: Word): void => { values.set(flag, [...(values.get(flag) ?? []), value]); };
  let afterDd = false;
  let ddAt = -1;
  const args = words.slice(1);
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (afterDd) { pos.push(w); continue; }
    if (!w.dynamic && !w.glob && !w.quoted && w.text === '--') { afterDd = true; ddAt = pos.length; continue; }
    if ((w.dynamic || w.glob) && !spec.ro) acc.add('once', 'list.dynamic', { cmd, detail: w.text }, true);
    const text = w.text;
    if (w.dynamic || w.kind !== 'plain' || text === '-' || !text.startsWith('-') || text.length === 1) { pos.push(w); continue; }
    const exact = flags.get(text);
    if (exact && (exact.fixed || exact.type === 'bool' || exact.type === 'opt')) { seen.add(text); continue; }
    if (text.startsWith('--')) {
      const eq = text.indexOf('=');
      const name = eq > 0 ? text.slice(0, eq) : text;
      const def = flags.get(name);
      if (!def || def.fixed) { acc.add('once', 'list.flag', { cmd, flag: name }, true); continue; }
      seen.add(name);
      if (def.type === 'bool' || def.type === 'opt') { if (eq < 0 || def.type === 'bool') acc.add('once', 'list.flag', { cmd, flag: text }, true); continue; }
      const value = eq > 0 ? { ...w, text: text.slice(eq + 1), dynamic: false, glob: false } : args[++i];
      if (!value) { acc.add('once', 'list.form', { cmd, detail: `${name} の値` }, true); continue; }
      if (eq < 0 && (value.dynamic || value.glob) && !spec.ro) acc.add('once', 'list.dynamic', { cmd, detail: value.text }, true);
      keep(name, value);
      checkValue(def.type, value, acc, cmd, name, ctx);
      continue;
    }
    if (spec.numeric && /^-[0-9]+$/u.test(text)) continue;
    if (!SHORT_CLUSTER.test(text)) { acc.add('once', 'list.flag', { cmd, flag: text }, true); continue; }
    for (let j = 1; j < text.length; j++) {
      const key = `-${text[j]}`;
      const def = flags.get(key);
      if (!def || def.fixed) { acc.add('once', 'list.flag', { cmd, flag: key }, true); break; }
      seen.add(key);
      if (def.type === 'bool' || def.type === 'opt') continue;
      const rest = text.slice(j + 1);
      const value = rest !== '' ? { ...w, text: rest, dynamic: false, glob: false } : args[++i];
      if (!value) { acc.add('once', 'list.form', { cmd, detail: `${key} の値` }, true); break; }
      if (rest === '' && (value.dynamic || value.glob) && !spec.ro) acc.add('once', 'list.dynamic', { cmd, detail: value.text }, true);
      keep(key, value);
      checkValue(def.type, value, acc, cmd, key, ctx);
      break;
    }
  }
  const shape = spec.pos ?? [];
  const skip = spec.patFlags?.some(f => seen.has(f)) && shape[0] === 'pat' ? 1 : 0;
  const types = shape.slice(skip);
  const repeats = types.at(-1)?.endsWith('…') ?? false;
  pos.forEach((w, i) => {
    const raw = types[Math.min(i, types.length - 1)];
    if (raw === undefined || (i >= types.length && !repeats)) { acc.add('once', 'list.form', { cmd, detail: w.text }, true); return; }
    checkValue(raw.replace('…', '') as ValueType, w, acc, cmd, '', ctx);
  });
  return { pos, seen, values, ddAt: ddAt < 0 ? pos.length : ddAt };
}

// コマンドの語が、決まった綴りかどうか（引用符・変数・展開が無い）
export const literal = (w: Word | undefined): boolean => w !== undefined && w.kind === 'plain' && !w.dynamic && !w.glob && !w.home;
export const isFlagLike = (w: Word): boolean => literal(w) && /^-./u.test(w.text) && !w.quoted;
