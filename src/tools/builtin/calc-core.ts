// 計算の核。式を読んで数値を返す。成功と失敗を一つの型で返す（pdf-text.ts の PdfText と同じ形）

export type CalcErrorCode = 'syntax' | 'unknown_name' | 'bad_args' | 'not_finite' | 'too_long' | 'too_deep';
export type CalcResult = { ok: true; value: number } | { ok: false; code: CalcErrorCode; at?: number };

const MAX_CHARS = 500;
const MAX_DEPTH = 64;
// 名前（関数・定数）の表。Object.create(null) で、constructor や __proto__ の混入を防ぐ
const NAMES: Record<string, number | ((...args: number[]) => number)> = Object.create(null);
Object.assign(NAMES, {
  pi: Math.PI,
  e: Math.E,
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: (x: number, digits?: number) => (digits === undefined ? Math.round(x) : Number(Math.round(Number(`${x}e${digits}`)) + `e-${digits}`)),
  floor: Math.floor,
  ceil: Math.ceil,
  min: (...args: number[]) => Math.min(...args),
  max: (...args: number[]) => Math.max(...args),
  log: Math.log10,
  ln: Math.log,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
});

type Token = { kind: 'num'; value: number } | { kind: 'name'; value: string } | { kind: 'op'; value: string } | { kind: 'lparen' } | { kind: 'rparen' } | { kind: 'comma' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/u.test(c)) { i++; continue; }
    if (/[0-9.]/u.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/u.test(src[j]!)) j++;
      const body = src.slice(i, j);
      // 指数（1e3 / 2.5E-2）
      if (j < src.length && /[eE]/u.test(src[j]!)) {
        let k = j + 1;
        if (k < src.length && /[+-]/u.test(src[k]!)) k++;
        if (k < src.length && /[0-9]/u.test(src[k]!)) {
          while (k < src.length && /[0-9]/u.test(src[k]!)) k++;
          j = k;
        }
      }
      const value = Number(body);
      if (!Number.isFinite(value)) throw { code: 'syntax', at: i };
      tokens.push({ kind: 'num', value });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/u.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/u.test(src[j]!)) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/%^'.includes(c)) { tokens.push({ kind: 'op', value: c }); i++; continue; }
    if (c === '(') { tokens.push({ kind: 'lparen' }); i++; continue; }
    if (c === ')') { tokens.push({ kind: 'rparen' }); i++; continue; }
    if (c === ',') { tokens.push({ kind: 'comma' }); i++; continue; }
    throw { code: 'syntax', at: i };
  }
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  private depth = 0;
  constructor(tokens: Token[]) { this.tokens = tokens; }
  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token { const t = this.tokens[this.pos++]; if (!t) throw { code: 'syntax', at: undefined }; return t; }

  parse(): number {
    const value = this.parseExpr(0);
    if (this.pos < this.tokens.length) throw { code: 'syntax', at: undefined };
    return value;
  }

  // 左結合の + - を扱う層。precedence は「この層で扱う演算子の優先度」
  private parseExpr(minPrec: number): number {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== 'op') break;
      const prec = precedence(t.value);
      if (prec < minPrec) break;
      this.next();
      const right = this.parseExpr(prec + 1);
      left = apply(t.value, left, right);
    }
    return left;
  }

  // * / % を扱う層
  private parseTerm(): number {
    let left = this.parsePower();
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== 'op' || !'*/%'.includes(t.value)) break;
      this.next();
      const right = this.parsePower();
      left = apply(t.value, left, right);
    }
    return left;
  }

  // べき乗 ^（右結合）と、単項の + -
  private parsePower(): number {
    let base = this.parseUnary();
    const t = this.peek();
    if (t && t.kind === 'op' && t.value === '^') {
      this.next();
      const exp = this.parsePower();
      base = Math.pow(base, exp);
    }
    return base;
  }

  private parseUnary(): number {
    const t = this.peek();
    if (t && t.kind === 'op' && ('+-'.includes(t.value))) {
      this.next();
      const value = this.parsePower();
      return t.value === '-' ? -value : value;
    }
    return this.parseAtom();
  }

  private parseAtom(): number {
    const t = this.peek();
    if (!t) throw { code: 'syntax', at: undefined };
    if (t.kind === 'num') { this.next(); return t.value; }
    if (t.kind === 'name') {
      this.next();
      const entry = NAMES[t.value];
      if (entry === undefined) throw { code: 'unknown_name', at: undefined };
      if (typeof entry === 'number') return entry;
      // 関数：括弧と引数
      const next = this.peek();
      if (!next || next.kind !== 'lparen') throw { code: 'bad_args', at: undefined };
      this.next();
      this.depth++;
      if (this.depth > MAX_DEPTH) throw { code: 'too_deep', at: undefined };
      const args: number[] = [];
      if (this.peek()?.kind !== 'rparen') {
        for (;;) {
          args.push(this.parseExpr(0));
          const after = this.peek();
          if (!after) throw { code: 'syntax', at: undefined };
          if (after.kind === 'comma') { this.next(); continue; }
          if (after.kind === 'rparen') break;
          throw { code: 'syntax', at: undefined };
        }
      }
      this.next(); // rparen
      this.depth--;
      return callFunction(t.value, entry, args);
    }
    if (t.kind === 'lparen') {
      this.next();
      this.depth++;
      if (this.depth > MAX_DEPTH) throw { code: 'too_deep', at: undefined };
      const value = this.parseExpr(0);
      this.depth--;
      const after = this.peek();
      if (!after || after.kind !== 'rparen') throw { code: 'syntax', at: undefined };
      this.next();
      return value;
    }
    throw { code: 'syntax', at: undefined };
  }
}

function precedence(op: string): number {
  if ('+-'.includes(op)) return 1;
  if ('*/%'.includes(op)) return 2;
  return 0;
}

function apply(op: string, left: number, right: number): number {
  switch (op) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return left / right;
    case '%': return left % right;
    default: throw { code: 'syntax', at: undefined };
  }
}

function callFunction(name: string, fn: (...args: number[]) => number, args: number[]): number {
  if (name === 'round') {
    if (args.length < 1 || args.length > 2) throw { code: 'bad_args', at: undefined };
    const digits = args[1];
    if (digits !== undefined && (!Number.isInteger(digits) || digits < 0 || digits > 12)) throw { code: 'bad_args', at: undefined };
  } else {
    if (args.length < 1) throw { code: 'bad_args', at: undefined };
  }
  return fn(...args);
}

type CalcErr = { code: CalcErrorCode; at?: number };

function fail(code: CalcErrorCode, at?: number): CalcResult {
  return at === undefined ? { ok: false, code } : { ok: false, code, at };
}

export function evaluate(expression: string): CalcResult {
  if (expression.length > MAX_CHARS) return { ok: false, code: 'too_long' };
  let tokens: Token[];
  try {
    tokens = tokenize(expression);
  } catch (error) {
    const e = error as CalcErr;
    return fail(e.code, e.at);
  }
  if (!tokens.length) return { ok: false, code: 'syntax' };
  try {
    const value = new Parser(tokens).parse();
    if (!Number.isFinite(value)) return { ok: false, code: 'not_finite' };
    return { ok: true, value };
  } catch (error) {
    const e = error as CalcErr;
    return fail(e.code, e.at);
  }
}

export function formatNumber(value: number): string {
  return String(Number(value.toPrecision(15)));
}
