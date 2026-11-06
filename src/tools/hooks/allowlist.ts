// 許可の一覧で、文 1 つを判定する（security-self-api.md §11.1 の 5）。結果は 許す / ふつうの確かめ / 今回だけ / 止める と、理由と、調べるパス。
// 表は allowlist-tools.ts（bash・外部の道具）・allowlist-git.ts・allowlist-ps.ts（コマンドレット）。ここは、名前の決まり（C1）・外部の実体（C2）・代入（C8）・リダイレクト・形の印をまとめる。

import { Acc, bashVarOk, envAssignOk, psVarOk, worstLevel, type Level, type MatchCtx, type RepoInfo, type StatementResult } from './allowlist-core.ts';
import { runGit } from './allowlist-git.ts';
import { pipeBound } from './allowlist-pipe.ts';
import { parsePs, psCmdlet, runFindstr, runPsSimple, winArgs, withWildcard } from './allowlist-ps.ts';
import { toolFor } from './allowlist-tools.ts';
import { isPowerShell, lexShell, type LexFail, type ShellKind, type Statement, type Word } from './shell-lex.ts';

export * from './allowlist-core.ts';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_.+-]*$/u;
const BASH_SPECIAL = new Set(['[', '[[', ':']);
const NULL_SINK = /^(?:\/dev\/null|\$null|nul)$/iu;
// PowerShell から起こしてよい外部のプログラム（git・rg・tar・言語の道具は allowlist-tools.ts と同じ表）
const PS_EXTERNAL_TOOLS = new Set(['rg', 'tar', 'curl', 'node', 'nodejs', 'python', 'python3', 'py', 'deno', 'bun', 'go', 'cargo', 'rustc', 'tsc', 'npm', 'pnpm', 'yarn', 'pip', 'pip3', 'pipx', 'uv', 'poetry', 'conda', 'gem', 'composer', 'pdm', 'hatch']);
const PS_SIMPLE = new Set(['whoami', 'hostname', 'ipconfig', 'tree', 'tree.com', 'where.exe']);
// パイプに文字だけを流す外部のプログラム
const isExternalText = (name: string): boolean => name === 'git' || name === 'findstr' || PS_EXTERNAL_TOOLS.has(name) || PS_SIMPLE.has(name);

export type { StatementResult, MatchCtx, RepoInfo, Level };

const SHAPES: Record<string, string> = {
  call: 'shape.call', dot_source: 'shape.dot_source', splat: 'shape.splat', function: 'shape.function', process_out: 'shape.process_out',
  pipe_stderr: 'shape.pipe_stderr', script_block: 'shape.script_block', replace_block: 'shape.replace_block',
};
function shapes(st: Statement, acc: Acc): void {
  for (const shape of st.shapes) {
    const [head, ...rest] = shape.split(':');
    const detail = rest.join(':');
    if (SHAPES[shape]) acc.add('once', SHAPES[shape] as 'shape.call', {}, false);
    else if (head === 'control') acc.add('once', 'shape.control', { name: detail || 'bash' }, false);
    else if (head === 'static') acc.add('once', 'shape.static', { name: detail }, false);
    else if (head === 'cast') acc.add('once', 'shape.cast', { name: detail }, false);
    else if (head === 'method') acc.add('once', 'shape.method', { name: detail }, false);
    else if (head === 'expr') acc.add('once', 'shape.expr', { name: detail }, false);
    else acc.add('once', 'list.shape', { detail: shape }, false);
  }
  if (st.background) acc.add('once', 'shape.background', {}, false);
}

function redirects(st: Statement, acc: Acc, ps: boolean): void {
  for (const r of st.redirects) {
    if (r.op === '<<' || r.op === '<<<' || r.op.endsWith('&') || !r.target) continue;
    if (NULL_SINK.test(r.target.text) && !r.target.dynamic) continue;
    // PowerShell の > は Out-File -FilePath と同じで、引用符つきでもワイルドカードを解決する
    const target = ps ? withWildcard(r.target) : r.target;
    if (r.op === '<') { acc.read(target); continue; }
    acc.write(target);
    // PowerShell のリダイレクトは書き込みなので、持ち主の許可でも外せず毎回確かめる（§11.13）
    if (ps) acc.add('once', 'list.ps_write', { cmd: r.op }, false);
  }
}

