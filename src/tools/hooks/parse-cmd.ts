
export interface Segment {
  cmd: string;
  args: string[];
  rawArgs: string[];
  raw: string;
  // 元の先頭の語（引用符は外す。パスと拡張子が残る。cmd は拡張子（.ps1 など）とパスを落とした名前）
  rawCmd: string;
  // 先頭が & （呼び出し演算子）・. （ドットソース）・source だった
  invoke?: 'call' | 'dot' | 'source';
  // コマンドの前に付いた環境変数の代入（FOO=1 cmd・env FOO=1 cmd）の名前
  envAssign?: string[];
  // 標準入力の出どころ: 前のコマンドのパイプ・< のリダイレクト・ヒアドキュメントか here-string
  stdin?: 'pipe' | 'redirect' | 'heredoc';
}

export function stripExeSuffix(basename: string): string {
  return basename.replace(/\.(exe|cmd|com|ps1)$/u, '');
}

// ヒアドキュメントの本文だけを落とし、同じ行の残り（`| node` など）は残す
export function stripHeredocs(s: string): string {
  return s.replace(/<<-?\s*['"]?(\w+)['"]?([^\n]*)(?:\n[\s\S]*?)?\n\s*\1\b/gu, '<<HEREDOC$2');
}

export function stripQuotedContent(s: string): string {
  return s.replace(/"[^"]*"/gu, '""').replace(/'[^']*'/gu, "''");
}

export interface CommandPart { text: string; piped: boolean; call: boolean }

export function splitCommand(s: string): string[] {
  return splitCommandParts(s).map(p => p.text);
}

// 区切りで分けた部分に、前の区切りが | （パイプ）だったか、単独の & （呼び出し演算子）が先頭に付いていたかを添える。
export function splitCommandParts(s: string): CommandPart[] {
  const parts: CommandPart[] = [];
  let cur = '';
  let quote: string | null = null;
  let piped = false;
  let call = false;
  const push = (nextPiped: boolean) => { parts.push({ text: cur, piped, call }); cur = ''; piped = nextPiped; call = false; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < s.length && s[i + 1] !== '\n') { cur += ch + s[++i]; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '#' && (cur === '' || /\s$/u.test(cur))) {
      while (i + 1 < s.length && s[i + 1] !== '\n') i++;
      continue;
    }
    if (ch === '\n' || ch === '\r' || ch === ';') { push(false); continue; }
    if (ch === '&' && s[i + 1] === '&') { push(false); i++; continue; }
    if (ch === '|' && s[i + 1] === '|') { push(false); i++; continue; }
    if (ch === '|') { push(true); continue; }
    // 単独の & はバックグラウンド実行（bash）か呼び出し演算子（PowerShell の `& cmd`）。先頭にあれば呼び出し演算子として次に引き継ぐ
    if (ch === '&' && s[i + 1] !== '>' && s[i - 1] !== '>') {
      if (cur.trim() === '') { call = true; continue; }
      push(false);
      continue;
    }
    cur += ch;
  }
  push(false);
  return parts.map(p => ({ ...p, text: p.text.trim() })).filter(p => p.text);
}

export function tokenize(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/u.test(s[i]!)) i++;
    if (i >= s.length) break;
    let j = i;
    let token = '';
    while (j < s.length && !/\s/u.test(s[j]!)) {
      const ch = s[j]!;
      if (ch === '"' || ch === "'") {
        let k = j + 1;
        while (k < s.length && s[k] !== ch) { if (ch === '"' && s[k] === '\\') k++; k++; }
        token += s.slice(j, k + 1);
        j = k + 1;
      } else { token += ch; j++; }
    }
    tokens.push(token);
    i = j;
  }
  return tokens.filter(Boolean);
}

export function unquoteToken(t: string): string {
  if (t.length >= 2) {
    const first = t[0];
    if ((first === '"' || first === "'") && t.at(-1) === first) return t.slice(1, -1);
  }
  return t;
}

function extractQuotedArg(seg: string, offset: number): string | null {
  let i = offset;
  while (i < seg.length && seg[i] !== '"' && seg[i] !== "'") i++;
  if (i >= seg.length) return null;
  const quote = seg[i]!;
  i++;
  let content = '';
  while (i < seg.length) {
    const ch = seg[i]!;
    if (ch === '\\' && quote === '"') { i++; if (i < seg.length) content += seg[i++]; }
    else if (ch === quote) return content;
    else { content += ch; i++; }
  }
  return content;
}

