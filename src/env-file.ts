import { chmodSync, copyFileSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { atomicWriteFile } from './config/store.ts';

// .env への書き込み（画面から入れた API キー）。ほかの行・コメント・空行・順番はそのまま残し、一時ファイルに書いてから置き換える。
// 前の .env は .env.bak に 1 つだけ控える。Linux では 0600 で作る・保つ。鍵は、投げる例外にも入れない。
// 書き換えた .env 全体を、起動で読み込むのと同じ読み方（util.parseEnv）で読み直し、鍵以外の変数が 1 つも変わらないことを確かめてから書く（確かめられなければ書かない）

const WINDOWS = process.platform === 'win32';
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const QUOTES = ['"', "'", '`'];

export class EnvFileError extends Error {
  readonly reason: 'link' | 'name' | 'value' | 'file' | 'io';
  constructor(reason: EnvFileError['reason'], message: string) { super(message); this.reason = reason; }
}

// 値を書く形の候補。そのまま → ' → ` → " の順に試し、1 行だけで読み戻せるものだけを返す
function candidates(value: string): string[] {
  const out: string[] = [];
  for (const quote of ['', "'", '`', '"']) {
    const text = `${quote}${value}${quote}`;
    try { if (parseEnv(`K=${text}\n`).K === value) out.push(text); } catch { }
  }
  return out;
}

// 行を、終端の改行を付けたまま分ける
const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];

// 変数の代入が占める行の範囲（0 始まり、両端を含む）
interface Span { key: string; start: number; end: number }

const BLANK = new Set([' ', '\t', '\n']);
const skipBlank = (text: string, from: number): number => { let at = from; while (at < text.length && BLANK.has(text[at]!)) at += 1; return at; };
const trimBlank = (text: string): string => { let a = 0; let b = text.length; while (a < b && BLANK.has(text[a]!)) a += 1; while (b > a && BLANK.has(text[b - 1]!)) b -= 1; return text.slice(a, b); };

// util.parseEnv が、どの行をどの変数の代入として読むかを、同じ手順でたどる（値は使わず、範囲だけ返す）。
// 引用符で始まる値は、同じ引用符が「このあと .env のどこかに」あればそこまで（複数行になる）、無ければその行だけ。閉じた行の残りは読み飛ばす。
// 食い違いがあっても書く前に parseEnv で全体を読み直して確かめるので、ここの読み違いで鍵以外の変数が変わることは無い
function spansOf(source: string): Span[] {
  const text = source.replaceAll('\r', '').replace(/[ \t\n]+$/u, '');
  const newlines: number[] = [];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) newlines.push(at);
  const lineAt = (offset: number): number => { let low = 0; let high = newlines.length; while (low < high) { const mid = (low + high) >> 1; if (newlines[mid]! < offset) low = mid + 1; else high = mid; } return low; };
  const out: Span[] = [];
  const add = (key: string, from: number, to: number): void => { out.push({ key, start: lineAt(from), end: Math.max(lineAt(from), lineAt(to)) }); };
  let at = skipBlank(text, 0);
  while (at < text.length) {
    if (text[at] === '\n' || text[at] === '#') {
      const next = text.indexOf('\n', at);
      if (next < 0) break;
      at = next + 1;
      continue;
    }
    const equals = text.indexOf('=', at);
    const newline = text.indexOf('\n', at);
    if (equals < 0 && newline < 0) break;
    if (newline >= 0 && (equals < 0 || newline < equals)) { at = skipBlank(text, newline + 1); continue; }
    const from = at;
    let key = trimBlank(text.slice(at, equals));
    at = equals + 1;
    if (at >= text.length || text[at] === '\n') { add(key, from, at); continue; }
    at = skipBlank(text, at);
    if (at >= text.length) { add(key, from, at); break; }
    if (key.startsWith('export ')) key = trimBlank(key.slice(7));
    if (!key) continue;
    const quote = text[at]!;
    if (QUOTES.includes(quote)) {
      const close = text.indexOf(quote, at + 1);
      if (close >= 0) {
        const next = text.indexOf('\n', close + 1);
        add(key, from, next < 0 ? text.length : next);
        at = next < 0 ? text.length : next + 1;
        continue;
      }
    }
    const next = text.indexOf('\n', at);
    const end = next < 0 ? text.length : next;
    add(key, from, end);
    at = skipBlank(text, end);
  }
  return out;
}

const parse = (text: string): Map<string, string> => new Map(Object.entries(parseEnv(text)).flatMap(([key, value]) => (value === undefined ? [] : [[key, value] as const])));

// 書き換えの前後で、name 以外の変数が 1 つも変わらず（増えも減りもせず）、name が期待どおり（expected が undefined なら無い）であること
function sameExcept(before: Map<string, string>, after: Map<string, string>, name: string, expected: string | undefined): boolean {
  if (expected === undefined ? after.has(name) : after.get(name) !== expected) return false;
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (key !== name && before.get(key) !== after.get(key)) return false;
  }
  return true;
}

// name の代入の前（インデント・export）を、元の行から取り出す
function prefixOf(line: string, name: string): string {
  const head = line.slice(0, Math.max(0, line.indexOf('='))).trimEnd();
  return head.endsWith(name) ? head.slice(0, head.length - name.length) : '';
}

