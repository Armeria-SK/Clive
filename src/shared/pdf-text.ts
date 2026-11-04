import { constants, inflateSync } from 'node:zlib';

export type PdfText = { ok: true; text: string; pages: number } | { ok: false; reason: 'not_pdf' | 'encrypted' | 'no_text' | 'damaged' };

const LIMITS = { text: 200_000, stream: 32 * 1024 * 1024, total: 96 * 1024 * 1024, objects: 200_000, pages: 2_000, depth: 32 } as const;
// Interfaces, not type literals, so a dictionary's type guard never takes them for a dictionary.
interface Ref { ref: number }
interface PdfName { name: string }
interface PdfBytes { bytes: string }
type Value = null | boolean | number | string | Ref | Value[] | Dict | PdfName | PdfBytes;
type Dict = { [key: string]: Value };
type Obj = { value: Value; stream?: string };
const isRef = (value: Value | undefined): value is Ref => !!value && typeof value === 'object' && 'ref' in value;
const isName = (value: Value | undefined): value is PdfName => !!value && typeof value === 'object' && 'name' in value;
const isBytes = (value: Value | undefined): value is PdfBytes => !!value && typeof value === 'object' && 'bytes' in value;
const isDict = (value: Value | undefined): value is Dict => !!value && typeof value === 'object' && !Array.isArray(value) && !isRef(value) && !isName(value) && !isBytes(value);
const WHITE = /[\x00\t\n\f\r ]/;
const DELIM = /[()<>[\]{}/%]/;

class Lexer {
  readonly src: string;
  at: number;
  constructor(src: string, at = 0) { this.src = src; this.at = at; }
  skip(): void {
    for (;;) {
      while (this.at < this.src.length && WHITE.test(this.src[this.at]!)) this.at++;
      if (this.src[this.at] !== '%') return;
      while (this.at < this.src.length && this.src[this.at] !== '\n' && this.src[this.at] !== '\r') this.at++;
    }
  }
  word(): string {
    const start = this.at;
    while (this.at < this.src.length && !WHITE.test(this.src[this.at]!) && !DELIM.test(this.src[this.at]!)) this.at++;
    return this.src.slice(start, this.at);
  }
  literal(): string {
    let depth = 1, out = ''; this.at++;
    while (this.at < this.src.length) {
      const c = this.src[this.at++]!;
      if (c === '\\') {
        const n = this.src[this.at++] ?? '';
        const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
        if (n in simple) out += simple[n];
        else if (/[0-7]/.test(n)) { let digits = n; while (digits.length < 3 && /[0-7]/.test(this.src[this.at] ?? '')) digits += this.src[this.at++]; out += String.fromCharCode(parseInt(digits, 8) & 0xff); }
        else if (n === '\r') { if (this.src[this.at] === '\n') this.at++; }
        else if (n !== '\n') out += n;
      } else if (c === '(') { depth++; out += c; }
      else if (c === ')') { if (--depth === 0) break; out += c; }
      else out += c;
    }
    return out;
  }
  hex(): string {
    const end = this.src.indexOf('>', this.at); const digits = this.src.slice(this.at + 1, end < 0 ? this.src.length : end).replace(/[^0-9A-Fa-f]/g, '');
    this.at = end < 0 ? this.src.length : end + 1;
    let out = ''; for (let i = 0; i < digits.length; i += 2) out += String.fromCharCode(parseInt((digits.slice(i, i + 2) + '0').slice(0, 2), 16));
    return out;
  }
  value(depth = 0): Value | { op: string } | undefined {
    if (depth > LIMITS.depth) throw new Error('nested');
    this.skip();
    if (this.at >= this.src.length) return undefined;
    const c = this.src[this.at]!;
    if (c === '(') return { bytes: this.literal() };
    if (c === '<' && this.src[this.at + 1] === '<') {
      this.at += 2; const dict: Dict = {};
      for (;;) {
        this.skip();
        if (this.src.startsWith('>>', this.at)) { this.at += 2; return dict; }
        if (this.at >= this.src.length) return dict;
        const key = this.value(depth + 1);
        if (!isName(key as Value)) { this.at++; continue; }
        const item = this.value(depth + 1);
        dict[(key as { name: string }).name] = item === undefined || (typeof item === 'object' && item !== null && 'op' in item) ? null : item as Value;
      }
    }
    if (c === '<') return { bytes: this.hex() };
    if (c === '[') {
      this.at++; const list: Value[] = [];
      for (;;) {
        this.skip();
        if (this.src[this.at] === ']') { this.at++; return list; }
        if (this.at >= this.src.length) return list;
        const item = this.value(depth + 1);
        if (item === undefined) return list;
        if (typeof item === 'object' && item !== null && 'op' in item) { if (item.op === 'R' && list.length >= 2) { list.pop(); list.push({ ref: Number(list.pop()) }); } continue; }
        list.push(item);
      }
    }
    if (c === '/') { this.at++; return { name: this.word() }; }
    if (c === ')' || c === '>' || c === ']' || c === '{' || c === '}') { this.at++; return { op: c }; }
    const word = this.word();
    if (!word) { this.at++; return { op: '' }; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      // "12 0 R" is a reference.
      const save = this.at; this.skip(); const generation = /^\d+$/.test(word) ? this.word() : '';
      if (/^\d+$/.test(generation)) { this.skip(); if (this.src[this.at] === 'R' && (this.at + 1 >= this.src.length || WHITE.test(this.src[this.at + 1]!) || DELIM.test(this.src[this.at + 1]!))) { this.at++; return { ref: Number(word) }; } }
      this.at = save; return Number(word);
    }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return { op: word };
  }
}

