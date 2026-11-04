const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:sk|or-v1)-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
];
const URL_CREDENTIAL = /(?:https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const PRIVATE_KEY_MARKER = /-----(BEGIN|END) (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
const SENSITIVE_ASSIGNMENT =
  /(?<![A-Za-z0-9_])([0-9]*)(["']?)([A-Za-z_][A-Za-z0-9_]*)(["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi;
const SENSITIVE_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|SESSION_KEY|AUTH|AUTHORIZATION|COOKIE|COOKIES|CREDENTIAL|CREDENTIALS|PRIVATE_KEY)(?:_|$)/i;

export interface SanitizedModelInputText {
  readonly text: string;
  readonly redaction_count: number;
}

export function isSensitiveName(input: string): boolean {
  const normalized = input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toUpperCase();
  return SENSITIVE_NAME.test(normalized);
}

export function sanitizeModelInputText(input: string): SanitizedModelInputText {
  let text = input;
  let redactionCount = 0;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      redactionCount += 1;
      return '[REDACTED]';
    });
  }
  const jwt = redactJwt(text);
  text = jwt.text;
  redactionCount += jwt.redaction_count;
  text = text.replace(URL_CREDENTIAL, () => { redactionCount += 1; return '[REDACTED]'; });
  const keys = redactPrivateKeys(text);
  text = keys.text;
  redactionCount += keys.redaction_count;
  return Object.freeze({ text, redaction_count: redactionCount });
}

interface Segment { readonly start: number; readonly end: number; readonly last_word_end: number; readonly candidate?: number; }

function redactJwt(input: string): SanitizedModelInputText {
  const ranges: Array<readonly [number, number]> = [];
  let cursor = 0;
  let previous: Segment[] = [];
  while (cursor < input.length) {
    if (!isBase64Url(input.charCodeAt(cursor))) { cursor += 1; continue; }
    const start = cursor;
    let candidate: number | undefined, lastWordEnd = start;
    while (cursor < input.length && isBase64Url(input.charCodeAt(cursor))) {
      if (candidate === undefined && input.startsWith('eyJ', cursor) && !isWord(input.charCodeAt(cursor - 1))) candidate = cursor;
      if (isWord(input.charCodeAt(cursor))) lastWordEnd = cursor + 1;
      cursor += 1;
    }
    const segment: Segment = { start, end: cursor, last_word_end: lastWordEnd, ...(candidate === undefined || candidate + 3 >= cursor ? {} : { candidate }) };
    const last = previous.at(-1);
    if (last === undefined || start !== last.end + 1 || input[last.end] !== '.') previous = [];
    previous.push(segment);
    if (previous.length < 3) continue;
    const first = previous[0]!;
    if (first.candidate !== undefined && segment.last_word_end > segment.start) {
      ranges.push([first.candidate, segment.last_word_end]);
      previous = [];
    } else previous.shift();
  }
  return replaceRanges(input, ranges);
}

function redactPrivateKeys(input: string): SanitizedModelInputText {
  const ranges: Array<readonly [number, number]> = [];
  let start: number | undefined;
  for (const match of input.matchAll(PRIVATE_KEY_MARKER)) {
    if (match[1] === 'BEGIN' && start === undefined) start = match.index;
    else if (match[1] === 'END' && start !== undefined) {
      ranges.push([start, match.index + match[0].length]);
      start = undefined;
    }
  }
  return replaceRanges(input, ranges);
}
function replaceRanges(input: string, ranges: readonly (readonly [number, number])[]): SanitizedModelInputText {
  if (ranges.length === 0) return { text: input, redaction_count: 0 };
  const parts: string[] = [];
  let start = 0;
  for (const [from, to] of ranges) { parts.push(input.slice(start, from), '[REDACTED]'); start = to; }
  parts.push(input.slice(start));
  return { text: parts.join(''), redaction_count: ranges.length };
}
function isWord(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95;
}
function isBase64Url(code: number): boolean { return isWord(code) || code === 45; }

export function redactSecrets(input: string, exactSecrets: readonly string[] = []): string {
  let redacted = input;
  for (const secret of exactSecrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
  }
  redacted = sanitizeModelInputText(redacted).text;
  redacted = redacted.replace(
    SENSITIVE_ASSIGNMENT,
    // A name is scanned only from its start. Preserve leading digits because
    // the legacy matcher also recognized assignments in e.g. `1api_key=value`.
    (match, digits: string, quote: string, name: string, separator: string) =>
      isSensitiveName(name)
        ? `${digits}${quote}${name}${separator}[REDACTED]`
        : match,
  );
  return redacted;
}

export function redactDisplaySnapshot(input: string): string {
  const assignment=/(?:["']?)([A-Za-z_][A-Za-z0-9_-]*)(?:["']?)\s*[:=]\s*(["'])/g;
  for(const match of input.matchAll(assignment)) {
    if(!isSensitiveName(match[1]!))continue;
    let closed=false;
    for(let i=match.index!+match[0].length;i<input.length;i++) {
      if(input[i]==='\\'){i++;continue;}
      if(input[i]===match[2]){closed=true;break;}
    }
    if(!closed)return redactSecrets(input.slice(0,match.index))+'[REDACTED]';
  }
  return redactSecrets(input);
}
