export interface XmlLimits { maxChars: number; maxDepth: number; maxAttrs: number; maxNameLength: number }

export const XML_LIMITS: XmlLimits = Object.freeze({ maxChars: 32 * 1024 * 1024, maxDepth: 256, maxAttrs: 256, maxNameLength: 256 });

export interface XmlHandlers {
  open?(name: string, attrs: Readonly<Record<string, string>>, selfClosing: boolean): void | 'stop';
  close?(name: string): void | 'stop';
  text?(text: string): void | 'stop';
}

export type XmlResult = { ok: true; stopped: boolean } | { ok: false; reason: 'dtd' | 'too_large' | 'too_deep' | 'malformed' };

const TAB = 9, LF = 10, CR = 13, SPACE = 32, BANG = 33, DQUOTE = 34, HASH = 35, SQUOTE = 39;
const DASH = 45, DOT = 46, SLASH = 47, COLON = 58, SEMI = 59, LT = 60, EQ = 61, GT = 62, QUESTION = 63, UNDERSCORE = 95, LOWER_X = 120;

const NAMED: ReadonlyArray<readonly [string, string]> = [['lt;', '<'], ['gt;', '>'], ['amp;', '&'], ['quot;', '"'], ['apos;', "'"]];
const NO_ATTRS: Readonly<Record<string, string>> = Object.freeze(Object.create(null) as Record<string, string>);

const fail = (reason: 'dtd' | 'too_large' | 'too_deep' | 'malformed'): XmlResult => ({ ok: false, reason });
const done = (stopped: boolean): XmlResult => ({ ok: true, stopped });

const isSpace = (c: number): boolean => c === SPACE || c === TAB || c === LF || c === CR;
const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameStart = (c: number): boolean => isLetter(c) || c === UNDERSCORE || c === COLON || c >= 0x80;
const isNameChar = (c: number): boolean => isNameStart(c) || (c >= 48 && c <= 57) || c === DASH || c === DOT;

export function localName(qName: string): string {
  return qName.slice(qName.lastIndexOf(':') + 1);
}

function startsWithFold(source: string, at: number, lower: string): boolean {
  for (let i = 0; i < lower.length; i++) {
    if ((source.charCodeAt(at + i) | 0x20) !== lower.charCodeAt(i)) return false;
  }
  return true;
}

function hasDtd(source: string): boolean {
  let at = source.indexOf('<!');
  while (at >= 0) {
    if (startsWithFold(source, at + 2, 'doctype') || startsWithFold(source, at + 2, 'entity')) return true;
    at = source.indexOf('<!', at + 2);
  }
  return false;
}

function digitValue(c: number, base: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (base === 16) {
    const lower = c | 0x20;
    if (lower >= 97 && lower <= 102) return lower - 87;
  }
  return -1;
}

function codePointText(cp: number): string {
  if (cp === TAB || cp === LF || cp === CR) return String.fromCharCode(cp);
  if (cp < 0x20 || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === 0xffff || cp > 0x10ffff) return '\uFFFD';
  return String.fromCodePoint(cp);
}

function decodeEntities(raw: string): string {
  let amp = raw.indexOf('&');
  if (amp < 0) return raw;
  let out = '';
  let from = 0;
  while (amp >= 0) {
    let replacement: string | undefined;
    let end = amp + 1;
    if (raw.charCodeAt(amp + 1) === HASH) {
      let i = amp + 2;
      let base = 10;
      if (raw.charCodeAt(i) === LOWER_X) { base = 16; i++; }
      const digitsFrom = i;
      let cp = 0;
      for (;;) {
        const digit = digitValue(raw.charCodeAt(i), base);
        if (digit < 0) break;
        cp = Math.min(cp * base + digit, 0x110000);
        i++;
      }
      if (i > digitsFrom && raw.charCodeAt(i) === SEMI) { replacement = codePointText(cp); end = i + 1; }
    } else {
      for (const [name, char] of NAMED) {
        if (raw.startsWith(name, amp + 1)) { replacement = char; end = amp + 1 + name.length; break; }
      }
    }
    if (replacement === undefined) {
      amp = raw.indexOf('&', amp + 1);
    } else {
      out += raw.slice(from, amp) + replacement;
      from = end;
      amp = raw.indexOf('&', end);
    }
  }
  return out + raw.slice(from);
}

function nameEnd(source: string, start: number, maxLength: number): number {
  if (!isNameStart(source.charCodeAt(start))) return -1;
  let i = start + 1;
  while (isNameChar(source.charCodeAt(i))) {
    i++;
    if (i - start > maxLength) return -1;
  }
  return i;
}