const where = (text: string, name: string): Span[] => spansOf(text).filter(span => span.key === name);

function refuse(): never { throw new EnvFileError('file', '.env の今の書き方では、ほかの変数を変えずに書き換えられません'); }

// current（.env の中身）の name を value に置き換えた中身を返す。ほかの行・コメント・空行・順番はそのまま。
// 同じ名前の古い代入（古い鍵）は外し、無ければ末尾に足す。書き換えた全体を読み直して、鍵以外の変数が変わるなら投げる
export function setEnvText(current: string, name: string, value: string): string {
  if (!NAME.test(name)) throw new EnvFileError('name', '環境変数の名前が正しくありません');
  if (QUOTES.includes(value[0] ?? '')) throw new EnvFileError('value', '鍵の文字を .env に安全に書けません');
  const forms = candidates(value);
  if (forms.length === 0) throw new EnvFileError('value', '鍵の文字を .env に安全に書けません');
  const before = parse(current);
  const found = where(current, name);
  if (found.length === 0 && before.has(name)) refuse();
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  for (const form of forms) {
    const lines = splitLines(current);
    if (found.length === 0) {
      if (lines.length && !lines[lines.length - 1]!.endsWith('\n')) lines[lines.length - 1] += eol;
      lines.push(`${name}=${form}${eol}`);
    } else {
      // 最初の代入をその場で置き換え、同じ名前の古い代入（古い鍵）は外す
      const first = found[0]!;
      const terminator = /\r?\n$/u.exec(lines[first.end]!)?.[0] ?? '';
      const replacement = `${prefixOf(lines[first.start]!, name)}${name}=${form}${terminator}`;
      for (const span of [...found].reverse()) lines.splice(span.start, span.end - span.start + 1, ...(span === first ? [replacement] : []));
    }
    const next = lines.join('');
    if (sameExcept(before, parse(next), name, value) && where(next, name).length === 1) return next;
  }
  refuse();
}

// current の name の代入をすべて外した中身を返す。無ければ undefined。外した全体を読み直して、鍵以外の変数が変わるなら投げる
export function removeEnvText(current: string, name: string): string | undefined {
  if (!NAME.test(name)) throw new EnvFileError('name', '環境変数の名前が正しくありません');
  const before = parse(current);
  const found = where(current, name);
  if (found.length === 0) {
    if (before.has(name)) refuse();
    return undefined;
  }
  const lines = splitLines(current);
  for (const span of [...found].reverse()) lines.splice(span.start, span.end - span.start + 1);
  const next = lines.join('');
  if (!sameExcept(before, parse(next), name, undefined) || where(next, name).length > 0) refuse();
  return next;
}

function readExisting(path: string): string {
  if (!existsSync(path)) return '';
  if (lstatSync(path).isSymbolicLink()) throw new EnvFileError('link', '.env がリンクなので書き換えません');
  try { return readFileSync(path, 'utf8'); } catch (error) { throw new EnvFileError('io', `.env を読めませんでした（${(error as NodeJS.ErrnoException).code ?? 'error'}）`); }
}

// 控え（.env.bak）がリンクなら、写すとリンク先を上書きしてしまうので断る
function checkBackup(path: string): void {
  if (lstatSync(`${path}.bak`, { throwIfNoEntry: false })?.isSymbolicLink()) throw new EnvFileError('link', '.env.bak がリンクなので書き換えません');
}

// backup: 'previous' は前の .env を控えにする。'content' は新しい中身を控えにする（鍵を消したあと、消した鍵の入った前の .env を控えに残さない）。
// 控えを先に書く: 控えが書けなかったときは、.env を変えずに断る（鍵が控えにだけ残る形にしない）
function save(path: string, previous: string | undefined, content: string, backup: 'previous' | 'content' = 'previous'): void {
  try {
    if (previous !== undefined) {
      checkBackup(path);
      if (backup === 'content') atomicWriteFile(`${path}.bak`, content, 0o600);
      else {
        copyFileSync(path, `${path}.bak`);
        if (!WINDOWS) chmodSync(`${path}.bak`, 0o600);
      }
    }
    atomicWriteFile(path, content, 0o600);
  } catch (error) {
    if (error instanceof EnvFileError) throw error;
    throw new EnvFileError('io', `.env に書けませんでした（${(error as NodeJS.ErrnoException).code ?? 'error'}）`);
  }
}

// .env に書かれている name の値（起動で読み込むのと同じ読み方）。無ければ・読めなければ undefined
export function envFileValue(path: string, name: string): string | undefined {
  try { return existsSync(path) ? parseEnv(readFileSync(path, 'utf8'))[name] : undefined; } catch { return undefined; }
}

export function setEnvValue(path: string, name: string, value: string): void {
  const existed = existsSync(path);
  const current = readExisting(path);
  save(path, existed ? current : undefined, setEnvText(current, name, value));
}

// 同じ名前の行をすべて外す。無ければ何もしない（ファイルも作らない）。外したら true
export function removeEnvValue(path: string, name: string): boolean {
  if (!NAME.test(name)) throw new EnvFileError('name', '環境変数の名前が正しくありません');
  if (!existsSync(path)) return false;
  const current = readExisting(path);
  const next = removeEnvText(current, name);
  if (next === undefined) return false;
  save(path, current, next, 'content');
  return true;
}
