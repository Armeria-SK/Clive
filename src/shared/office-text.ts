import type { Language } from '../config/schema.ts';
import { toolText } from './messages/tools.ts';
import { localName, parseXml } from './xml.ts';
import type { XmlHandlers, XmlResult } from './xml.ts';
import type { ZipArchive } from './zip.ts';

export const OFFICE_TEXT_MAX = 200_000;

const XLSX_MAX_SHEETS = 256;
const XLSX_MAX_STRINGS = 200_000;
const XLSX_MAX_CELLS = 1_000_000;
const XLSX_MAX_COLUMN = 16_383;
const WORKSHEET_PATH = /^xl\/worksheets\/[^/]+\.xml$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

export type OfficeFailure = 'encrypted' | 'damaged' | 'too_large' | 'dtd' | 'no_text';
export type OfficeText = { ok: true; text: string; truncated: boolean; countLimit?: true } | { ok: false; reason: OfficeFailure; detail?: string };

type OfficeError = Extract<OfficeText, { ok: false }>;
type Part = { source: string } | { missing: true } | { error: OfficeError };

export function officeKind(bytes: Uint8Array): 'zip' | 'cfb' | 'other' {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip';
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1) return 'cfb';
  return 'other';
}

function readPart(zip: ZipArchive, name: string): Part {
  const entry = zip.read(name);
  if (!entry.ok) {
    if (entry.reason === 'missing') return { missing: true };
    return { error: { ok: false, reason: entry.reason === 'too_large' || entry.reason === 'ratio' ? 'too_large' : 'damaged', detail: entry.reason } };
  }
  const source = entry.data.toString('utf8');
  return { source: source.charCodeAt(0) === 0xfeff ? source.slice(1) : source };
}

function xmlError(result: Extract<XmlResult, { ok: false }>): OfficeError {
  if (result.reason === 'dtd' || result.reason === 'too_large') return { ok: false, reason: result.reason };
  return { ok: false, reason: 'damaged', detail: 'xml' };
}

function clip(value: string, room: number): string {
  if (room <= 0) return '';
  if (value.length <= room) return value;
  let end = room;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

export function docxText(zip: ZipArchive): OfficeText {
  const part = readPart(zip, 'word/document.xml');
  if ('missing' in part) return { ok: false, reason: 'damaged', detail: 'word/document.xml' };
  if ('error' in part) return part.error;

  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  const add = (value: string): void | 'stop' => {
    if (used + value.length > OFFICE_TEXT_MAX) {
      parts.push(clip(value, OFFICE_TEXT_MAX - used));
      truncated = true;
      return 'stop';
    }
    parts.push(value);
    used += value.length;
  };

  let inT = 0;
  let inTabs = 0;
  const handlers: XmlHandlers = {
    open: (name) => {
      const local = localName(name);
      if (local === 't') { inT += 1; return; }
      if (local === 'tabs') { inTabs += 1; return; }
      if (local === 'tab') return inTabs === 0 ? add('\t') : undefined;
      if (local === 'br' || local === 'cr') return add('\n');
    },
    close: (name) => {
      const local = localName(name);
      if (local === 't') { inT = Math.max(0, inT - 1); return; }
      if (local === 'tabs') { inTabs = Math.max(0, inTabs - 1); return; }
      if (local === 'p') return add('\n');
    },
    text: (value) => {
      if (inT === 0) return;
      return add(value);
    },
  };

  const result = parseXml(part.source, handlers);
  if (!result.ok) return xmlError(result);

  const text = parts.join('')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text === '') return { ok: false, reason: 'no_text' };
  return { ok: true, text, truncated };
}

function worksheetPath(target: string): string | undefined {
  const absolute = target.startsWith('/');
  const parts = absolute ? [] : ['xl'];
  for (const segment of (absolute ? target.slice(1) : target).split('/')) {
    if (segment === '') return undefined;
    if (segment === '.') continue;
    if (segment === '..') {
      if (parts.pop() === undefined) return undefined;
      continue;
    }
    parts.push(segment);
  }
  const path = parts.join('/');
  return WORKSHEET_PATH.test(path) ? path : undefined;
}

function relationshipId(attrs: Readonly<Record<string, string>>): string | undefined {
  for (const key of Object.keys(attrs)) {
    if (key.includes(':') && localName(key) === 'id') return attrs[key];
  }
  return undefined;
}