function skipSpace(source: string, from: number): number {
  let i = from;
  while (isSpace(source.charCodeAt(i))) i++;
  return i;
}

export function parseXml(source: string, handlers: XmlHandlers, limits: Partial<XmlLimits> = {}): XmlResult {
  const maxChars = limits.maxChars ?? XML_LIMITS.maxChars;
  const maxDepth = limits.maxDepth ?? XML_LIMITS.maxDepth;
  const maxAttrs = limits.maxAttrs ?? XML_LIMITS.maxAttrs;
  const maxNameLength = limits.maxNameLength ?? XML_LIMITS.maxNameLength;
  if (source.length > maxChars) return fail('too_large');
  if (hasDtd(source)) return fail('dtd');

  const length = source.length;
  const stack: string[] = [];
  let pos = 0;
  while (pos < length) {
    if (source.charCodeAt(pos) !== LT) {
      const next = source.indexOf('<', pos);
      const end = next < 0 ? length : next;
      const text = decodeEntities(source.slice(pos, end));
      pos = end;
      if (handlers.text?.(text) === 'stop') return done(true);
      continue;
    }

    const kind = source.charCodeAt(pos + 1);
    if (kind === BANG) {
      if (source.startsWith('<!--', pos)) {
        const end = source.indexOf('-->', pos + 4);
        if (end < 0) return fail('malformed');
        pos = end + 3;
        continue;
      }
      if (source.startsWith('<![CDATA[', pos)) {
        const end = source.indexOf(']]>', pos + 9);
        if (end < 0) return fail('malformed');
        const text = source.slice(pos + 9, end);
        pos = end + 3;
        if (text.length > 0 && handlers.text?.(text) === 'stop') return done(true);
        continue;
      }
      return fail('malformed');
    }

    if (kind === QUESTION) {
      const end = source.indexOf('?>', pos + 2);
      if (end < 0) return fail('malformed');
      pos = end + 2;
      continue;
    }

    if (kind === SLASH) {
      const end = nameEnd(source, pos + 2, maxNameLength);
      if (end < 0) return fail('malformed');
      const name = source.slice(pos + 2, end);
      const gt = skipSpace(source, end);
      if (source.charCodeAt(gt) !== GT) return fail('malformed');
      if (stack[stack.length - 1] !== name) return fail('malformed');
      stack.pop();
      pos = gt + 1;
      if (handlers.close?.(name) === 'stop') return done(true);
      continue;
    }

    const nameStop = nameEnd(source, pos + 1, maxNameLength);
    if (nameStop < 0) return fail('malformed');
    const name = source.slice(pos + 1, nameStop);
    if (stack.length + 1 > maxDepth) return fail('too_deep');
    let attrs: Record<string, string> | undefined;
    let count = 0;
    let selfClosing = false;
    let i = nameStop;
    for (;;) {
      const afterSpace = skipSpace(source, i);
      const spaced = afterSpace > i;
      i = afterSpace;
      const c = source.charCodeAt(i);
      if (c === GT) { i++; break; }
      if (c === SLASH) {
        if (source.charCodeAt(i + 1) !== GT) return fail('malformed');
        selfClosing = true;
        i += 2;
        break;
      }
      if (!spaced) return fail('malformed');
      const attrEnd = nameEnd(source, i, maxNameLength);
      if (attrEnd < 0) return fail('malformed');
      const attrName = source.slice(i, attrEnd);
      i = skipSpace(source, attrEnd);
      if (source.charCodeAt(i) !== EQ) return fail('malformed');
      i = skipSpace(source, i + 1);
      const quote = source.charCodeAt(i);
      if (quote !== DQUOTE && quote !== SQUOTE) return fail('malformed');
      const valueEnd = source.indexOf(quote === DQUOTE ? '"' : "'", i + 1);
      if (valueEnd < 0) return fail('malformed');
      if (++count > maxAttrs) return fail('malformed');
      attrs ??= Object.create(null) as Record<string, string>;
      if (attrName in attrs) return fail('malformed');
      attrs[attrName] = decodeEntities(source.slice(i + 1, valueEnd));
      i = valueEnd + 1;
    }
    pos = i;
    if (handlers.open?.(name, attrs ?? NO_ATTRS, selfClosing) === 'stop') return done(true);
    if (selfClosing) {
      if (handlers.close?.(name) === 'stop') return done(true);
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0 ? done(false) : fail('malformed');
}