function extractAfterFlag(seg: string, flag: RegExp): string | null {
  const m = flag.exec(seg);
  if (!m) return null;
  let start = m.index + m[0].length;
  while (start < seg.length && /\s/u.test(seg[start]!)) start++;
  if (start >= seg.length) return null;
  if (seg[start] === '"' || seg[start] === "'") return extractQuotedArg(seg, start);
  return seg.slice(start);
}


const CWD_BUILTINS = new Set(['cd', 'pushd', 'popd', 'set-location', 'sl', 'chdir']);
const WRAPPERS = new Set(['sudo', 'command', 'env', 'nohup', 'time', 'exec', 'builtin', 'doas']);
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PWSH = new Set(['pwsh', 'powershell']);
// 文の頭に付く言葉（その次が本当のコマンド）と、それだけで終わる行
const LEADING_WORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{']);
const CLOSERS = new Set(['}', ')', 'fi', 'done', 'esac']);
// コマンドではなく文の言葉（引数にコードの拡張子があっても、コードのファイルを渡したことにしない）
export const STATEMENT_WORDS = new Set([
  'if', 'elseif', 'else', 'elif', 'then', 'foreach', 'for', 'while', 'until', 'do', 'switch', 'case', 'try', 'catch', 'finally', 'function', 'filter', 'param', 'return', 'trap',
]);

// open の位置の括弧に対応する閉じ括弧の位置（引用符の中は数えない）。無ければ -1
function matchClose(s: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === openCh) depth++;
    else if (ch === closeCh && --depth === 0) return i;
  }
  return -1;
}

// $( ) ・ @( ) ・ <( ) ・ >( ) ・（bash の）バッククォートの中身。コマンドの文字を分けただけでは、中のコマンドが見えないため
export function substitutionBodies(s: string, backticks: boolean): string[] {
  const out: string[] = [];
  let single = false;
  let double = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (!single && ch === '\\' && i + 1 < s.length) { i++; continue; }
    if (!double && ch === "'") { single = !single; continue; }
    if (single) continue;
    if (ch === '"') { double = !double; continue; }
    if (s[i + 1] === '(' && (ch === '$' || ch === '@' || (!double && (ch === '<' || ch === '>')))) {
      const end = matchClose(s, i + 1, '(', ')');
      const body = s.slice(i + 2, end < 0 ? s.length : end);
      if (body.trim()) out.push(body);
      i = end < 0 ? s.length : end;
      continue;
    }
    if (backticks && ch === '\x60') {
      const end = s.indexOf('\x60', i + 1);
      const body = s.slice(i + 1, end < 0 ? s.length : end);
      if (body.trim()) out.push(body);
      i = end < 0 ? s.length : end;
    }
  }
  return out;
}

