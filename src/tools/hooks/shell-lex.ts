// シェル（PowerShell・bash）の書き方を読む（plans/clive-gaps/security-self-api.md §11.2）。
// 判定に使うので、本物のシェルと読み方がずれる書き方は「止める」（LexFail）。読めたものは、文の並び（Statement）にして返す。
// parse-cmd.ts の読み方（引用符の外し方・\ の扱い）は、シェルとずれるところがあるので、判定には使わない。

export type ShellKind = 'powershell' | 'pwsh' | 'bash' | 'sh';
export const isPowerShell = (shell: ShellKind): boolean => shell === 'powershell' || shell === 'pwsh';

export interface Word {
  // 引用符を外したあとの値。変数・置換を含むとき（dynamic）は、書かれたままの文字
  text: string;
  dynamic: boolean;
  glob: boolean;
  quoted: boolean;
  home: boolean;
  kind: 'plain' | 'block' | 'hash' | 'splat' | 'paren';
  // PowerShell の -Name:値 の値（直前のパラメータにくっついている）
  attached?: boolean;
  // PowerShell の -名前:値 を -名前 と 値 の 2 つの語に分けたときの、-名前 の側。外部のプログラムには、1 つの引数 -名前:値 として渡る
  split?: boolean;
  // カンマの並び（a, b）で、空白・改行・空の要素があるもの。外部のプログラムには別々の引数として渡り、空の要素は消える（きっちりつないだ a,b は 1 つの a,b）
  loose?: boolean;
  // PowerShell のワイルドカードのエスケープ（バッククォート）を外した読み。名前の候補の 1 つで、秘密のパスに当たるかを調べるのに使う
  unescaped?: string;
  // スクリプトブロック（kind: 'block'）の中の文。同じ文は、全体の並びにも入っている
  block?: Statement[];
  // 計算プロパティのハッシュテーブルのキー（kind: 'hash'、小文字）
  hashKeys?: string[];
}

export interface Redirect { op: string; fd: string; target: Word | null }
export interface Assign { name: string; op: string; value: Word | null }

export interface Statement {
  kind: 'command' | 'assign' | 'expr' | 'control';
  words: Word[];
  redirects: Redirect[];
  assigns: Assign[];
  pipedIn: boolean;
  pipedOut: boolean;
  // パイプで直前に流れてくる文（pipedIn のとき）
  upstream?: Statement;
  // スクリプトブロックの中の文
  inBlock?: boolean;
  background: boolean;
  // 形そのものが今回だけになる理由の印（関数の定義・呼び出し演算子・splatting・許していない型など）
  shapes: string[];
  // 制御の形: 'for' | 'foreach' | 'if'
  header?: string;
  source: string;
}

export type LexCode =
  | 'curly_quote' | 'dash' | 'space' | 'fullwidth' | 'control' | 'depth' | 'unclosed' | 'backtick' | 'backslash' | 'parse_token' | 'block_comment'
  | 'provider_var' | 'dollar_form' | 'fd' | 'dev_net' | 'here_expand' | 'tilde_user' | 'ps_expand' | 'here_string' | 'ansi_c' | 'unexpected' | 'chain_op' | 'bash_sub';
export interface LexFail { code: LexCode; detail: string }
export type LexResult = { ok: true; statements: Statement[] } | { ok: false; fail: LexFail };

const CURLY = /[‘-‟′″]/u;
const DASHES = /[‐-―−]/u;
const ODD_SPACE = /[ ­  -‏‪-  -⁩﻿]/u;
// PowerShell 5.1 は U+0085・U+2028・U+2029 を語の区切りに読む（本物の Parser で確かめた）。bash は語の一部に読む。C1 の制御文字は、まとめて止める
const SEPARATOR_LIKE = /[\u0080-\u009f\u2028\u2029]/u;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const FULLWIDTH = /[！-～　]/u;
const MAX_DEPTH = 4;

const fail = (code: LexCode, detail = ''): LexFail => ({ code, detail });
const isFail = (x: unknown): x is LexFail => typeof x === 'object' && x !== null && 'code' in x && 'detail' in x && !('words' in x);
const hex = (ch: string) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

const blank = (): Statement => ({ kind: 'command', words: [], redirects: [], assigns: [], pipedIn: false, pipedOut: false, background: false, shapes: [], source: '' });
const plain = (text: string, over: Partial<Word> = {}): Word => ({ text, dynamic: false, glob: false, quoted: false, home: false, kind: 'plain', ...over });