function inflate(data: string, budget: { left: number }): string | undefined {
  try {
    const out = inflateSync(Buffer.from(data, 'latin1'), { maxOutputLength: Math.min(LIMITS.stream, budget.left), finishFlush: constants.Z_SYNC_FLUSH });
    budget.left -= out.length; return out.toString('latin1');
  } catch { return undefined; }
}

class Document {
  objects = new Map<number, Obj>();
  budget = { left: LIMITS.total };
  readonly src: string;
  constructor(src: string) {
    this.src = src;
    const head = /(\d+)\s+(\d+)\s+obj\b/g;
    let match: RegExpExecArray | null; let count = 0;
    while ((match = head.exec(src)) && count++ < LIMITS.objects) {
      const lexer = new Lexer(src, match.index + match[0].length);
      let value: Value | { op: string } | undefined;
      try { value = lexer.value(); } catch { continue; }
      if (value === undefined || (typeof value === 'object' && value !== null && 'op' in value)) continue;
      const obj: Obj = { value: value as Value };
      lexer.skip();
      if (src.startsWith('stream', lexer.at)) {
        let start = lexer.at + 6; if (src[start] === '\r') start++; if (src[start] === '\n') start++;
        const declared = isDict(obj.value) ? (obj.value as Dict).Length : undefined;
        const length = typeof declared === 'number' ? declared : -1;
        let end = length >= 0 && /^\s*endstream/.test(src.slice(start + length, start + length + 12)) ? start + length : src.indexOf('endstream', start);
        if (end < 0) end = src.length;
        obj.stream = src.slice(start, end);
        head.lastIndex = end;
      }
      this.objects.set(Number(match[1]), obj);
    }
    // Objects packed in object streams fill numbers no plain object defines.
    for (const obj of [...this.objects.values()]) {
      const info = isDict(obj.value) ? obj.value as Dict : undefined;
      if (!info || !isName(info.Type) || info.Type.name !== 'ObjStm') continue;
      const data = this.data(obj); const n = Number(info.N), first = Number(info.First);
      if (!data || !Number.isSafeInteger(n) || !Number.isSafeInteger(first)) continue;
      const header = data.slice(0, first).trim().split(/\s+/).map(Number);
      for (let i = 0; i < n && i * 2 + 1 < header.length; i++) {
        const number = header[i * 2]!, offset = header[i * 2 + 1]!;
        if (this.objects.has(number)) continue;
        try { const value = new Lexer(data, first + offset).value(); if (value !== undefined && !(typeof value === 'object' && value !== null && 'op' in value)) this.objects.set(number, { value: value as Value }); } catch { }
      }
    }
  }
  get(value: Value | undefined, seen = 0): Value | undefined {
    let current = value;
    while (isRef(current) && seen++ < 16) current = this.objects.get(current.ref)?.value;
    return current;
  }
  dict(value: Value | undefined): Dict | undefined { const found = this.get(value); return isDict(found) ? found : undefined; }
  data(obj: Obj | undefined): string | undefined {
    if (!obj?.stream) return undefined;
    const dict = isDict(obj.value) ? obj.value : {};
    const filter = this.get(dict.Filter);
    const filters = (Array.isArray(filter) ? filter : filter === undefined || filter === null ? [] : [filter]).map(item => isName(this.get(item)) ? (this.get(item) as { name: string }).name : '');
    let data: string | undefined = obj.stream;
    for (const name of filters) {
      if (name === 'FlateDecode' || name === 'Fl') data = data === undefined ? undefined : inflate(data, this.budget);
      else return undefined;
    }
    return data;
  }
  stream(value: Value | undefined): string | undefined {
    let current = value, guard = 0;
    while (isRef(current) && guard++ < 16) { const obj = this.objects.get(current.ref); if (obj?.stream !== undefined) return this.data(obj); current = obj?.value; }
    return undefined;
  }
  pages(): Dict[] {
    const catalog = [...this.objects.values()].find(obj => isDict(obj.value) && isName(obj.value.Type) && obj.value.Type.name === 'Catalog');
    const pages: Dict[] = [];
    const walk = (node: Value | undefined, inherited: Value | undefined, depth: number) => {
      const dict = this.dict(node);
      if (!dict || depth > LIMITS.depth || pages.length >= LIMITS.pages) return;
      const resources = dict.Resources ?? inherited;
      const kids = this.get(dict.Kids);
      if (Array.isArray(kids)) for (const kid of kids) walk(kid, resources, depth + 1);
      else pages.push({ ...dict, Resources: resources ?? null });
    };
    if (catalog && isDict(catalog.value)) walk(catalog.value.Pages, undefined, 0);
    if (pages.length) return pages;
    // Without a readable catalog, every page object in file order.
    return [...this.objects.values()].filter(obj => isDict(obj.value) && isName(obj.value.Type) && obj.value.Type.name === 'Page').map(obj => obj.value as Dict).slice(0, LIMITS.pages);
  }
}

