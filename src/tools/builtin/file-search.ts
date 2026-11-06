import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { placePath } from '../hooks/scope.ts';
import { checkFilePath, HEAVY_DIRS } from './files.ts';
import type { ToolContext, ToolDef } from '../types.ts';

const MAX_SCAN = 20_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_BYTES_TOTAL = 64 * 1024 * 1024;
const HEAD_BYTES = 8192;
const MAX_LINE_CHARS = 200;
const YIELD_EVERY = 200;

// ワイルドカード: * は任意の長さ（空を含む）、? は 1 文字。それ以外の文字（[ ] など）はそのままの文字。
// 正規表現にしない（*?*?… のようなパターンで指数回帰する）。最後の * に戻る 2 ポインタで、最悪 O(n・m)
function wildcard(name: string, pattern: string): boolean {
  let p = 0, n = 0, star = -1, starName = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[n])) { p++; n++; }
    else if (p < pattern.length && pattern[p] === '*') { star = p++; starName = n; }
    else if (star !== -1) { p = star + 1; n = ++starName; }
    else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

const shown = (abs: string, ctx: ToolContext) => {
  const rel = relative(ctx.workspace, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replaceAll('\\', '/') : abs;
};

const PathArg = Type.String({ minLength: 1, maxLength: 1024, description: '作業フォルダからの相対パス、または許可フォルダ内の絶対パス' });

export const fileSearch: ToolDef<{ path?: string; name?: string; text?: string; case_sensitive?: boolean; max_results?: number }> = {
  name: 'file_search',
  description: '許可フォルダの中でファイルを探す。name は名前のワイルドカード（例 *.md）、text は中身に含まれる文字（そのままの文字。正規表現ではない）。両方を指定すると両方に合うもの。path を省くと作業フォルダ。秘密のファイルは探さない。node_modules・.git などの中は、path にそのフォルダを指定したときだけ探す。',
  input: Type.Object({
    path: Type.Optional(PathArg),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    case_sensitive: Type.Optional(Type.Boolean()),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task'],
  preCheck: (input, ctx) => checkFilePath(input.path ?? '.', 'read', ctx).check,
  async execute(input, ctx) {
    const { abs } = checkFilePath(input.path ?? '.', 'read', ctx);
    const language = languageOf(ctx.config);
    if (!input.name && !input.text) return { content: toolText(language, 'search.need_query'), isError: true };
    if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) return { content: toolText(language, 'file.no_dir', { path: shown(abs, ctx) }), isError: true };
    const maxResults = input.max_results ?? 50;
    const caseFold = !input.case_sensitive;
    const nameMatches: string[] = [];
    const textMatches: string[] = [];
    const heavy = new Set<string>();
    let skippedFiles = 0;
    let scanned = 0;
    let bytesRead = 0;
    let partial = false;
    const queue = [abs];
    outer: while (queue.length) {
      if (nameMatches.length + textMatches.length >= maxResults) break;
      const dir = queue.shift()!;
      if (ctx.signal.aborted) break;
      let items;
      try { items = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of items) {
        if (ctx.signal.aborted) break;
        if (nameMatches.length + textMatches.length >= maxResults) break;
        if (entry.isSymbolicLink()) continue;
        const full = resolve(dir, entry.name);
        if (placePath(full, ctx.policy).kind === 'deny') continue;
        scanned++;
        if (scanned > MAX_SCAN) { partial = true; break outer; }
        if (scanned % YIELD_EVERY === 0) {
          await new Promise(r => setImmediate(r));
          if (ctx.signal.aborted) break outer;
        }
        if (entry.isDirectory()) {
          if (HEAVY_DIRS.has(entry.name)) { heavy.add(entry.name); continue; }
          queue.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (input.name) {
          const n = caseFold ? entry.name.toLowerCase() : entry.name;
          const p = caseFold ? input.name.toLowerCase() : input.name;
          if (!wildcard(n, p)) continue;
        }
        const rel = shown(full, ctx);
        if (!input.text) {
          nameMatches.push(rel);
          continue;
        }
        let buf: Buffer;
        try {
          const stat = statSync(full, { throwIfNoEntry: false });
          if (!stat || stat.size > MAX_FILE_BYTES) { skippedFiles++; continue; }
          if (bytesRead + stat.size > MAX_READ_BYTES_TOTAL) { partial = true; break outer; }
          buf = readFileSync(full);
          bytesRead += stat.size;
        } catch { skippedFiles++; continue; }
        if (buf.subarray(0, HEAD_BYTES).includes(0)) { skippedFiles++; continue; }
        const lines = buf.toString('utf8').split(/\r?\n/u);
        const needle = caseFold ? input.text.toLowerCase() : input.text;
        let found = 0;
        for (let i = 0; i < lines.length && found < 5 && textMatches.length < maxResults; i++) {
          const line = lines[i]!;
          const hay = caseFold ? line.toLowerCase() : line;
          if (!hay.includes(needle)) continue;
          found++;
          textMatches.push(`${rel}:${i + 1}: ${line.trim().slice(0, MAX_LINE_CHARS)}`);
        }
      }
    }
    const parts: string[] = [];
    if (nameMatches.length) parts.push(`${toolText(language, 'search.names')}\n${nameMatches.join('\n')}`);
    if (textMatches.length) parts.push(`${toolText(language, 'search.texts')}\n${textMatches.join('\n')}`);
    const notes: string[] = [];
    if (skippedFiles) notes.push(toolText(language, 'search.skipped', { count: skippedFiles }));
    if (heavy.size) notes.push(toolText(language, 'search.heavy', { names: [...heavy].join(', ') }));
    if (partial) notes.push(toolText(language, 'search.partial', { count: scanned }));
    if (nameMatches.length + textMatches.length >= maxResults) notes.push(toolText(language, 'search.cut', { max: maxResults }));
    if (!parts.length) return { content: toolText(language, 'search.none', { path: shown(abs, ctx) }) };
    return { content: parts.join('\n\n') + (notes.length ? `\n${notes.join('\n')}` : '') };
  },
};
