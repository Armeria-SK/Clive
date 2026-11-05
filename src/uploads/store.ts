import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE, LANGUAGES, type Language } from '../config/schema.ts';
import type { ImageRef } from '../engine/types.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { storeText, type StoreMessageKey } from '../shared/messages/stores.ts';
import { pdfText } from '../shared/pdf-text.ts';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_INLINE_CHARS = 50_000;
export const MAX_ATTACHMENTS = 5;

export type UploadKind = 'text' | 'pdf' | 'image';

export interface Upload {
  id: string; name: string; mime: string; kind: UploadKind; size: number; sha256: string;
  text: string | null; pages: number | null; created_at: number;
}
export type UploadView = Omit<Upload, 'text'> & { chars: number | null };

export class UploadError extends LocalizedError<StoreMessageKey> {
  readonly status: number;
  constructor(code: StoreMessageKey, params?: MessageParams, status = 400) { super(storeText, code, params); this.status = status; }
}

const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|log|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|sh|ps1|sql|env\.example)$/iu;

function sniff(body: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | 'pdf' | undefined {
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'jpg';
  if (body.subarray(0, 6).toString('latin1') === 'GIF87a' || body.subarray(0, 6).toString('latin1') === 'GIF89a') return 'gif';
  if (body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (body.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return undefined;
}

function safeName(name: string): string {
  const base = name.replace(/^.*[\\/]/u, '').replace(/[\u0000-\u001f<>:"|?*]/gu, '_').trim();
  return (base || 'file').slice(0, 200);
}

export class Uploads {
  readonly #db: DatabaseSync;
  readonly #dir: string;
  readonly #now: () => number;
  constructor(db: DatabaseSync, dir: string, now: () => number = Date.now) { this.#db = db; this.#dir = dir; this.#now = now; }

  save(input: { name: string; mime: string; body: Buffer }): UploadView {
    const name = safeName(input.name);
    if (!input.body.length) throw new UploadError('upload.empty');
    if (input.body.length > MAX_UPLOAD_BYTES) throw new UploadError('upload.too_large', { mb: MAX_UPLOAD_BYTES / 1024 / 1024 }, 413);
    const sniffed = sniff(input.body);
    let kind: UploadKind; let mime: string; let text: string | null = null; let pages: number | null = null;
    if (sniffed === 'pdf') {
      kind = 'pdf'; mime = 'application/pdf';
      const result = pdfText(input.body);
      if (!result.ok) {
        const reason = { not_pdf: 'upload.pdf_not_pdf', encrypted: 'upload.pdf_encrypted', no_text: 'upload.pdf_no_text', damaged: 'upload.pdf_damaged' }[result.reason] as StoreMessageKey;
        throw new UploadError(reason, {}, 415);
      }
      text = result.text; pages = result.pages;
    } else if (sniffed) {
      kind = 'image'; mime = Object.entries(IMAGE_TYPES).find(([, ext]) => ext === sniffed)![0];
      if (input.body.length > MAX_IMAGE_BYTES) throw new UploadError('upload.image_too_large', { mb: MAX_IMAGE_BYTES / 1024 / 1024 }, 413);
    } else {
      const decoded = input.body.toString('utf8');
      const looksText = /^text\//iu.test(input.mime) || /^application\/(json|xml|x-yaml|yaml|csv)/iu.test(input.mime) || TEXT_EXT.test(name);
      if (!looksText || decoded.includes('\u0000') || (decoded.match(/�/gu)?.length ?? 0) > decoded.length / 100) {
        throw new UploadError('upload.unsupported', {}, 415);
      }
      kind = 'text'; mime = input.mime.split(';')[0]?.trim() || 'text/plain'; text = decoded.replace(/^﻿/u, '');
    }
    const id = randomUUID();
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(join(this.#dir, id), input.body, { flag: 'wx' });
    const sha256 = createHash('sha256').update(input.body).digest('hex');
    this.#db.prepare('INSERT INTO uploads (id, name, mime, kind, size, sha256, text, pages, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, mime, kind, input.body.length, sha256, text, pages, this.#now());
    return this.view(this.get(id)!);
  }

  get(id: string): Upload | undefined {
    return this.#db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as Upload | undefined;
  }

  view(upload: Upload): UploadView {
    const { text, ...rest } = upload;
    return { ...rest, chars: text === null ? null : text.length };
  }

  image(upload: Upload): ImageRef {
    return { mediaType: upload.mime, data: readFileSync(join(this.#dir, upload.id)).toString('base64') };
  }
}

export const ATTACHMENT_OPEN = storeText(DEFAULT_LANGUAGE, 'attachment.open');
export const ATTACHMENT_CLOSE = storeText(DEFAULT_LANGUAGE, 'attachment.close');

export function attachmentBlock(upload: Upload, language: Language = DEFAULT_LANGUAGE): string {
  const text = upload.text ?? '';
  const cut = text.length > MAX_INLINE_CHARS;
  const t = (key: StoreMessageKey, params?: MessageParams) => storeText(language, key, params);
  return [
    `${t('attachment.open')}: ${upload.name}（${upload.kind === 'pdf' ? t('attachment.pdf', { pages: upload.pages ?? '' }) : t('attachment.text')}）>>>`,
    t('attachment.notice'),
    text.slice(0, MAX_INLINE_CHARS),
    cut ? t('attachment.cut', { max: MAX_INLINE_CHARS.toLocaleString('en-US'), total: text.length.toLocaleString('en-US') }) : '',
    t('attachment.close'),
  ].filter(Boolean).join('\n');
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export function stripAttachments(text: string): string {
  let result = text;
  for (const language of LANGUAGES) {
    const open = escapeRegExp(storeText(language, 'attachment.open'));
    const close = escapeRegExp(storeText(language, 'attachment.close'));
    result = result.replace(new RegExp(`\\n*${open}[\\s\\S]*?${close}`, 'gu'), '');
  }
  return result.trim();
}