function columnOf(ref: string | undefined): number | undefined {
  if (ref === undefined) return undefined;
  let letters = 0;
  let column = 0;
  while (letters < 4) {
    const lower = ref.charCodeAt(letters) | 0x20;
    if (lower < 97 || lower > 122) break;
    column = column * 26 + (lower - 96);
    letters += 1;
  }
  if (letters === 0 || letters > 3 || letters === ref.length) return undefined;
  for (let i = letters; i < ref.length; i++) {
    const digit = ref.charCodeAt(i);
    if (digit < 48 || digit > 57) return undefined;
  }
  return column - 1 <= XLSX_MAX_COLUMN ? column - 1 : undefined;
}

function buildRow(columns: readonly number[], texts: readonly string[], ordered: boolean, limit: number): string {
  const order = ordered ? undefined : texts.map((_, index) => index).sort((a, b) => columns[a]! - columns[b]!);
  let row = '';
  let previous = 0;
  for (let n = 0; n < texts.length && row.length < limit; n++) {
    const index = order ? order[n]! : n;
    const column = columns[index]!;
    row += '\t'.repeat(Math.min(n === 0 ? column : Math.max(1, column - previous), limit - row.length));
    previous = column;
    if (row.length >= limit) break;
    row += texts[index]!.slice(0, limit - row.length);
  }
  return row;
}