// ASCII の引用符（' と "）の中を空白に置き換えた文字列
function outsidePsStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  const single = (): void => {
    out += ' '; i++;
    while (i < n && src[i] !== "'") { out += ' '; i++; }
    if (i < n) { out += ' '; i++; }
  };
  const double = (level: number): void => {
    out += ' '; i++;
    while (i < n) {
      const c = src[i]!;
      if (c === '"') { out += ' '; i++; if (src[i] === '"') { out += ' '; i++; continue; } return; }
      if (c === '$' && src[i + 1] === '(' && level < MAX_DEPTH + 2) { out += '  '; i += 2; code(true, level + 1); continue; }
      out += ' '; i++;
    }
  };
  const code = (inSub: boolean, level: number): void => {
    let depth = 0;
    while (i < n) {
      const c = src[i]!;
      if (c === "'") { single(); continue; }
      if (c === '"') { double(level); continue; }
      // 語の頭の # は行末まで、<# … #> は #> までがコメント（字句の読み取りと同じ）。中の引用符を始まりと取り違えないよう空白にする（改行は残す）
      if ((c === '#' && /[ \t\r\n;|&(){},'"<>]/u.test(src[i - 1] ?? ' ')) || (c === '<' && src[i + 1] === '#')) {
        const block = c === '<';
        const close = block ? src.indexOf('#>', i + 2) : -1;
        const stop = block ? (close < 0 ? n : close + 2) : (src.indexOf('\n', i) < 0 ? n : src.indexOf('\n', i));
        out += src.slice(i, stop).replace(/[^\n]/gu, ' ');
        i = stop;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        if (inSub && depth === 0) { out += ' '; i++; return; }
        if (depth > 0) depth--;
      }
      out += c; i++;
    }
  };
  code(false, 0);
  return out;
}

// bash の引用符の中を空白に置き換えた文字列。lexBash と同じ組み方をする: "…" の中の $( … ) は closeParen で切り出して中をコードとして見る。
// コメント（語の頭の # から行末）とヒアドキュメントの本文は、引用符を始めない（空白にはしない。中の全角も見る）
function outsideBashQuotes(src: string, level = 0): string {
  let out = '';
  let i = 0;
  let wordStart = true;
  const n = src.length;
  const pending: Array<{ delim: string; strip: boolean }> = [];
  const sub = (at: number): boolean => {
    const close = level < MAX_DEPTH + 2 ? closeParen(src, at) : -1;
    if (close < 0) return false;
    out += `  ${outsideBashQuotes(src.slice(at + 1, close), level + 1)} `;
    i = close + 1;
    return true;
  };
  const heredocBodies = (): void => {
    for (const h of pending) {
      while (i < n) {
        const e = src.indexOf('\n', i);
        const stop = e < 0 ? n : e + 1;
        const line = src.slice(i, e < 0 ? n : e);
        out += src.slice(i, stop);
        i = stop;
        if ((h.strip ? line.replace(/^\t+/u, '') : line) === h.delim) break;
      }
    }
    pending.length = 0;
  };
  while (i < n) {
    const c = src[i]!;
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      const stop = e < 0 ? n : e + 1;
      out += ' '.repeat(stop - i);
      i = stop;
      wordStart = false;
      continue;
    }
    if (c === '"') {
      out += ' ';
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) { out += '  '; i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '(' && sub(i + 1)) continue;
        out += ' ';
        i++;
      }
      if (i < n) { out += ' '; i++; }
      wordStart = false;
      continue;
    }
    if (c === '#' && wordStart) {
      while (i < n && src[i] !== '\n') { out += src[i]!; i++; }
      continue;
    }
    if (c === '\n') {
      out += c;
      i++;
      wordStart = true;
      if (pending.length) heredocBodies();
      continue;
    }
    if (c === '<' && src[i + 1] === '<') {
      if (src[i + 2] === '<') { out += '<<<'; i += 3; wordStart = true; continue; }
      const m = /^<<(-?)[ \t]*([^\s;&|()<>]*)/u.exec(src.slice(i, i + 400));
      if (m) pending.push({ delim: m[2]!.replace(/['"\\]/gu, ''), strip: m[1] === '-' });
      out += '<<';
      i += 2;
      wordStart = true;
      continue;
    }
    if (c === '$' && src[i + 1] === '(' && sub(i + 1)) { wordStart = false; continue; }
    if ((c === '<' || c === '>') && src[i + 1] === '(' && sub(i + 1)) { wordStart = true; continue; }
    out += c;
    i++;
    wordStart = /[\s;&|()<>]/u.test(c);
  }
  return out;
}

function outsideQuotes(src: string, shell: ShellKind): string {
  return isPowerShell(shell) ? outsidePsStrings(src) : outsideBashQuotes(src);
}

function precheck(src: string, shell: ShellKind): LexFail | null {
  const curly = CURLY.exec(src);
  if (curly) return fail('curly_quote', curly[0]);
  const dash = DASHES.exec(src);
  if (dash) return fail('dash', dash[0]);
  const space = ODD_SPACE.exec(src);
  if (space) return fail('space', hex(space[0]));
  const separator = SEPARATOR_LIKE.exec(src);
  if (separator) return fail('space', hex(separator[0]));
  const control = CONTROL.exec(src);
  if (control) return fail('control', hex(control[0]));
  // PowerShell は CR 1 つ（LF が続かないもの）を文の区切りに読む。CRLF だけは LF と同じ 1 つの改行として読む
  const lone = /\r(?!\n)/u.exec(src);
  if (lone) return fail('control', hex('\r'));
  const wide = FULLWIDTH.exec(outsideQuotes(src, shell));
  if (wide) return fail('fullwidth', wide[0]);
  return null;
}

interface BashEnv { crlf: boolean }

export function lexShell(command: string, shell: ShellKind): LexResult {
  const early = precheck(command, shell);
  if (early) return { ok: false, fail: early };
  const normalized = command.replace(/\r\n/gu, '\n');
  const sink: Statement[] = [];
  const failure = isPowerShell(shell) ? lexPowerShell(normalized, shell, sink) : lexBash(normalized, 0, sink, { crlf: command.includes('\r\n') });
  return failure ? { ok: false, fail: failure } : { ok: true, statements: sink };
}

// ── bash ────────────────────────────────────────────────────────────────

const BASH_KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', 'for', 'case', 'esac', 'select', 'function', 'coproc', 'time', '!', '{', '}', 'trap']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

// src[start] の ( に対応する ) の位置（引用符の中は数えない）。無ければ -1。
// bash は $( … ) の中をふつうの文として読むので、終わりの決め方は文法しだい（コメントの中の ) は閉じない、case の ) は閉じない）。
// 次の形は、ガードの切り出した終わりが本物の bash とずれうるので、読めないとして SUB_AMBIGUOUS を返す:
// 語の頭の # のコメント、引用符を数えた終わりと、引用符を無視して ( ) だけを数えた終わりが違う形（引用符の中に括弧がある）
const SUB_AMBIGUOUS = -2;
function closeParen(src: string, start: number): number {
  const end = closeParenQuoted(src, start);
  if (end < 0) return end;
  return plainClose(src, start) === end ? end : SUB_AMBIGUOUS;
}

// src[open] の ( に対応する ) の位置（引用符は考えない）。無ければ -1
function plainClose(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

function closeParenQuoted(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "'") { const e = src.indexOf("'", i + 1); if (e < 0) return -1; i = e; continue; }
    if (ch === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === '$' && src[i + 1] === '(') { const e = closeParen(src, i + 1); if (e < 0) return e; i = e; }
      }
      continue;
    }
    if (ch === '#' && /[\s;&|()<>]/u.test(src[i - 1] ?? ' ')) return SUB_AMBIGUOUS;
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

function lexBash(src: string, depth: number, sink: Statement[], env: BashEnv): LexFail | null {
  if (depth > MAX_DEPTH) return fail('depth');
  const n = src.length;
  let i = 0;
  let cur = blank();
  let pipePrev = false;
  let dbl = false;
  // [[ … ]] を閉じた直後。bash は ]] の次の語を、then・do などの言葉として読める新しい文の頭と見る（if [[ -n x ]] then pwn; fi）
  let afterCond = false;
  const stack: string[] = [];
  const pending: Array<{ delim: string; quoted: boolean; strip: boolean }> = [];

  const empty = () => cur.words.length === 0 && cur.assigns.length === 0 && cur.redirects.length === 0 && cur.header === undefined;
  const end = (pipeOut: boolean) => {
    if (!empty()) {
      cur.pipedIn = pipePrev;
      cur.pipedOut = pipeOut;
      cur.source = cur.words.map(w => w.text).join(' ');
      if (cur.header === 'for') {
        cur.kind = 'control';
        if (!(cur.words.length >= 2 && NAME.test(cur.words[0]!.text) && cur.words[1]!.text === 'in')) cur.shapes.push('control');
      } else cur.kind = cur.words.length === 0 && cur.assigns.length > 0 ? 'assign' : 'command';
      sink.push(cur);
    }
    pipePrev = pipeOut;
    cur = blank();
    afterCond = false;
  };

  const readSubstitution = (at: number): { end: number; fail?: LexFail } => {
    const close = closeParen(src, at);
    if (close === SUB_AMBIGUOUS) return { end: n, fail: fail('bash_sub') };
    if (close < 0) return { end: n, fail: fail('unclosed', '$(') };
    const inner = lexBash(src.slice(at + 1, close), depth + 1, sink, env);
    return inner ? { end: close, fail: inner } : { end: close };
  };

  // $ で始まる形を読む。inQuote: "…" の中
  const readDollar = (inQuote: boolean): { text: string; dynamic: boolean } | LexFail => {
    const next = src[i + 1];
    if (next === "'" || (next === '"' && !inQuote)) return fail('ansi_c');
    // $[ … ] は古い算術展開。中は式として読まれ（# はコメントでない）、$( … ) も展開される
    if (next === '[') return fail('dollar_form', '$[…]');
    // "…" の中の \ 改行は消えて、$ と次の文字（( { 名前）をつなぐ（"$\<改行>(pwn)" は "$(pwn)"）
    if (inQuote && next === '\\' && src[i + 2] === '\n') return fail('backslash');
    if (next === '(') {
      if (src[i + 2] === '(') {
        // 算術になるのは、2 つ目の ( に対応する ) のすぐ次がまた ) のときだけ。そうでなければ bash は $( の中の ( … ) の部分シェルとして読み、中の文を動かす（$((true)<改行>/path/cmd))）
        const e = plainClose(src, i + 2);
        if (e >= 0 && src[e + 1] === ')') {
          if (!/^[0-9A-Za-z_\s+\-*/%()]*$/u.test(src.slice(i + 3, e).replace(/\$[A-Za-z_][A-Za-z0-9_]*/gu, ''))) return fail('dollar_form', '$((…))');
          const text = src.slice(i, e + 2);
          i = e + 2;
          return { text, dynamic: true };
        }
      }
      const r = readSubstitution(i + 1);
      if (r.fail) return r.fail;
      const text = src.slice(i, r.end + 1);
      i = r.end + 1;
      return { text, dynamic: true };
    }
    if (next === '{') {
      const m = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}/u.exec(src.slice(i));
      if (!m) return fail('dollar_form', '${…}');
      i += m[0].length;
      return { text: m[0], dynamic: true };
    }
    const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]|[?#@*!$-])/u.exec(src.slice(i));
    if (m) { i += m[0].length; return { text: m[0], dynamic: true }; }
    i++;
    return { text: '$', dynamic: false };
  };

  const readWord = (): Word | LexFail => {
    const w = plain('');
    const stops = dbl ? ' \t\n' : ' \t\n;&|()<>';
    // [[ … ]] の中の語は空白でだけ切るが、]] のすぐあとの ; & | ( ) < > では、bash も ]] を閉じる
    while (i < n && !stops.includes(src[i]!) && !(dbl && w.text === ']]' && !w.quoted && ';&|()<>'.includes(src[i]!))) {
      const ch = src[i]!;
      if (ch === "'") {
        const e = src.indexOf("'", i + 1);
        if (e < 0) return fail('unclosed', "'");
        w.text += src.slice(i + 1, e);
        w.quoted = true;
        i = e + 1;
      } else if (ch === '"') {
        w.quoted = true;
        i++;
        for (;;) {
          if (i >= n) return fail('unclosed', '"');
          const c = src[i]!;
          if (c === '"') { i++; break; }
          if (c === '\\') {
            const esc = src[i + 1];
            if (esc === '\n') { if (env.crlf) return fail('backslash'); i += 2; continue; }
            if (esc === '$' || esc === '`' || esc === '"' || esc === '\\') { w.text += esc; i += 2; continue; }
            w.text += c; i++;
            continue;
          }
          if (c === '`') return fail('backtick');
          if (c === '$') {
            const r = readDollar(true);
            if (isFail(r)) return r;
            w.text += r.text; w.dynamic ||= r.dynamic;
            continue;
          }
          w.text += c;
          i++;
        }
      } else if (ch === '\\') return fail('backslash');
      else if (ch === '`') return fail('backtick');
      else if (ch === '$') {
        const r = readDollar(false);
        if (isFail(r)) return r;
        w.text += r.text; w.dynamic ||= r.dynamic;
      } else if (ch === '~' && w.text === '' && !w.quoted) {
        const next = src[i + 1];
        if (next === undefined || next === '/' || /\s/u.test(next) || ';&|()<>'.includes(next)) { w.home = true; w.text = '~'; i++; } else return fail('tilde_user');
      } else if ((ch === '<' || ch === '>') && src[i + 1] === '(') {
        // [[ … ]] の中の語は空白でだけ切るので、<( … ) >( … ) もここに来る。本物の bash はプロセス置換として中のコマンドを動かす
        const r = readSubstitution(i + 1);
        if (r.fail) return r.fail;
        if (ch === '>') cur.shapes.push('process_out');
        w.text += src.slice(i, r.end + 1); w.dynamic = true;
        i = r.end + 1;
      } else if (ch === '*' || ch === '?' || ch === '[') { w.glob = true; w.text += ch; i++; } else if (ch === '{') {
        const close = src.indexOf('}', i);
        const inner = close > i ? src.slice(i + 1, close) : '';
        if (close > i && !/\s/u.test(inner) && (inner.includes(',') || inner.includes('..'))) w.glob = true;
        w.text += ch; i++;
      } else { w.text += ch; i++; }
    }
    if (/\/dev\/(?:tcp|udp)\//u.test(w.text)) return fail('dev_net', w.text);
    if ((w.text === '[' || w.text === '[[') && !w.quoted) w.glob = false;
    return w;
  };

  const readHeredocs = (): LexFail | null => {
    for (const h of pending) {
      let body = '';
      for (;;) {
        if (i >= n) return fail('unclosed', '<<');
        const e = src.indexOf('\n', i);
        const line = e < 0 ? src.slice(i) : src.slice(i, e);
        i = e < 0 ? n : e + 1;
        if ((h.strip ? line.replace(/^\t+/u, '') : line) === h.delim) break;
        body += `${line}\n`;
      }
      if (!h.quoted && /[$`\\]/u.test(body)) return fail('here_expand');
    }
    pending.length = 0;
    return null;
  };

  // 制御の言葉。true: 言葉として消費した、false: 普通の言葉（コマンド）として扱う
  const keyword = (text: string): boolean | LexFail => {
    switch (text) {
      case 'if': case 'while': stack.push(text); return true;
      case 'until': cur.shapes.push('control'); stack.push('while'); return true;
      case 'elif': case 'then': case 'else': if (stack.at(-1) !== 'if') return fail('unexpected', text); return true;
      case 'fi': if (stack.pop() !== 'if') return fail('unexpected', 'fi'); end(false); return true;
      case 'do': if (!['for', 'while'].includes(stack.at(-1) ?? '')) return fail('unexpected', 'do'); return true;
      case 'done': { const top = stack.pop(); if (top !== 'for' && top !== 'while') return fail('unexpected', 'done'); end(false); return true; }
      case 'for': cur.header = 'for'; stack.push('for'); return true;
      case 'case': if (depth > 0) return fail('bash_sub'); cur.shapes.push('control'); return false;
      case '{': case '}': return true;
      default: cur.shapes.push('control'); return false;
    }
  };

  while (i < n) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '\n') {
      i++;
      end(false);
      if (pending.length) { const f = readHeredocs(); if (f) return f; }
      continue;
    }
    if (ch === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (!dbl) {
      if (ch === ';') { i += src[i + 1] === ';' ? 2 : 1; end(false); continue; }
      if (ch === '&' && src[i + 1] === '&') { i += 2; end(false); continue; }
      if (ch === '|') {
        if (src[i + 1] === '|') { i += 2; end(false); continue; }
        if (src[i + 1] === '&') cur.shapes.push('pipe_stderr');
        i += src[i + 1] === '&' ? 2 : 1;
        end(true);
        continue;
      }
      if (ch === '&' && src[i + 1] !== '>') { i++; cur.background = true; end(false); continue; }
      if (ch === '(' || ch === ')') {
        if (ch === '(' && cur.words.length > 0 && !/\s/u.test(src[i - 1] ?? ' ')) cur.shapes.push('function');
        // (( … )) は算術のコマンド。中は式として読まれ、# はコメントでない（(( ls # )); pwn は pwn も動かす）
        if (ch === '(' && src[i + 1] === '(') return fail('unexpected', '((');
        // NAME=( … ) は配列の代入。閉じ ) のあとに続く # もコメントでなく語の一部（ech=()#o } a | pwn）
        if (ch === '(' && src[i - 1] === '=') return fail('unexpected', '=(');
        i++;
        end(false);
        continue;
      }
    }
    // 先頭の代入（NAME=値）
    if (!dbl && cur.words.length === 0 && cur.header === undefined) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)/u.exec(src.slice(i, i + 200));
      if (m) {
        i += m[0].length;
        let value: Word | null = null;
        if (i < n && !' \t\n;&|()<>'.includes(src[i]!)) {
          const w = readWord();
          if (isFail(w)) return w;
          value = w;
        } else value = plain('');
        cur.assigns.push({ name: m[1]!, op: m[2]!, value });
        continue;
      }
    }
    // 番号つきのリダイレクト（2> など）
    let fd = '';
    if (!dbl) {
      const digits = /^[0-9]+(?=[<>])/u.exec(src.slice(i, i + 12));
      if (digits) { fd = digits[0]; i += fd.length; }
    }
    const c = src[i]!;
    if (!dbl && (c === '<' || c === '>' || (c === '&' && src[i + 1] === '>'))) {
      if (fd !== '' && !['0', '1', '2'].includes(fd)) return fail('fd', `${fd}${c}`);
      const rest = src.slice(i);
      if ((c === '<' || c === '>') && src[i + 1] === '(') {
        const r = readSubstitution(i + 1);
        if (r.fail) return r.fail;
        const head = src.slice(i, r.end + 1);
        i = r.end + 1;
        // 閉じ ) のすぐあとに続く文字は同じ語の続き（# はコメントでなく語の一部）
        const tail = readWord();
        if (isFail(tail)) return tail;
        cur.words.push(plain(head + tail.text, { dynamic: true, glob: tail.glob, quoted: tail.quoted }));
        if (c === '>') cur.shapes.push('process_out');
        continue;
      }
      if (rest.startsWith('<<<')) {
        i += 3;
        while (src[i] === ' ' || src[i] === '\t') i++;
        const w = readWord();
        if (isFail(w)) return w;
        cur.redirects.push({ op: '<<<', fd: '0', target: w });
        continue;
      }
      if (rest.startsWith('<<')) {
        i += 2;
        const strip = src[i] === '-';
        if (strip) i++;
        while (src[i] === ' ' || src[i] === '\t') i++;
        const w = readWord();
        if (isFail(w)) return w;
        pending.push({ delim: w.text, quoted: w.quoted, strip });
        cur.redirects.push({ op: '<<', fd: '0', target: null });
        continue;
      }
      if (rest.startsWith('<>')) return fail('fd', '<>');
      const dup = /^([<>])&(\d+|-)/u.exec(rest);
      if (dup) {
        const to = dup[2]!;
        const from = fd || (dup[1] === '<' ? '0' : '1');
        if (!((from === '2' && to === '1') || (from === '1' && to === '2') || to === '-')) return fail('fd', rest.slice(0, 4));
        // >&2# のように語の文字が続くと、bash は fd の複製でなく、その語（2#）というファイルへの書き込みと読む。# もコメントでなく語の一部
        const after = rest[dup[0].length];
        if (after !== undefined && !' \t\n;&|()<>'.includes(after)) return fail('fd', rest.slice(0, dup[0].length + 1));
        i += dup[0].length;
        cur.redirects.push({ op: `${dup[1]}&`, fd: from, target: null });
        continue;
      }
      if (/^[<>]&/u.test(rest)) return fail('fd', rest.slice(0, 3));
      const m = /^(&>>|&>|>>|>\||>|<)/u.exec(rest)!;
      i += m[0].length;
      while (src[i] === ' ' || src[i] === '\t') i++;
      if (i >= n || '\n;&|()<>'.includes(src[i]!)) return fail('unexpected', m[0]);
      const target = readWord();
      if (isFail(target)) return target;
      cur.redirects.push({ op: m[0], fd: fd || (m[0] === '<' ? '0' : m[0].startsWith('&') ? '&' : '1'), target });
      continue;
    }
    if (fd !== '') i -= fd.length;
    const before = i;
    const w = readWord();
    if (isFail(w)) return w;
    if (i === before) return fail('unexpected', src[i] ?? '');
    if (afterCond) end(false);
    const atCommand = cur.words.length === 0 && cur.header === undefined && cur.assigns.length === 0;
    if (atCommand && !dbl && !w.quoted && !w.dynamic && !w.glob && BASH_KEYWORDS.has(w.text)) {
      const r = keyword(w.text);
      if (isFail(r)) return r;
      if (r) continue;
    }
    cur.words.push(w);
    if (cur.words.length === 1 && !w.quoted && w.text === '[[') dbl = true;
    else if (dbl && w.text === ']]') { dbl = false; afterCond = true; }
  }
  if (pending.length) return fail('unclosed', '<<');
  if (dbl) return fail('unclosed', '[[');
  end(false);
  if (stack.length) return fail('unclosed', stack.at(-1) ?? '');
  return null;
}

// ── PowerShell ──────────────────────────────────────────────────────────

interface Tok { t: 'word' | 'str' | 'var' | 'sub' | 'arr' | 'hash' | 'splat' | 'type' | 'member' | 'static' | 'p' | 'redir'; v: string; sp: boolean; dyn?: boolean; glob?: boolean; subs?: Tok[][] }

const PS_WORD_STOPS = new Set([' ', '\t', '\r', '\n', ';', '|', '&', '(', ')', '{', '}', ',', "'", '"', '`', '$', '<', '>']);
const PS_OTHER_CONTROL = new Set([
  'function', 'filter', 'class', 'enum', 'param', 'begin', 'process', 'end', 'trap', 'try', 'catch', 'finally', 'switch', 'do', 'while', 'for', 'until', 'using',
  'return', 'throw', 'break', 'continue', 'exit', 'data', 'workflow', 'parallel', 'sequence', 'inlinescript', 'foreach-object-parallel',
]);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);
const PS_OPERATORS = new Set([
  '-eq', '-ne', '-gt', '-ge', '-lt', '-le', '-like', '-notlike', '-match', '-notmatch', '-contains', '-notcontains', '-in', '-notin', '-replace', '-split', '-join', '-f',
  '-and', '-or', '-not', '-is', '-as', '+', '-', '*', '/', '%', '..', '!', '-xor',
]);
const PS_CAST_OK = new Set(['int', 'long', 'double', 'decimal', 'string', 'bool', 'datetime', 'timespan', 'char', 'array', 'hashtable', 'pscustomobject', 'int32', 'int64']);
const PS_STATIC_OK = new Set(['now', 'today', 'utcnow']);
const PS_METHOD_OK = new Set([
  'tostring', 'tolower', 'toupper', 'tolowerinvariant', 'toupperinvariant', 'trim', 'trimstart', 'trimend', 'replace', 'split', 'substring', 'startswith', 'endswith',
  'contains', 'indexof', 'lastindexof', 'padleft', 'padright', 'join', 'format',
]);
const isNumberWord = (v: string): boolean => /^[-+]?[0-9][0-9_]*(?:\.[0-9]+)?(?:kb|mb|gb|tb|pb)?$/iu.test(v) || /^[0-9]+\.\.[0-9]+$/u.test(v);

function naiveSubEnd(src: string, from: number): number {
  let depth = 1;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

function tokenizePs(src: string, shell: ShellKind): Tok[] | LexFail {
  const scanned = scanPs(src, shell, 0, 0, false);
  return isFail(scanned) ? scanned : scanned.toks;
}

function scanPs(src: string, shell: ShellKind, from: number, level: number, sub: boolean): { toks: Tok[]; end: number } | LexFail {
  const toks: Tok[] = [];
  const n = src.length;
  let i = from;
  let sp = true;
  let parens = 0;
  const push = (t: Omit<Tok, 'sp'>): void => { toks.push({ ...t, sp }); sp = false; };
  const prevEndsValue = (): boolean => {
    const p = toks.at(-1);
    if (!p) return false;
    return p.t === 'var' || p.t === 'str' || p.t === 'member' || p.t === 'static' || (p.t === 'p' && (p.v === ')' || p.v === ']' || p.v === '}')) || p.t === 'type';
  };
  while (i < n) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t') { sp = true; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { push({ t: 'p', v: '\n' }); sp = true; i++; continue; }
    if (ch === '#') { if (sub) return fail('unexpected', '#'); while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '<') return fail(src[i + 1] === '#' ? 'block_comment' : 'unexpected', '<');
    if (ch === '`') return fail('backtick');
    if (ch === ';') { push({ t: 'p', v: ';' }); i++; continue; }
    if (ch === '|') {
      if (src[i + 1] === '|') { if (shell === 'powershell') return fail('chain_op', '||'); push({ t: 'p', v: '||' }); i += 2; continue; }
      push({ t: 'p', v: '|' }); i++; continue;
    }
    if (ch === '&') {
      if (src[i + 1] === '&') { if (shell === 'powershell') return fail('chain_op', '&&'); push({ t: 'p', v: '&&' }); i += 2; continue; }
      push({ t: 'p', v: '&' }); i++; continue;
    }
    if (ch === "'") {
      let value = '';
      let j = i + 1;
      for (;;) {
        if (j >= n) return fail('unclosed', "'");
        if (src[j] === "'") { if (src[j + 1] === "'") { value += "'"; j += 2; continue; } break; }
        value += src[j]; j++;
      }
      push({ t: 'str', v: value, dyn: false }); i = j + 1; continue;
    }
    if (ch === '"') {
      let value = '';
      let dyn = false;
      const subs: Tok[][] = [];
      let j = i + 1;
      for (;;) {
        if (j >= n) return fail('unclosed', '"');
        const c = src[j]!;
        if (c === '"') { if (src[j + 1] === '"') { value += '"'; j += 2; continue; } break; }
        if (c === '`') return fail('backtick');
        if (c === '$') {
          const next = src[j + 1];
          if (next === '{') return fail('ps_expand', '${');
          if (next === '$' && src[j + 2] === '(') return fail('ps_expand', '$$(');
          if (next === '(') {
            if (level >= MAX_DEPTH) return fail('depth');
            const inner = scanPs(src, shell, j + 2, level + 1, true);
            if (isFail(inner)) return inner;
            if (naiveSubEnd(src, j + 2) !== inner.end) return fail('ps_expand', '$(');
            value += src.slice(j, inner.end);
            subs.push(inner.toks);
            dyn = true;
            j = inner.end;
            continue;
          }
          if (/^[\p{L}\p{Nd}_?$^:]/u.test(src.slice(j + 1, j + 3))) dyn = true;
        }
        value += c; j++;
      }
      push({ t: 'str', v: value, dyn, ...(subs.length ? { subs } : {}) }); i = j + 1; continue;
    }
    if (ch === '@') {
      const next = src[i + 1];
      if (next === "'") {
        const m = /^@'\r?\n/u.exec(src.slice(i));
        if (!m) return fail('here_string');
        const close = /\r?\n'@/u.exec(src.slice(i + m[0].length));
        if (!close) return fail('unclosed', "@'");
        push({ t: 'str', v: src.slice(i + m[0].length, i + m[0].length + close.index), dyn: false });
        i += m[0].length + close.index + close[0].length; continue;
      }
      if (next === '"') return fail('here_string', '@"');
      if (next === '(') { push({ t: 'arr', v: '@(' }); i += 2; parens++; continue; }
      if (next === '{') { push({ t: 'hash', v: '@{' }); i += 2; continue; }
      const m = /^@([A-Za-z_][A-Za-z0-9_]*)/u.exec(src.slice(i, i + 80));
      if (m) { push({ t: 'splat', v: m[1]! }); i += m[0].length; continue; }
    }
    if (ch === '$') {
      const next = src[i + 1];
      if (next === '(') { push({ t: 'sub', v: '$(' }); i += 2; parens++; continue; }
      if (next === '{') return fail('provider_var', '${…}');
      const m = /^\$(?:([A-Za-z_][A-Za-z0-9_]*):)?([A-Za-z_][A-Za-z0-9_]*)|^\$[?_^$]/u.exec(src.slice(i, i + 120));
      if (!m) return fail('unexpected', '$');
      if (m[1] !== undefined && !['env', 'global', 'script', 'local', 'private'].includes(m[1].toLowerCase())) return fail('provider_var', `$${m[1]}:`);
      push({ t: 'var', v: m[1] !== undefined && m[1].toLowerCase() === 'env' ? `env:${m[2]}` : m[2] ?? m[0].slice(1), dyn: true });
      i += m[0].length; continue;
    }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === ',') {
      if (ch === ')' && sub && parens === 0) return { toks, end: i + 1 };
      if (ch === '(') parens++;
      else if (ch === ')' && parens > 0) parens--;
      push({ t: 'p', v: ch }); i++; continue;
    }
    if (ch === ']') { push({ t: 'p', v: ']' }); i++; continue; }
    if (ch === '[') {
      const m = /^\[([A-Za-z_][A-Za-z0-9_.]*(?:\[\])?)\]/u.exec(src.slice(i, i + 120));
      if (prevEndsValue() && !sp) { push({ t: 'p', v: '[' }); i++; continue; }
      if (m) { push({ t: 'type', v: m[1]! }); i += m[0].length; continue; }
    }
    if (ch === '>' || ((ch === '*' || (ch >= '1' && ch <= '6')) && src[i + 1] === '>' && sp)) {
      const m = /^([*1-6]?)(>>?)(&[12])?/u.exec(src.slice(i))!;
      push({ t: 'redir', v: m[0] }); i += m[0].length; continue;
    }
    // メンバー・静的メンバー
    if (ch === '.' && prevEndsValue() && !sp) {
      const m = /^\.([A-Za-z_][A-Za-z0-9_]*)/u.exec(src.slice(i, i + 120));
      if (m) { push({ t: 'member', v: m[1]! }); i += m[0].length; continue; }
    }
    if (ch === ':' && src[i + 1] === ':' && toks.at(-1)?.t === 'type') {
      const m = /^::([A-Za-z_][A-Za-z0-9_]*)/u.exec(src.slice(i, i + 120));
      if (m) { push({ t: 'static', v: m[1]! }); i += m[0].length; continue; }
    }
    // 裸の語
    let j = i;
    // 添字の中（[ のすぐあと）の語は ] で終わる: $a[0] $a[1..2] $a[-1]
    const inIndex = toks.at(-1)?.t === 'p' && toks.at(-1)?.v === '[';
    while (j < n && !PS_WORD_STOPS.has(src[j]!) && !(inIndex && src[j] === ']')) j++;
    if (j === i) return fail('unexpected', ch);
    const text = src.slice(i, j);
    if (text.startsWith('--%')) return fail('parse_token', '--%');
    push({ t: 'word', v: text, glob: /[*?[]/u.test(text) });
    i = j;
  }
  if (sub) return fail('unclosed', '$(');
  return { toks, end: n };
}

function lexPowerShell(src: string, shell: ShellKind, sink: Statement[]): LexFail | null {
  const scanned = tokenizePs(src, shell);
  if (isFail(scanned)) return scanned;
  let toks: Tok[] = scanned;
  let k = 0;
  const peek = (o = 0): Tok | undefined => toks[k + o];
  const isP = (t: Tok | undefined, v: string): boolean => t?.t === 'p' && t.v === v;
  const isSep = (t: Tok | undefined): boolean => t?.t === 'p' && (t.v === ';' || t.v === '\n');
  const isEnd = (t: Tok | undefined): boolean => t === undefined || (t.t === 'p' && [';', '\n', '|', ')', '}', ']', '&&', '||'].includes(t.v));
  const skipNl = () => { while (peek()?.t === 'p' && peek()!.v === '\n') k++; };

  const statements = (close: string | null, depth: number): LexFail | null => {
    if (depth > MAX_DEPTH) return fail('depth');
    for (;;) {
      while (isSep(peek())) k++;
      const t = peek();
      if (!t) return close ? fail('unclosed', close) : null;
      if (close && isP(t, close)) { k++; return null; }
      if (t.t === 'p' && (t.v === ')' || t.v === '}' || t.v === ']')) return fail('unexpected', t.v);
      const r = pipeline(depth);
      if (r) return r;
      const a = peek();
      if (a?.t === 'p' && (a.v === '&&' || a.v === '||')) k++;
    }
  };

  const stringSubs = (t: Tok, depth: number): LexFail | null => {
    for (const inner of t.subs ?? []) {
      const savedToks = toks;
      const savedK = k;
      toks = inner;
      k = 0;
      const r = statements(null, depth + 1);
      toks = savedToks;
      k = savedK;
      if (r) return r;
    }
    return null;
  };

  const pipeline = (depth: number): LexFail | null => {
    let pipedIn = false;
    let prev: Statement | undefined;
    for (;;) {
      const st = element(depth);
      if (isFail(st)) return st;
      st.pipedIn = pipedIn;
      if (prev) st.upstream = prev;
      prev = st;
      const p = peek();
      if (isP(p, '|')) { k++; skipNl(); st.pipedOut = true; pipedIn = true; continue; }
      return null;
    }
  };

  const block = (depth: number): Word | LexFail => {
    // peek() は { の次
    const before = sink.length;
    const r = statements('}', depth + 1);
    if (r) return r;
    const inner = sink.slice(before);
    for (const st of inner) st.inBlock = true;
    return plain('{…}', { kind: 'block', dynamic: true, block: inner });
  };

  const hashtable = (depth: number): Word | LexFail => {
    const keys: string[] = [];
    for (;;) {
      while (isSep(peek())) k++;
      const t = peek();
      if (!t) return fail('unclosed', '@{');
      if (isP(t, '}')) { k++; break; }
      if (t.t !== 'word' && t.t !== 'str') return fail('unexpected', t.v);
      const m = t.t === 'word' ? /^([^=]+)(=?)(.*)$/su.exec(t.v)! : null;
      keys.push((m ? m[1]! : t.v).toLowerCase());
      k++;
      const keySubs = stringSubs(t, depth);
      if (keySubs) return keySubs;
      let rest = m ? m[3]! : '';
      if (!m || m[2] === '') {
        const eq = peek();
        if (!(eq?.t === 'word' && eq.v.startsWith('='))) return fail('unexpected', eq?.v ?? '');
        k++;
        rest = eq.v.slice(1);
      }
      if (rest !== '') continue;
      if (isP(peek(), '{')) {
        k++;
        const b = block(depth);
        if (isFail(b)) return b;
      } else {
        const r = pipeline(depth + 1);
        if (r) return r;
      }
    }
    return plain('@{…}', { kind: 'hash', dynamic: true, hashKeys: keys });
  };

  // 値のあとに続く .メンバー・.メソッド( … )・[添字] を読む。許していないメソッドの印を返す。calls が false なら、メソッドの呼び出しの ( の手前で止める（代入の左辺の試し読み用）
  const chain = (depth: number, st: Statement, calls = true): LexFail | null => {
    for (;;) {
      const t = peek();
      if (t?.t === 'member') {
        k++;
        const open = peek();
        if (isP(open, '(') && !open!.sp) {
          if (!calls) return null;
          if (!PS_METHOD_OK.has(t.v.toLowerCase())) st.shapes.push(`method:${t.v}`);
          k++;
          const r = statements(')', depth + 1);
          if (r) return r;
        }
        continue;
      }
      if (isP(t, '[') && !t!.sp) { k++; const r = statements(']', depth + 1); if (r) return r; continue; }
      return null;
    }
  };

  // 式の 1 つの部品を読む（括弧・部分式・ハッシュ・ブロック・変数・文字・型）
  const operand = (depth: number, st: Statement): Word | LexFail | null => {
    const t = peek()!;
    // .メンバー・[添字] が続くと、値は計算されたもの（'a'.Replace(..) など）。元の文字ではないので、パスとして読めない印の $( … ) にする
    if (t.t === 'var') { k++; const start = k; const r = chain(depth, st); return r ?? (k > start ? plain('$(…)', { kind: 'paren', dynamic: true }) : plain(`$${t.v}`, { dynamic: true })); }
    if (t.t === 'str') {
      k++;
      const inner = stringSubs(t, depth);
      if (inner) return inner;
      const start = k;
      const r = chain(depth, st);
      return r ?? (k > start ? plain('$(…)', { kind: 'paren', dynamic: true }) : plain(t.v, { quoted: true, dynamic: t.dyn === true }));
    }
    if (t.t === 'p' && t.v === '(' || t.t === 'sub' || t.t === 'arr') {
      k++;
      const r = statements(')', depth + 1);
      if (r) return r;
      const c = chain(depth, st);
      return c ?? plain('$(…)', { kind: 'paren', dynamic: true });
    }
    if (t.t === 'hash') { k++; const h = hashtable(depth); if (isFail(h)) return h; const c = chain(depth, st); return c ?? h; }
    if (t.t === 'type') {
      k++;
      const s = peek();
      if (s?.t === 'static') {
        k++;
        if (!(t.v.toLowerCase().replace(/^system\./u, '') === 'datetime' && PS_STATIC_OK.has(s.v.toLowerCase()))) st.shapes.push(`static:${t.v}::${s.v}`);
        const r = chain(depth, st);
        return r ?? plain(`[${t.v}]::${s.v}`, { dynamic: true });
      }
      if (!PS_CAST_OK.has(t.v.toLowerCase().replace(/^system\./u, ''))) st.shapes.push(`cast:${t.v}`);
      return plain(`[${t.v}]`, { kind: 'plain', dynamic: false });
    }
    return null;
  };

  const redirect = (st: Statement): LexFail | null => {
    const t = peek()!;
    k++;
    const fd = /^([*1-6]?)/u.exec(t.v)![1] || '1';
    const op = t.v.slice(/^[*1-6]?/u.exec(t.v)![0].length).replace(/&[12]$/u, '');
    if (/&[12]$/u.test(t.v)) { st.redirects.push({ op: `${op}&`, fd, target: null }); return null; }
    const target = peek();
    if (!target || isEnd(target)) return fail('unexpected', t.v);
    if (target.t === 'var' && target.v.toLowerCase() === 'null') { k++; st.redirects.push({ op, fd, target: plain('$null') }); return null; }
    const w = argument(0, st);
    if (isFail(w)) return w;
    if (!w) return fail('unexpected', t.v);
    st.redirects.push({ op, fd, target: w });
    return null;
  };

  // コマンドの引数 1 つ（隣り合う部品はひとつの語にする）
  const argument = (depth: number, st: Statement): Word | LexFail | null => {
    let word = null as Word | null;
    for (;;) {
      const t = peek();
      if (!t || isEnd(t) || t.t === 'redir') break;
      if (word && t.sp) break;
      if (isP(t, ',')) break;
      let part: Word | LexFail | null = null;
      if (t.t === 'word') { k++; part = plain(t.v, { glob: t.glob === true }); }
      else if (t.t === 'splat') { k++; part = plain(`@${t.v}`, { kind: 'splat', dynamic: true }); st.shapes.push('splat'); }
      else if (isP(t, '{')) { k++; part = block(depth); }
      else if (t.t === 'member' || t.t === 'static') { k++; part = plain(t.v, { dynamic: true }); }
      else part = operand(depth, st);
      if (part === null) return fail('unexpected', t.v);
      if (isFail(part)) return part;
      // 引用符・括弧・ハッシュ・ブロックで始まる引数は、閉じたところで終わる（'a'b は a と b の 2 つ。a'b' は 1 つ）。本物の Parser と同じ
      const endsHere = word === null && (t.t === 'str' || t.t === 'sub' || t.t === 'arr' || t.t === 'hash' || isP(t, '(') || isP(t, '{'));
      word = word ? mergeWord(word, part) : part;
      if (endsHere) break;
    }
    if (word) {
      // a,b,c の配列は 1 つの語
      while (isP(peek(), ',')) {
        const comma = peek()!;
        k++;
        const newline = peek()?.t === 'p' && peek()!.v === '\n';
        skipNl();
        const after = peek();
        const next = argument(depth, st);
        if (isFail(next)) return next;
        if (!next) return fail('unexpected', ',');
        const loose: boolean = word.loose === true || comma.sp || newline || after?.sp === true || word.text === '' || next.text === '';
        word = { ...word, text: `${word.text},${next.text}`, dynamic: word.dynamic || next.dynamic, glob: word.glob || next.glob, ...(loose ? { loose: true } : {}) };
      }
    }
    return word;
  };

  const args = (depth: number, st: Statement): LexFail | null => {
    for (;;) {
      const t = peek();
      if (isEnd(t)) return null;
      if (t!.t === 'redir') { const r = redirect(st); if (r) return r; continue; }
      if (t!.t === 'word' && /^-[A-Za-z]/u.test(t!.v) && !t!.v.startsWith('--')) {
        k++;
        const colon = t!.v.indexOf(':');
        if (colon > 0) {
          st.words.push(plain(t!.v.slice(0, colon), { split: true }));
          const rest = t!.v.slice(colon + 1);
          const adj = peek();
          if (rest !== '') st.words.push(plain(rest, { attached: true, glob: /[*?[]/u.test(rest) }));
          else if (adj && !adj.sp && !isEnd(adj)) {
            const v = argument(depth, st);
            if (isFail(v)) return v;
            if (v) st.words.push({ ...v, attached: true });
          }
        } else st.words.push(plain(t!.v));
        continue;
      }
      const w = argument(depth, st);
      if (isFail(w)) return w;
      if (!w) return fail('unexpected', t!.v);
      st.words.push(w);
    }
  };

  const mergeWord = (a: Word, b: Word): Word => ({
    ...a, text: a.text + b.text, dynamic: a.dynamic || b.dynamic, glob: a.glob || b.glob, quoted: a.quoted || b.quoted, kind: b.kind === 'plain' ? a.kind : b.kind,
    ...(b.block ? { block: b.block } : {}), ...(b.hashKeys ? { hashKeys: b.hashKeys } : {}),
  });
  const finish = (st: Statement): Statement => { st.source = st.words.map(w => w.text).join(' '); sink.push(st); return st; };

  const expression = (depth: number, st: Statement): LexFail | null => {
    for (;;) {
      const t = peek();
      if (isEnd(t)) return null;
      if (t!.t === 'redir') { const r = redirect(st); if (r) return r; continue; }
      if (t!.t === 'word') {
        const v = t!.v.toLowerCase();
        k++;
        if (isNumberWord(v) || PS_OPERATORS.has(v) || /^-[ci](?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split)$/u.test(v)) {
          if (v === '-replace' && isP(peek(), '{')) st.shapes.push('replace_block');
          continue;
        }
        st.shapes.push(`expr:${t!.v}`);
        continue;
      }
      if (isP(t, ',')) { k++; continue; }
      if (isP(t, '{')) { k++; const b = block(depth); if (isFail(b)) return b; st.shapes.push('script_block'); continue; }
      if (t!.t === 'splat') { k++; st.shapes.push('splat'); continue; }
      if (t!.t === 'member' || t!.t === 'static') { k++; continue; }
      const r = operand(depth, st);
      if (isFail(r)) return r;
      if (r === null) return fail('unexpected', t!.v);
    }
  };

  const controlSkip = (depth: number): Statement | LexFail => {
    const st = blank();
    st.kind = 'control';
    st.shapes.push(`control:${peek()!.v.toLowerCase()}`);
    let level = 0;
    while (peek()) {
      const t = peek()!;
      if (level === 0 && (isSep(t) || isP(t, '|') || isP(t, ')') || isP(t, ']'))) break;
      if (t.t === 'p' && (t.v === '(' || t.v === '{')) level++;
      if (t.t === 'sub' || t.t === 'arr' || t.t === 'hash') level++;
      if (t.t === 'p' && (t.v === ')' || t.v === '}')) { if (level === 0) break; level--; }
      k++;
      const inner = stringSubs(t, depth);
      if (inner) return inner;
      if (level > MAX_DEPTH + 2) return fail('depth');
    }
    void depth;
    return finish(st);
  };

  const element = (depth: number): Statement | LexFail => {
    if (depth > MAX_DEPTH) return fail('depth');
    const t = peek();
    if (!t) return fail('unexpected', '');
    const st = blank();
    if (t.t === 'word') {
      const lower = t.v.toLowerCase();
      if (lower === 'foreach' && isP(peek(1), '(')) {
        k += 2;
        const v = peek();
        if (v?.t !== 'var') return fail('unexpected', 'foreach');
        k++;
        const inTok = peek();
        if (!(inTok?.t === 'word' && inTok.v.toLowerCase() === 'in')) return fail('unexpected', 'foreach');
        k++;
        let r = statements(')', depth + 1);
        if (r) return r;
        skipNl();
        if (!isP(peek(), '{')) return fail('unexpected', 'foreach');
        k++;
        r = statements('}', depth + 1);
        if (r) return r;
        st.kind = 'control'; st.header = 'foreach'; st.words.push(plain(`$${v.v}`, { dynamic: true }));
        return finish(st);
      }
      if (lower === 'if' && isP(peek(1), '(')) {
        for (let first = true; ; first = false) {
          const kw = peek();
          if (!first && !(kw?.t === 'word' && ['elseif', 'else'].includes(kw.v.toLowerCase()))) break;
          const isElse = !first && kw!.v.toLowerCase() === 'else';
          k++;
          if (!isElse) {
            if (!isP(peek(), '(')) return fail('unexpected', 'if');
            k++;
            const r = statements(')', depth + 1);
            if (r) return r;
          }
          skipNl();
          if (!isP(peek(), '{')) return fail('unexpected', 'if');
          k++;
          const r = statements('}', depth + 1);
          if (r) return r;
          // } のあとの改行をまたいで else を探す
          let j = 0;
          while (peek(j)?.t === 'p' && peek(j)!.v === '\n') j++;
          const next = peek(j);
          if (next?.t === 'word' && ['elseif', 'else'].includes(next.v.toLowerCase())) k += j;
          else break;
        }
        st.kind = 'control'; st.header = 'if';
        return finish(st);
      }
      if (PS_OTHER_CONTROL.has(lower)) return controlSkip(depth);
    }
    // 代入。左辺（$a.b[ … ]）は chain で読む（添字の中の文もトップレベルの文と同じに判定される）。代入でなければ、読んだ位置と文を戻して、式として読み直す
    if (t.t === 'var') {
      const from = k;
      const mark = sink.length;
      k++;
      const left = chain(depth, st, false);
      if (left) return left;
      const op = peek();
      if (op?.t === 'word' && ASSIGN_OPS.has(op.v)) {
        k++;
        skipNl();
        const r = pipeline(depth + 1);
        if (r) return r;
        st.kind = 'assign';
        st.assigns.push({ name: t.v, op: op.v, value: null });
        return finish(st);
      }
      k = from;
      sink.length = mark;
    }
    // コマンド
    const startsExpression = t.t !== 'word' && !isP(t, '&') ? true : t.t === 'word' && (/^[-+]?[0-9]/u.test(t.v) || t.v === '!' || t.v.toLowerCase() === '-not' || t.v.startsWith('..'));
    if (isP(t, '&') || (t.t === 'word' && t.v === '.')) {
      const amp = isP(t, '&');
      k++;
      const target = peek();
      if (amp && target?.t === 'word' && !isEnd(target)) {
        // & 名前 引数… は、名前だけと同じ（C1 は名前の形で決める）
        k++;
        st.words.push(plain(target.v, { glob: target.glob === true }));
      } else {
        st.shapes.push(amp ? 'call' : 'dot_source');
        if (target && !isEnd(target)) {
          const w = argument(depth, st);
          if (isFail(w)) return w;
          if (w) st.words.push(w);
        }
      }
      const r = args(depth, st);
      if (r) return r;
      return finish(st);
    }
    if (startsExpression) {
      st.kind = 'expr';
      const r = expression(depth, st);
      if (r) return r;
      return finish(st);
    }
    // 名前（裸の語）
    k++;
    st.words.push(plain(t.v, { glob: t.glob === true }));
    const r = args(depth, st);
    if (r) return r;
    return finish(st);
  };

  return statements(null, 0);
}