function assignments(st: Statement, ps: boolean, acc: Acc): void {
  for (const a of st.assigns) {
    const bareStatement = st.words.length === 0;
    if (ps) {
      if (/^env:/iu.test(a.name) || !psVarOk(a.name)) acc.add('once', 'list.env', { name: a.name }, false);
    } else if (bareStatement) {
      if (!bashVarOk(a.name)) acc.add('once', 'list.env', { name: a.name }, false);
    } else if (!envAssignOk(a.name, a.value)) acc.add('once', 'list.env', { name: a.name }, false);
  }
}

function external(key: string, acc: Acc, ctx: MatchCtx): string {
  if (!ctx.external) return '.exe';
  const r = ctx.external(key);
  if (!r.ok) acc.add('once', 'list.external', { cmd: key, detail: r.detail }, false);
  return r.ext;
}

function runPs(key: string, exe: boolean, st: Statement, acc: Acc, ctx: MatchCtx): void {
  const words = st.words;
  if (!exe) {
    const spec = psCmdlet(ctx.shell === 'powershell' && (key === 'curl' || key === 'wget') ? 'iwr' : key);
    if (spec) {
      const p = parsePs(spec, words, acc, ctx);
      spec.extra?.(p, acc, ctx, st);
      pipeBound(spec, p, st, acc, ctx, isExternalText);
      return;
    }
  }
  if (key === 'git' || PS_EXTERNAL_TOOLS.has(key) || key === 'findstr' || (PS_SIMPLE.has(exe && key === 'where' ? 'where.exe' : key))) {
    const ext = external(key, acc, ctx);
    const literalGlob = words.map(w => (w.glob ? { ...w, glob: false } : w));
    const simple = exe && key === 'where' ? 'where.exe' : key;
    if (key === 'git') runGit(literalGlob, acc, ctx);
    else if (key === 'findstr') runFindstr(literalGlob, acc, ctx);
    else if (PS_SIMPLE.has(simple)) runPsSimple(simple, literalGlob, acc, ctx);
    else toolFor(key)!.run(literalGlob, acc, ctx);
    if (ctx.windows) winArgs(key, words, ext, acc);
    return;
  }
  acc.add('once', 'list.command', { cmd: words[0]!.text }, true);
}

export function matchStatement(st: Statement, ctx: MatchCtx): StatementResult {
  const acc = new Acc();
  acc.strict = st.inBlock === true;
  const ps = isPowerShell(ctx.shell);
  shapes(st, acc);
  redirects(st, acc, ps);
  if (st.kind === 'control') {
    if (st.header === 'for') for (const w of st.words.slice(2)) if (w.glob) acc.read(w);
    return acc.result();
  }
  assignments(st, ps, acc);
  if (st.kind === 'assign' || st.kind === 'expr' || st.words.length === 0) return acc.result();

  const name = st.words[0]!;
  const text = name.text;
  const named = name.kind === 'plain' && !name.dynamic && !name.quoted && !name.home && (NAME_RE.test(text) || (ps ? text === '%' || text === '?' : BASH_SPECIAL.has(text)) || text === 'tree.com' || text === 'where.exe');
  if (!named) { acc.add('once', 'list.command', { cmd: text }, true); return acc.result(); }
  let key = ctx.windows || ps ? text.toLowerCase() : text;
  let exe = false;
  if (ctx.windows && key.endsWith('.exe') && key !== 'where.exe') { key = key.slice(0, -4); exe = true; }
  if (ps) { runPs(key, exe, st, acc, ctx); return acc.result(); }

  if (key === 'git') {
    external(key, acc, ctx);
    runGit(st.words, acc, ctx);
    return acc.result();
  }
  const tool = toolFor(key);
  if (!tool) { acc.add('once', 'list.command', { cmd: text }, true); return acc.result(); }
  if (!tool.builtin) external(key, acc, ctx);
  tool.run(st.words, acc, ctx);
  return acc.result();
}

// ── 文をまとめた判定（テストと shell-guard から）──
export interface Classified { level: Level; lex?: LexFail; results: StatementResult[]; statements: Statement[] }
export function classifyStatements(command: string, ctx: MatchCtx): Classified {
  const lexed = lexShell(command, ctx.shell, { windows: ctx.windows });
  if (!lexed.ok) return { level: 'deny', lex: lexed.fail, results: [], statements: [] };
  const results = lexed.statements.map(st => {
    const result = matchStatement(st, ctx);
    ctx.afterStatement?.(result);
    return result;
  });
  return { level: results.reduce<Level>((l, r) => worstLevel(l, r.level), 'allow'), results, statements: lexed.statements };
}

export const noRepo = (): RepoInfo => ({ found: false, configOk: true, badKey: '', unreadable: false, hooksPath: false, hooksFiles: false, hooksDir: '', remotes: [], localRemotes: [] });
export type { Word };
