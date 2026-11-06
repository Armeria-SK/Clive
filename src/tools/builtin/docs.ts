import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { Language } from '../../config/schema.ts';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { OFFICE_TEXT_MAX, docxText, officeKind, xlsxText } from '../../shared/office-text.ts';
import type { OfficeText } from '../../shared/office-text.ts';
import { pdfText } from '../../shared/pdf-text.ts';
import { openZip } from '../../shared/zip.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';
import { checkFilePath } from './files.ts';

export const DOC_MAX_BYTES = 20 * 1024 * 1024;

const EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx']);

type Extracted = { text: string; truncated: boolean } | ToolOutput;

const shown = (abs: string, ctx: ToolContext) => {
  const rel = relative(ctx.workspace, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replaceAll('\\', '/') : abs;
};

const PathArg = Type.String({ minLength: 1, maxLength: 1024, description: '作業フォルダからの相対パス、または許可フォルダ内の絶対パス' });

const error = (content: string): ToolOutput => ({ content, isError: true });

// 投げられたものの message には読もうとしたファイルの絶対パスが入りうるので、コードか名前だけを返す
function safeDetail(thrown: unknown): string {
  const code = (thrown as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  return thrown instanceof Error && /^[A-Za-z]{1,40}$/.test(thrown.name) ? thrown.name : 'unknown';
}

function officeFailure(result: Extract<OfficeText, { ok: false }>, language: Language, path: string): ToolOutput {
  switch (result.reason) {
    case 'dtd': return error(toolText(language, 'doc.dtd'));
    case 'too_large': return error(toolText(language, 'doc.too_large_inside', { detail: result.detail ?? 'xml' }));
    case 'no_text': return error(toolText(language, 'doc.no_text', { path }));
    case 'encrypted': return error(toolText(language, 'doc.encrypted'));
    case 'damaged': return error(toolText(language, 'doc.damaged', { detail: result.detail ?? 'damaged' }));
  }
}

function extractPdf(bytes: Uint8Array, language: Language, path: string, ext: string): Extracted {
  const result = pdfText(bytes);
  if (result.ok) return { text: result.text, truncated: result.text.length >= OFFICE_TEXT_MAX };
  switch (result.reason) {
    case 'not_pdf': return error(toolText(language, 'doc.mismatch', { ext, path }));
    case 'encrypted': return error(toolText(language, 'doc.encrypted'));
    case 'no_text': return error(toolText(language, 'doc.no_text', { path }));
    case 'damaged': return error(toolText(language, 'doc.damaged', { detail: 'pdf' }));
  }
}

function extractOffice(bytes: Uint8Array, ext: string, language: Language, path: string): Extracted {
  const kind = officeKind(bytes);
  if (kind === 'cfb') return error(toolText(language, 'doc.encrypted'));
  if (kind === 'other') return error(toolText(language, 'doc.mismatch', { ext, path }));
  const opened = openZip(bytes);
  if (!opened.ok) {
    if (opened.reason === 'encrypted') return error(toolText(language, 'doc.encrypted'));
    if (opened.reason === 'too_many' || opened.reason === 'too_large' || opened.reason === 'ratio') return error(toolText(language, 'doc.too_large_inside', { detail: opened.reason }));
    return error(toolText(language, 'doc.damaged', { detail: opened.reason }));
  }
  const result = ext === '.docx' ? docxText(opened.zip) : xlsxText(opened.zip, language);
  return result.ok ? { text: result.text, truncated: result.truncated } : officeFailure(result, language, path);
}

export const docRead: ToolDef<{ path: string; offset?: number; limit?: number }> = {
  name: 'doc_read',
  description: 'PDF・Word（.docx）・Excel（.xlsx）の本文を文字にして読む。Excel はシートごとにタブ区切り（式は書かれず、覚えている値だけ）。offset（何行目から、1始まり）と limit（何行）で一部だけ読める。.doc .xls・パスワード付きは読めない。',
  input: Type.Object({ path: PathArg, offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task'],
  preCheck: (input, ctx) => checkFilePath(input.path, 'read', ctx).check,
  async execute(input, ctx) {
    const { abs, check } = checkFilePath(input.path, 'read', ctx);
    const language = languageOf(ctx.config);
    if (check.decision === 'deny') return error(check.reasons.join(' / '));
    const path = shown(abs, ctx);
    const ext = extname(abs).toLowerCase();
    if (!EXTENSIONS.has(ext)) return error(toolText(language, 'doc.unsupported', { path }));
    try {
      const stat = statSync(abs, { throwIfNoEntry: false });
      if (!stat) return error(toolText(language, 'file.not_found', { path }));
      if (stat.isDirectory()) return error(toolText(language, 'file.is_dir', { path }));
      if (stat.size > DOC_MAX_BYTES) return error(toolText(language, 'doc.too_big', { size: stat.size.toLocaleString('en-US'), max: DOC_MAX_BYTES.toLocaleString('en-US') }));
      const bytes = readFileSync(abs);
      const extracted = ext === '.pdf' ? extractPdf(bytes, language, path, ext) : extractOffice(bytes, ext, language, path);
      if ('content' in extracted) return extracted;
      const lines = extracted.text.split('\n');
      const start = (input.offset ?? 1) - 1;
      const end = input.limit ? start + input.limit : lines.length;
      const body = lines.slice(start, end).join('\n');
      const more = end < lines.length ? `\n\n${toolText(language, 'file.more', { total: lines.length, from: start + 1, to: end, next: end + 1 })}` : '';
      const cut = extracted.truncated ? `\n\n${toolText(language, 'doc.truncated', { max: OFFICE_TEXT_MAX.toLocaleString('en-US') })}` : '';
      return { content: body + more + cut };
    } catch (thrown) {
      return error(toolText(language, 'failed', { detail: safeDetail(thrown) }));
    }
  },
};
