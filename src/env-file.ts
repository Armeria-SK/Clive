import { chmodSync, copyFileSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { atomicWriteFile } from './config/store.ts';

// .env への書き込み（画面から入れた API キー）。ほかの行・コメント・空行・順番はそのまま残し、一時ファイルに書いてから置き換える。
// 前の .env は .env.bak に 1 つだけ控える。Linux では 0600 で作る・保つ。鍵は、投げる例外にも入れない

const WINDOWS = process.platform === 'win32';
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export class EnvFileError extends Error {
  readonly reason: 'link' | 'name' | 'value' | 'io';
  constructor(reason: EnvFileError['reason'], message: string) { super(message); this.reason = reason; }
}

// 起動で読み込むのと同じ読み方（util.parseEnv）で、そのまま読み戻せる書き方を選ぶ。そのまま → ' → ` → " の順に試す
function formatValue(value: string): string | undefined {
  for (const quote of ['', "'", '`', '"']) {
    const text = `${quote}${value}${quote}`;
    try { if (parseEnv(`K=${text}\n`).K === value) return text; } catch { }
  }
  return undefined;
}

const assignment = (name: string) => new RegExp(`^(\\uFEFF?[ \\t]*(?:export[ \\t]+)?)${name}[ \\t]*=(.*)$`, 'u');

// 行を、終端の改行を付けたまま分ける
const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];

interface Span { start: number; end: number; prefix: string }

// name への代入の範囲（行の番号）。引用符つきで閉じていない値は、閉じる行までを 1 つとして数える
function spans(lines: readonly string[], name: string): Span[] {
  const pattern = assignment(name);
  const out: Span[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = pattern.exec(lines[i]!.replace(/\r?\n$/u, ''));
    if (!m) continue;
    let end = i;
    const value = m[2]!.trimStart();
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      let closed = value.indexOf(quote, 1) >= 0;
      while (!closed && end + 1 < lines.length) { end += 1; closed = lines[end]!.includes(quote); }
    }
    out.push({ start: i, end, prefix: m[1]! });
    i = end;
  }
  return out;
}

function readExisting(path: string): string {
  if (!existsSync(path)) return '';
  if (lstatSync(path).isSymbolicLink()) throw new EnvFileError('link', '.env がリンクなので書き換えません');
  try { return readFileSync(path, 'utf8'); } catch (error) { throw new EnvFileError('io', `.env を読めませんでした（${(error as NodeJS.ErrnoException).code ?? 'error'}）`); }
}

function save(path: string, previous: string | undefined, content: string): void {
  try {
    if (previous !== undefined) {
      copyFileSync(path, `${path}.bak`);
      if (!WINDOWS) chmodSync(`${path}.bak`, 0o600);
    }
    atomicWriteFile(path, content, 0o600);
  } catch (error) {
    if (error instanceof EnvFileError) throw error;
    throw new EnvFileError('io', `.env に書けませんでした（${(error as NodeJS.ErrnoException).code ?? 'error'}）`);
  }
}

export function setEnvValue(path: string, name: string, value: string): void {
  if (!NAME.test(name)) throw new EnvFileError('name', '環境変数の名前が正しくありません');
  const text = formatValue(value);
  if (text === undefined) throw new EnvFileError('value', '鍵の文字を .env に安全に書けません');
  const existed = existsSync(path);
  const current = readExisting(path);
  const lines = splitLines(current);
  const found = spans(lines, name);
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  if (found.length === 0) {
    if (lines.length && !lines[lines.length - 1]!.endsWith('\n')) lines[lines.length - 1] += eol;
    lines.push(`${name}=${text}${eol}`);
  } else {
    // 最初の代入をその場で置き換え、同じ名前の古い代入（古い鍵）は外す
    const first = found[0]!;
    const terminator = /\r?\n$/u.exec(lines[first.end]!)?.[0] ?? '';
    const replacement = `${first.prefix}${name}=${text}${terminator}`;
    for (const span of [...found].reverse()) lines.splice(span.start, span.end - span.start + 1, ...(span === first ? [replacement] : []));
  }
  save(path, existed ? current : undefined, lines.join(''));
}

// 同じ名前の行をすべて外す。無ければ何もしない（ファイルも作らない）。外したら true
export function removeEnvValue(path: string, name: string): boolean {
  if (!NAME.test(name)) throw new EnvFileError('name', '環境変数の名前が正しくありません');
  if (!existsSync(path)) return false;
  const current = readExisting(path);
  const lines = splitLines(current);
  const found = spans(lines, name);
  if (found.length === 0) return false;
  for (const span of [...found].reverse()) lines.splice(span.start, span.end - span.start + 1);
  save(path, current, lines.join(''));
  return true;
}