// { ... } の中身（PowerShell のスクリプトブロック・bash のグループや関数）。{} ・ ${} ・ @{} ・ {a,b} は除く
function braceBodies(seg: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  for (let i = /^\{\s/u.test(seg) ? 1 : 0; i < seg.length; i++) {
    const ch = seg[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch !== '{') continue;
    if (i > 0 && !/[\s()%?|&]/u.test(seg[i - 1]!)) continue;
    if (seg[i + 1] === '}') continue;
    const end = matchClose(seg, i, '{', '}');
    const body = seg.slice(i + 1, end < 0 ? seg.length : end).trim();
    i = end < 0 ? seg.length : end;
    if (!body) continue;
    if (!/\s/u.test(body) && (body.includes(',') || /^[\w-]+\.\.[\w-]+$/u.test(body))) continue;
    out.push(body);
  }
  return out;
}

function normalizeSegment(seg: string, depth: number, backticks: boolean, from: { piped: boolean; call: boolean } = { piped: false, call: false }): Segment[] {
  const rawTokens = tokenize(seg);
  const tokens = rawTokens.map(unquoteToken);
  if (!tokens.length) return [];
  let idx = 0;
  const envAssign: string[] = [];
  const skipAssignments = () => {
    for (let m = /^(\w+)=/u.exec(tokens[idx] ?? ''); m; m = /^(\w+)=/u.exec(tokens[idx] ?? '')) { envAssign.push(m[1]!); idx++; } // FOO=1 cmd
  };
  skipAssignments();
  let invoke: Segment['invoke'] = from.call ? 'call' : undefined;
  while (idx < tokens.length) {
    const t = tokens[idx]!;
    const stripped = stripExeSuffix(t.toLowerCase());
    if (WRAPPERS.has(t) || WRAPPERS.has(stripped) || t === '\\') {
      idx++;
      if (stripped === 'env') {
        // env -i -u NAME -C DIR FOO=1 cmd
        while (idx < tokens.length && tokens[idx]!.startsWith('-')) idx += /^-[uCS]$/u.test(tokens[idx]!) ? 2 : 1;
      }
      skipAssignments();
      continue;
    }
    if (LEADING_WORDS.has(t) || /^\(+$/u.test(t)) { idx++; continue; }
    if (t === '&' || t === '.') { invoke = t === '.' ? 'dot' : 'call'; idx++; continue; } // PowerShell の呼び出し演算子・ドットソース
    break;
  }
  if (idx >= tokens.length) return [];
  let rawCmd = tokens[idx]!;
  if (rawCmd.length > 1 && rawCmd.startsWith('(') && !rawCmd.includes(')')) rawCmd = rawCmd.replace(/^\(+/u, ''); // (node x.js) のグループ
  if (CLOSERS.has(rawCmd) && idx === tokens.length - 1) return [];
  const basename = rawCmd.replace(/^\\/u, '').split(/[\\/]/u).pop()!.toLowerCase();
  const stripped = stripExeSuffix(basename);
  const cmd = CWD_BUILTINS.has(stripped) ? basename : stripped;
  idx++;
  const rest = rawTokens.slice(idx);
  const stdin = from.piped ? 'pipe' as const
    : rest.some(t => /^<<(?!<)/u.test(t) || t.startsWith('<<<')) ? 'heredoc' as const
    : rest.some(t => /^<(?![<(])/u.test(t)) ? 'redirect' as const : undefined;
  const kind = invoke ?? (cmd === 'source' ? 'source' as const : undefined);
  const entry: Segment = {
    cmd, args: tokens.slice(idx), rawArgs: rest, raw: seg.trim(), rawCmd,
    ...(kind ? { invoke: kind } : {}),
    ...(stdin ? { stdin } : {}),
    ...(envAssign.length ? { envAssign } : {}),
  };
  if (depth >= 4) return [entry];

  let inner: string | null = null;
  if (cmd === 'eval' || cmd === 'iex' || cmd === 'invoke-expression') inner = extractAfterFlag(seg, /\b(?:eval|iex|invoke-expression)\b/iu);
  else if (POSIX_SHELLS.has(cmd) && entry.args.some(a => /^-\w*c\w*$/u.test(a))) inner = extractAfterFlag(seg, /(?:^|\s)-\w*c\w*(?=\s)/u);
  else if (PWSH.has(cmd)) inner = extractAfterFlag(seg, /(?:^|\s)-(?:c|command)(?=\s)/iu);
  else if (cmd === 'cmd') inner = extractAfterFlag(seg, /(?:^|\s)\/[ck](?=\s)/iu);
  return [
    entry,
    ...(inner ? parseSegments(inner, depth + 1, backticks) : []),
    ...braceBodies(seg).flatMap(body => parseSegments(body, depth + 1, backticks)),
  ];
}

function parseSegments(command: string, depth: number, backticks: boolean): Segment[] {
  const own = splitCommandParts(stripHeredocs(command)).flatMap(part => normalizeSegment(part.text, depth, backticks, part));
  const substituted = depth >= 4 ? [] : substitutionBodies(command, backticks).flatMap(body => parseSegments(body, depth + 1, backticks));
  return [...own, ...substituted];
}

// backticks: bash ではバッククォートが置換。PowerShell ではエスケープなので、Windows の PowerShell では中身として読まない
export function segments(command: string, opts: { backticks?: boolean } = {}): Segment[] {
  return parseSegments(command, 0, opts.backticks ?? true);
}
