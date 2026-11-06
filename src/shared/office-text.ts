import { localName, parseXml } from './xml.ts';
import type { XmlHandlers } from './xml.ts';
import type { ZipArchive } from './zip.ts';

export const OFFICE_TEXT_MAX = 200_000;

export type OfficeFailure = 'encrypted' | 'damaged' | 'too_large' | 'dtd' | 'no_text';
export type OfficeText = { ok: true; text: string; truncated: boolean } | { ok: false; reason: OfficeFailure; detail?: string };

export function officeKind(bytes: Uint8Array): 'zip' | 'cfb' | 'other' {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip';
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1) return 'cfb';
  return 'other';
}

export function docxText(zip: ZipArchive): OfficeText {
  const entry = zip.read('word/document.xml');
  if (!entry.ok) {
    if (entry.reason === 'missing') return { ok: false, reason: 'damaged', detail: 'word/document.xml' };
    if (entry.reason === 'too_large' || entry.reason === 'ratio') return { ok: false, reason: 'too_large', detail: entry.reason };
    return { ok: false, reason: 'damaged', detail: entry.reason };
  }
  let source = entry.data.toString('utf8');
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);

  const parts: string[] = [];
  let truncated = false;
  const add = (value: string): void | 'stop' => {
    if (parts.length + value.length > OFFICE_TEXT_MAX) {
      parts.push(value.slice(0, Math.max(0, OFFICE_TEXT_MAX - parts.length)));
      truncated = true;
      return 'stop';
    }
    parts.push(value);
  };

  let inT = 0;
  const handlers: XmlHandlers = {
    open: (name) => {
      const local = localName(name);
      if (local === 't') { inT += 1; return; }
      if (local === 'tab') return add('\t');
      if (local === 'br' || local === 'cr') return add('\n');
    },
    close: (name) => {
      const local = localName(name);
      if (local === 't') { inT = Math.max(0, inT - 1); return; }
      if (local === 'p') return add('\n');
    },
    text: (value) => {
      if (inT === 0) return;
      return add(value);
    },
  };

  const result = parseXml(source, handlers);
  if (!result.ok) {
    if (result.reason === 'dtd') return { ok: false, reason: 'dtd' };
    if (result.reason === 'too_large') return { ok: false, reason: 'too_large' };
    return { ok: false, reason: 'damaged', detail: 'xml' };
  }

  const text = parts.join('')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text === '') return { ok: false, reason: 'no_text' };
  return { ok: true, text, truncated };
}