type Font = { width: number[]; map: Map<string, string> | null; twoByte: boolean };
function cmap(data: string): { widths: number[]; map: Map<string, string> } {
  const map = new Map<string, string>(), widths = new Set<number>();
  const utf16 = (bytes: string) => { let out = ''; for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.charCodeAt(i) << 8 | bytes.charCodeAt(i + 1)); return out; };
  for (const block of data.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) for (const range of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) widths.add(range[1]!.length / 2);
  const hex = (value: string) => { let out = ''; const digits = value.replace(/\s/g, ''); for (let i = 0; i < digits.length; i += 2) out += String.fromCharCode(parseInt(digits.slice(i, i + 2), 16)); return out; };
  for (const block of data.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const pair of block[1]!.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]*)>/g)) map.set(hex(pair[1]!), utf16(hex(pair[2]!)));
  for (const block of data.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f\s]*)>|\[([^\]]*)\])/g)) {
      const low = parseInt(range[1]!, 16), high = parseInt(range[2]!, 16), size = range[1]!.length / 2;
      if (!(high >= low) || high - low > 65_535) continue;
      const code = (value: number) => hex(value.toString(16).padStart(size * 2, '0'));
      if (range[4] !== undefined) [...range[4].matchAll(/<([0-9A-Fa-f\s]*)>/g)].forEach((item, index) => { if (low + index <= high) map.set(code(low + index), utf16(hex(item[1]!))); });
      else {
        const start = utf16(hex(range[3]!)); if (!start) continue;
        const last = start.charCodeAt(start.length - 1);
        for (let value = low; value <= high; value++) map.set(code(value), start.slice(0, -1) + String.fromCharCode(last + value - low));
      }
    }
  }
  return { widths: [...widths].sort((a, b) => b - a), map };
}
function fontOf(doc: Document, font: Value | undefined): Font {
  const dict = doc.dict(font) ?? {};
  const twoByte = isName(doc.get(dict.Subtype)) && (doc.get(dict.Subtype) as { name: string }).name === 'Type0';
  const data = doc.stream(dict.ToUnicode);
  if (!data) return { width: [twoByte ? 2 : 1], map: null, twoByte };
  const parsed = cmap(data);
  return { width: parsed.widths.length ? parsed.widths : [twoByte ? 2 : 1], map: parsed.map, twoByte };
}
function decode(bytes: string, font: Font | undefined): string {
  if (!font?.map) return font?.twoByte ? '' : bytes.replace(/[\x00-\x1f]/g, ' ');
  let out = '';
  for (let i = 0; i < bytes.length;) {
    let done = false;
    for (const width of font.width) {
      const code = bytes.slice(i, i + width);
      const text = font.map.get(code);
      if (text !== undefined) { out += text; i += width; done = true; break; }
    }
    if (!done) i += font.width.at(-1) ?? 1;
  }
  return out;
}