export function xlsxText(zip: ZipArchive, language: Language): OfficeText {
  const book = readPart(zip, 'xl/workbook.xml');
  if ('missing' in book) return { ok: false, reason: 'damaged', detail: 'xl/workbook.xml' };
  if ('error' in book) return book.error;

  let truncated = false;
  let countCut = false;
  const sheets: Array<{ name: string; id: string | undefined }> = [];
  const bookResult = parseXml(book.source, {
    open: (name, attrs) => {
      if (localName(name) !== 'sheet') return;
      if (sheets.length >= XLSX_MAX_SHEETS) { countCut = true; return 'stop'; }
      sheets.push({ name: attrs['name'] ?? '', id: relationshipId(attrs) });
    },
  });
  if (!bookResult.ok) return xmlError(bookResult);

  let targets: Map<string, string | undefined> | undefined;
  const rels = readPart(zip, 'xl/_rels/workbook.xml.rels');
  if ('error' in rels) return rels.error;
  if ('source' in rels) {
    const wanted = new Set<string>();
    for (const sheet of sheets) if (sheet.id !== undefined) wanted.add(sheet.id);
    const found = new Map<string, string | undefined>();
    const relsResult = parseXml(rels.source, {
      open: (name, attrs) => {
        if (localName(name) !== 'Relationship') return;
        const id = attrs['Id'];
        const target = attrs['Target'];
        if (id === undefined || target === undefined || !wanted.has(id) || found.has(id)) return;
        found.set(id, attrs['TargetMode'] === 'External' ? undefined : worksheetPath(target));
      },
    });
    if (!relsResult.ok) return xmlError(relsResult);
    targets = found;
  }

  const strings: string[] = [];
  const shared = readPart(zip, 'xl/sharedStrings.xml');
  if ('error' in shared) return shared.error;
  if ('source' in shared) {
    let inSi = false;
    let inT = 0;
    let inPhonetic = 0;
    let current = '';
    const sharedResult = parseXml(shared.source, {
      open: (name) => {
        const local = localName(name);
        if (local === 'si') {
          if (strings.length >= XLSX_MAX_STRINGS) { countCut = true; return 'stop'; }
          inSi = true;
          inT = 0;
          inPhonetic = 0;
          current = '';
        } else if (inSi) {
          if (local === 't') inT += 1;
          else if (local === 'rPh') inPhonetic += 1;
        }
      },
      close: (name) => {
        const local = localName(name);
        if (local === 'si') {
          if (inSi) strings.push(current);
          inSi = false;
        } else if (inSi) {
          if (local === 't') inT = Math.max(0, inT - 1);
          else if (local === 'rPh') inPhonetic = Math.max(0, inPhonetic - 1);
        }
      },
      text: (value) => {
        if (inSi && inT > 0 && inPhonetic === 0) current += value;
      },
    });
    if (!sharedResult.ok) return xmlError(sharedResult);
  }

  const lines: string[] = [];
  let used = 0;
  let hasRow = false;
  let stopped = false;
  let cellsSeen = 0;
  let sheetsRead = 0;
  const roomLeft = (): number => OFFICE_TEXT_MAX - used - (lines.length > 0 ? 1 : 0);
  const push = (line: string): boolean => {
    const room = roomLeft();
    const fit = clip(line, room);
    if (room < 0 || (fit === '' && line !== '')) { truncated = true; return false; }
    lines.push(fit);
    used += (lines.length > 1 ? 1 : 0) + fit.length;
    if (fit.length < line.length) { truncated = true; return false; }
    return true;
  };

  for (let i = 0; i < sheets.length && !stopped; i++) {
    const sheet = sheets[i]!;
    const path = targets === undefined ? `xl/worksheets/sheet${i + 1}.xml` : sheet.id === undefined ? undefined : targets.get(sheet.id);
    if (path === undefined) continue;
    const part = readPart(zip, path);
    if ('missing' in part) continue;
    if ('error' in part) return part.error;
    sheetsRead += 1;
    if ((lines.length > 0 && !push('')) || !push(toolText(language, 'doc.sheet', { name: sheet.name.replace(CONTROL, ' ') }))) break;

    let columns: number[] = [];
    let texts: string[] = [];
    let rowChars = 0;
    let ordered = true;
    let lastColumn = -1;
    let previousColumn = -1;
    let inCell = false;
    let inValue = false;
    let inInline = false;
    let inT = 0;
    let inPhonetic = 0;
    let cellColumn = 0;
    let cellType = '';
    let hasValue = false;
    let valueText = '';
    let inlineText = '';

    const flushRow = (): boolean => {
      if (texts.length === 0) return true;
      const room = roomLeft();
      const row = buildRow(columns, texts, ordered, Math.max(room + 1, 0));
      columns = [];
      texts = [];
      rowChars = 0;
      ordered = true;
      lastColumn = -1;
      hasRow = true;
      return push(row);
    };
    const endCell = (): void | 'stop' => {
      if (!inCell) return;
      inCell = false;
      let text: string;
      if (cellType === 's') {
        const index = valueText.trim();
        text = hasValue && /^[0-9]+$/.test(index) ? (strings[Number(index)] ?? '') : '';
      } else if (cellType === 'inlineStr') {
        text = inlineText;
      } else if (cellType === 'b') {
        text = hasValue ? (valueText.trim() === '1' ? 'TRUE' : 'FALSE') : '';
      } else {
        text = valueText;
      }
      text = text.replace(CONTROL, ' ');
      if (text === '') return;
      if (cellColumn < lastColumn) ordered = false;
      lastColumn = cellColumn;
      columns.push(cellColumn);
      texts.push(text);
      rowChars += text.length;
      if (rowChars + texts.length - 1 > roomLeft()) { stopped = true; return 'stop'; }
    };
    const endRow = (): void | 'stop' => {
      if (!flushRow()) { stopped = true; return 'stop'; }
    };

    const sheetResult = parseXml(part.source, {
      open: (name, attrs) => {
        switch (localName(name)) {
          case 'row': {
            if (texts.length > 0 && !flushRow()) { stopped = true; return 'stop'; }
            previousColumn = -1;
            return;
          }
          case 'c': {
            cellsSeen += 1;
            if (cellsSeen > XLSX_MAX_CELLS) { countCut = true; stopped = true; return 'stop'; }
            cellColumn = columnOf(attrs['r']) ?? previousColumn + 1;
            previousColumn = cellColumn;
            cellType = attrs['t'] ?? '';
            inCell = true;
            inValue = false;
            inInline = false;
            inT = 0;
            inPhonetic = 0;
            hasValue = false;
            valueText = '';
            inlineText = '';
            return;
          }
          case 'v': {
            if (inCell) { inValue = true; hasValue = true; }
            return;
          }
          case 'is': {
            if (inCell) inInline = true;
            return;
          }
          case 't': {
            if (inInline) inT += 1;
            return;
          }
          case 'rPh': {
            if (inInline) inPhonetic += 1;
            return;
          }
        }
      },
      close: (name) => {
        switch (localName(name)) {
          case 'row': return endRow();
          case 'c': return endCell();
          case 'v': { inValue = false; return; }
          case 'is': { inInline = false; return; }
          case 't': { inT = Math.max(0, inT - 1); return; }
          case 'rPh': { inPhonetic = Math.max(0, inPhonetic - 1); return; }
        }
      },
      text: (value) => {
        if (inValue) valueText += value;
        else if (inInline && inT > 0 && inPhonetic === 0) inlineText += value;
      },
    });
    if (!sheetResult.ok) return xmlError(sheetResult);
    if (!flushRow()) stopped = true;
  }

  if (sheetsRead === 0 || !hasRow) return { ok: false, reason: 'no_text' };
  const text = lines.join('\n');
  if (countCut && !truncated) return { ok: true, text, truncated: true, countLimit: true };
  return { ok: true, text, truncated: truncated || countCut };
}
