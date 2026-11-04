
export interface Segment {
  cmd: string;
  args: string[];
  rawArgs: string[];
  raw: string;
}

export function stripExeSuffix(basename: string): string {
  return basename.replace(/\.(exe|cmd|com|ps1)$/u, '');
}

export function stripHeredocs(s: string): string {
  return s.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\s*\1\b/gu, '<<HEREDOC');
}

export function stripQuotedContent(s: string): string {
  return s.replace(/"[^"]*"/gu, '""').replace(/'[^']*'/gu, "''");
}

export function splitCommand(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
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
    if (ch === '\n' || ch === '\r' || ch === ';') { parts.push(cur); cur = ''; continue; }
    if (ch === '&' && s[i + 1] === '&') { parts.push(cur); cur = ''; i++; continue; }
    if (ch === '|' && s[i + 1] === '|') { parts.push(cur); cur = ''; i++; continue; }
    if (ch === '|') { parts.push(cur); cur = ''; continue; }
    // 単独の & はバックグラウンド実行（bash）か呼び出し演算子（PowerShell の `& cmd`）
    if (ch === '&' && s[i + 1] !== '>' && s[i - 1] !== '>' ) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
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

function normalizeSegment(seg: string, depth: number): Segment[] {
  const rawTokens = tokenize(seg);
  const tokens = rawTokens.map(unquoteToken);
  if (!tokens.length) return [];
  let idx = 0;
  while (idx < tokens.length && /^\w+=/u.test(tokens[idx]!)) idx++; // FOO=1 cmd
  while (idx < tokens.length) {
    const t = tokens[idx]!;
    const stripped = stripExeSuffix(t.toLowerCase());
    if (WRAPPERS.has(t) || WRAPPERS.has(stripped) || t === '\\') { idx++; continue; }
    if (t === '&' || t === '.') { idx++; continue; } // PowerShell の呼び出し演算子・ドットソース
    break;
  }
  if (idx >= tokens.length) return [];
  const rawCmd = tokens[idx]!;
  const basename = rawCmd.replace(/^\\/u, '').split(/[\\/]/u).pop()!.toLowerCase();
  const stripped = stripExeSuffix(basename);
  const candidate = stripped.replace(/^\(+/u, '');
  const cmd = CWD_BUILTINS.has(candidate) ? basename.replace(/^\(+/u, '') : stripped;
  idx++;
  const entry: Segment = { cmd, args: tokens.slice(idx), rawArgs: rawTokens.slice(idx), raw: seg.trim() };
  if (depth >= 4) return [entry];

  let inner: string | null = null;
  if (cmd === 'eval' || cmd === 'iex' || cmd === 'invoke-expression') inner = extractAfterFlag(seg, /\b(?:eval|iex|invoke-expression)\b/iu);
  else if (POSIX_SHELLS.has(cmd) && entry.args.some(a => /^-\w*c\w*$/u.test(a))) inner = extractAfterFlag(seg, /(?:^|\s)-\w*c\w*(?=\s)/u);
  else if (PWSH.has(cmd)) inner = extractAfterFlag(seg, /(?:^|\s)-(?:c|command)(?=\s)/iu);
  else if (cmd === 'cmd') inner = extractAfterFlag(seg, /(?:^|\s)\/[ck](?=\s)/iu);
  return inner ? [entry, ...parseSegments(inner, depth + 1)] : [entry];
}

function parseSegments(command: string, depth: number): Segment[] {
  return splitCommand(stripHeredocs(command)).flatMap(part => normalizeSegment(part, depth));
}

export function segments(command: string): Segment[] {
  return parseSegments(command, 0);
}