function pageText(doc: Document, page: Dict): string {
  const contents = doc.get(page.Contents);
  const data = (Array.isArray(contents) ? contents : [page.Contents]).map(item => doc.stream(item) ?? '').join('\n');
  if (!data) return '';
  const resources = doc.dict(page.Resources) ?? {}, fonts = doc.dict(resources.Font) ?? {};
  const cache = new Map<string, Font>();
  const lexer = new Lexer(data);
  let out = '', font: Font | undefined, operands: Value[] = [], lastY: number | undefined;
  const newline = () => { if (out && !out.endsWith('\n')) out += '\n'; };
  for (let guard = 0; guard < 5_000_000; guard++) {
    let token: Value | { op: string } | undefined;
    try { token = lexer.value(); } catch { break; }
    if (token === undefined) break;
    if (!(typeof token === 'object' && token !== null && 'op' in token)) { operands.push(token); if (operands.length > 64) operands.shift(); continue; }
    const op = token.op;
    if (op === 'BI') { const end = data.indexOf('EI', lexer.at); lexer.at = end < 0 ? data.length : end + 2; operands = []; continue; }
    if (op === 'Tf' && isName(operands[0])) { const name = operands[0].name; if (!cache.has(name)) cache.set(name, fontOf(doc, fonts[name])); font = cache.get(name); }
    else if (op === 'Tj' && isBytes(operands.at(-1))) out += decode((operands.at(-1) as { bytes: string }).bytes, font);
    else if ((op === "'" || op === '"') && isBytes(operands.at(-1))) { newline(); out += decode((operands.at(-1) as { bytes: string }).bytes, font); }
    else if (op === 'TJ' && Array.isArray(operands.at(-1))) {
      for (const item of operands.at(-1) as Value[]) {
        if (isBytes(item)) out += decode(item.bytes, font);
        else if (typeof item === 'number' && item <= -250 && !font?.twoByte && !out.endsWith(' ')) out += ' ';
      }
    } else if ((op === 'Td' || op === 'TD') && typeof operands[1] === 'number' && operands[1] !== 0) newline();
    else if (op === 'T*') newline();
    else if (op === 'Tm' && typeof operands[5] === 'number') { if (lastY !== undefined && Math.abs(operands[5] - lastY) > 0.5) newline(); lastY = operands[5]; }
    else if (op === 'ET') newline();
    operands = [];
    if (out.length > LIMITS.text) break;
  }
  return out;
}

export function pdfText(bytes: Uint8Array): PdfText {
  const src = Buffer.from(bytes).toString('latin1');
  if (!src.startsWith('%PDF-')) return { ok: false, reason: 'not_pdf' };
  if (/\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(src)) return { ok: false, reason: 'encrypted' };
  try {
    const doc = new Document(src), pages = doc.pages();
    if (!pages.length) return { ok: false, reason: 'damaged' };
    const parts: string[] = [];
    let length = 0;
    for (const page of pages) {
      const text = pageText(doc, page).split('\n').map(line => line.replace(/[\s　]+$/u, '').replace(/^\s+/u, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      parts.push(text); length += text.length;
      if (length > LIMITS.text) break;
    }
    const text = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, LIMITS.text);
    return text ? { ok: true, text, pages: pages.length } : { ok: false, reason: 'no_text' };
  } catch { return { ok: false, reason: 'damaged' }; }
}
