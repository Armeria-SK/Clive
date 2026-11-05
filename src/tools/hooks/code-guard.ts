import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Language } from '../../config/schema.ts';
import { guardText, type GuardMessageKey } from '../../shared/messages/guard.ts';
import { segments, STATEMENT_WORDS, stripQuotedContent, type Segment } from './parse-cmd.ts';
import { expandPath } from './scope.ts';

// コードを動かす前の確かめ（plans/clive-gaps/security-self-api.md の R1.1〜R1.7・R1.10）。
// ファイルや組み立てた文字のコード・この PC の中のサーバー・別のプロセスなど、「コマンドの文字だけでは中身を判定できないもの」を、
// 毎回（今回だけ）確かめる側に倒す。判定は「分からなければ確かめる」。

export interface CodeFinding {
  reason: string;
  // 持ち主が tools.shell.allow に書いたコマンドで外せるのは R1.1〜R1.4 だけ
  exemptable: boolean;
  // 中身を見せるファイルの絶対パス（まだ無いものも含む）
  scripts: string[];
}

export interface CodeContext {
  cwd: string;
  language: Language;
  selfHosts: readonly string[];
  prev?: Segment | undefined;
  depth?: number;
}

const INTERPRETER = new RegExp(`^(?:${[
  'node', 'nodejs', 'deno', 'tsx', 'ts-node', 'python\\d*(?:\\.\\d+)?', 'py', 'pypy\\d*', 'perl', 'ruby', 'irb', 'php', 'lua', 'luajit', 'rscript', 'julia', 'java', 'jshell', 'groovy', 'kotlin', 'scala',
  'elixir', 'escript', 'tclsh', 'expect', 'osascript', 'wscript', 'cscript', 'mshta', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish',
].join('|')})$`, 'u');
const POWERSHELL = /^(?:pwsh|powershell)$/u;
const INFO_FLAG = /^(?:--version|-v|-V|--help|-h|-\?|-version|\/\?|--info|-info)$/u;
const CODE_EXT = /\.(?:ps1|psm1|psd1|bat|cmd|sh|bash|zsh|py|pyw|js|mjs|cjs|ts|mts|cts|jsx|tsx|vbs|vbe|wsf|jar|rb|pl|php|lua|rkt|r|jl|groovy|kts|scala)$/iu;

// 読むだけ・コードを動かさないコマンド（R1.3 の除外と R1.7 の除外）。cp・rm・tar など書くものも、コードは動かさないので入れてある
export const READ_ONLY_CMDS = new Set([
  'cat', 'type', 'get-content', 'gc', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'select-string', 'sls', 'findstr', 'wc', 'diff', 'cmp', 'fc', 'sort', 'uniq', 'bat', 'batcat', 'nl',
  'file', 'stat', 'ls', 'dir', 'll', 'get-childitem', 'gci', 'tree', 'find', 'fd', 'du', 'df', 'get-item', 'gi', 'get-itemproperty', 'test-path', 'resolve-path', 'split-path', 'join-path',
  'cp', 'copy', 'copy-item', 'cpi', 'mv', 'move', 'move-item', 'mi', 'rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri', 'mkdir', 'md', 'new-item', 'ni', 'touch', 'chmod', 'chown', 'ln',
  'rename-item', 'ren', 'rename', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'tee', 'tee-object', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', '7z', 'expand-archive', 'compress-archive',
  'echo', 'write-output', 'write-host', 'printf', 'jq', 'yq', 'sed', 'awk', 'cut', 'tr', 'od', 'hexdump', 'xxd', 'md5sum', 'sha1sum', 'sha256sum', 'get-filehash',
  'realpath', 'readlink', 'basename', 'dirname', 'tsc', 'which', 'where', 'get-command', 'gcm', 'cd', 'pushd', 'popd', 'set-location', 'sl', 'chdir',
  'measure-object', 'select-object', 'where-object', 'sort-object', 'format-table', 'format-list', 'out-string', 'convertto-json', 'convertfrom-json', 'get-date', 'get-location', 'pwd', 'true', 'false', 'test', '[',
]);
const GIT_READ_SUBS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'describe', 'shortlog', 'cat-file', 'grep', 'reflog', 'diff-tree', 'show-ref', 'for-each-ref', 'count-objects', 'ls-remote',
]);
// コードを動かさない（R1.3 の引数・R1.7 の宛先を見ない）コマンド
function noCodeRun(seg: Segment): boolean {
  if (READ_ONLY_CMDS.has(seg.cmd)) return true;
  return seg.cmd === 'git' && GIT_READ_SUBS.has(seg.args.find(a => !a.startsWith('-')) ?? '');
}
// 引数の場所に書き込まないコマンド（R1.8）。tar・zip などは展開先（-C skills/）に書くので、読むだけには数えない
const ARCHIVERS = new Set(['tar', 'zip', 'unzip', 'gzip', 'gunzip', '7z', 'expand-archive', 'compress-archive']);
export function readOnlyInvocation(seg: Segment): boolean {
  return noCodeRun(seg) && !ARCHIVERS.has(seg.cmd);
}

const PACKAGE_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_READONLY_SUB = new Set(['ls', 'list', 'll', 'la', 'view', 'info', 'show', 'outdated', 'why', 'explain', 'help', 'audit', 'version', 'bin', 'root', 'prefix']);
const RUNNER_TOOLS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye', 'bundle']);
// パッケージの道具を取ってきて（または node_modules/.bin のものを）動かす。node_modules は Clive が書き換えられるので、毎回確かめる
const NPX_TOOLS = new Set(['npx', 'pnpx', 'bunx']);
const BUILD_TOOLS = new Set([
  'make', 'gmake', 'nmake', 'just', 'rake', 'ninja', 'mvn', 'gradle', 'gradlew', 'ant', 'sbt', 'pytest', 'tox', 'nox', 'jest', 'vitest', 'mocha', 'playwright', 'msbuild',
]);
const TOOLCHAINS_READONLY = new Map<string, Set<string>>([
  ['cargo', new Set(['version', 'env', 'list', 'doc', 'fmt', 'vet', 'tree', 'help', 'metadata', 'search'])],
  ['go', new Set(['version', 'env', 'list', 'doc', 'fmt', 'vet', 'tree', 'help'])],
  ['dotnet', new Set(['version', 'env', 'list', 'doc', 'fmt', 'vet', 'tree', 'help'])],
]);
const PROJECT_FILES: Record<string, string[]> = {
  npm: ['package.json'], pnpm: ['package.json'], yarn: ['package.json'], bun: ['package.json'],
  make: ['Makefile', 'makefile', 'GNUmakefile'], gmake: ['Makefile', 'makefile', 'GNUmakefile'], just: ['justfile', 'Justfile'], rake: ['Rakefile'], ant: ['build.xml'],
  uv: ['pyproject.toml'], poetry: ['pyproject.toml'], pdm: ['pyproject.toml'], hatch: ['pyproject.toml'],
};

const SPAWNERS = new Set(['wsl', 'start-process', 'saps', 'start', 'setsid', 'at', 'batch', 'systemd-run', 'start-job', 'start-threadjob', 'invoke-command', 'icm', 'new-pssession', 'enter-pssession', 'screen', 'tmux']);
const LAUNCHERS = new Set(['rundll32', 'regsvr32', 'installutil', 'regasm', 'regsvcs', 'cmstp', 'msiexec', 'wmic', 'bitsadmin']);
const WEB_CMDLETS = new Set(['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'curl', 'wget']);
const SAFE_TYPES = new Set(['datetime', 'timespan', 'guid', 'regex', 'int', 'int32', 'int64', 'uint32', 'uint64', 'long', 'double', 'decimal', 'float', 'single', 'string', 'char', 'bool', 'byte']);
// 変数の次に来る演算子（`$_ * 2`・`$x -gt 1`）。コマンドの引数ではなく式の続き
const PS_OPERATOR = /^(?:-(?:[ic]?(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split|join)|is|isnot|as|and|or|xor|not|band|bor|bxor|bnot|shl|shr|f)|[+\-*/%]=?|=|\+\+|--|\.\.?|,|[<>].*)$/iu;

// コマンドの文字のなかの、この PC の中の宛先（ループバック）
const LOOPBACK = /(?:^|[^\w.])(?:127\.\d{1,3}(?:\.\d{1,3}){0,2}|localhost|0\.0\.0\.0|2130706433|0x7f[0-9a-f]*|\[?::1\]?)(?![\w-])/iu;

// Clive 自身の設定・人格・承認・記憶に触れる文字（人への目印。判定には使わない）
const SELF_MARKERS: ReadonlyArray<[string, RegExp]> = [
  ['/api/', /\/api\//u], ['config.json', /config\.json/iu], ['SOUL.md', /SOUL\.md/iu], ['USER.md', /USER\.md/iu], ['clive.db', /clive\.db/iu], ['.env', /(?:^|[^\w])\.env(?![\w])/u],
  ['skills/', /skills[\\/]/iu], ['127.0.0.1 / localhost', LOOPBACK],
];
export function selfTouchMarkers(text: string, selfHosts: readonly string[]): string[] {
  const found = SELF_MARKERS.filter(([, re]) => re.test(text)).map(([label]) => label);
  const lower = text.toLowerCase();
  for (const host of selfHosts) if (host && lower.includes(host.toLowerCase()) && !found.includes(host)) found.push(host);
  return found;
}

const text = (language: Language, key: GuardMessageKey, params?: Record<string, string | number>) => guardText(language, key, params);

const REDIRECT_OP = /^\d*(?:<<<|<<-?|<|>>|>|&>>?|>\|)$/u;
const REDIRECT_TOKEN = /^(?:\d*[<>]|&>)/u;

// リダイレクト（< file、> file、2>&1、<<EOF）を除いた引数
function plainArgs(seg: Segment): string[] {
  const out: string[] = [];
  for (let i = 0; i < seg.args.length; i++) {
    const raw = seg.rawArgs[i] ?? seg.args[i]!;
    if (REDIRECT_OP.test(raw)) { i++; continue; }
    if (REDIRECT_TOKEN.test(raw)) continue;
    out.push(seg.args[i]!);
  }
  return out;
}

function redirectInputs(seg: Segment): string[] {
  const out: string[] = [];
  for (let i = 0; i < seg.rawArgs.length; i++) {
    const raw = seg.rawArgs[i]!;
    if (raw === '<') { const target = seg.args[i + 1]; if (target) out.push(target); }
    else if (/^<(?![<(]).+/u.test(raw)) out.push(raw.slice(1).replace(/^["']|["']$/gu, ''));
  }
  return out;
}

const fileLike = (arg: string): boolean => /[\\/]/u.test(arg) || /\.[A-Za-z0-9]{1,5}$/u.test(arg);

function resolveScript(raw: string, ctx: CodeContext): string | undefined {
  if (!raw || raw === '-') return undefined;
  const expanded = expandPath(raw, ctx.cwd, process.env, ctx.language);
  return 'path' in expanded ? expanded.path : undefined;
}
const resolveAll = (raws: readonly string[], ctx: CodeContext): string[] => [...new Set(raws.flatMap(r => resolveScript(r, ctx) ?? []))].slice(0, 3);

const infoOnly = (args: readonly string[]): boolean => args.length > 0 && args.every(a => INFO_FLAG.test(a));

function hasInlineCode(seg: Segment): boolean {
  if (/^(?:sh|bash|zsh|dash|ksh|fish)$/u.test(seg.cmd)) return seg.args.some(a => /^-\w*c\w*$/u.test(a));
  return seg.args.some(a => /^(?:-e|-E|-p|-c|-r|--eval|--print)$/u.test(a)) || (seg.cmd === 'deno' && seg.args[0] === 'eval');
}

const finding = (language: Language, key: GuardMessageKey, params: Record<string, string | number>, exemptable: boolean, scripts: string[] = []): CodeFinding => ({ reason: text(language, key, params), exemptable, scripts });

// ── R1.1 ファイル・標準入力のコード ──
function interpreterFindings(seg: Segment, ctx: CodeContext): CodeFinding[] {
  const lang = ctx.language;
  if (seg.invoke === 'source' || seg.invoke === 'dot') {
    const target = seg.invoke === 'source' ? seg.args[0] : seg.rawCmd;
    return [finding(lang, 'code.file_run', { path: target ?? seg.cmd }, true, target ? resolveAll([target], ctx) : [])];
  }
  if (!INTERPRETER.test(seg.cmd) || infoOnly(seg.args) || hasInlineCode(seg)) return [];
  const positional = plainArgs(seg).filter(a => !a.startsWith('-') || a === '-');
  const runFlag = seg.args.find(a => /^(?:-m|--test|--run|-jar|-cp|-classpath|--class-path|-f|--file)$/u.test(a));
  const files = positional.filter(a => a !== '-' && fileLike(a));
  if (positional.length || runFlag) {
    const named = files[0] ?? positional.find(a => a !== '-') ?? runFlag ?? '-';
    const stdinCode = !files.length && positional.every(a => a === '-') && !runFlag && Boolean(seg.stdin);
    return [stdinCode ? finding(lang, 'code.stdin_run', { cmd: seg.cmd }, true, stdinScripts(seg, ctx)) : finding(lang, 'code.file_run', { path: named }, true, resolveAll(files, ctx))];
  }
  return seg.stdin ? [finding(lang, 'code.stdin_run', { cmd: seg.cmd }, true, stdinScripts(seg, ctx))] : [];
}

function stdinScripts(seg: Segment, ctx: CodeContext): string[] {
  if (seg.stdin === 'redirect') return resolveAll(redirectInputs(seg), ctx);
  if (seg.stdin === 'pipe' && ctx.prev) return resolveAll(plainArgs(ctx.prev).filter(a => !a.startsWith('-') && fileLike(a)), ctx);
  return [];
}

// ── R1.2 コマンドそのものがファイル ──
function commandFileFindings(seg: Segment, ctx: CodeContext): CodeFinding[] {
  if (seg.invoke === 'source' || seg.invoke === 'dot') return [];
  const raw = seg.rawCmd;
  if (/^[$%(]/u.test(raw) || REDIRECT_TOKEN.test(raw)) return [];
  if (/[\\/]/u.test(raw) || raw.startsWith('.') || CODE_EXT.test(raw)) return [finding(ctx.language, 'code.cmd_is_file', { cmd: raw }, true, resolveAll([raw], ctx))];
  return [];
}

// ── R1.3 コードのファイルを引数に取る、読むだけでないコマンド ──
function argFileFindings(seg: Segment, ctx: CodeContext): CodeFinding[] {
  if (noCodeRun(seg) || seg.cmd === 'git' || STATEMENT_WORDS.has(seg.cmd) || /^[$(]/u.test(seg.rawCmd)) return [];
  if (INTERPRETER.test(seg.cmd) || POWERSHELL.test(seg.cmd) || SPAWNERS.has(seg.cmd) || PACKAGE_TOOLS.has(seg.cmd)) return [];
  const files = plainArgs(seg).map(a => a.replace(/^-[A-Za-z]+[:=]/u, '')).filter(a => !a.startsWith('-') && CODE_EXT.test(a));
  return files.length ? [finding(ctx.language, 'code.arg_file', { cmd: seg.cmd, path: files[0]! }, true, resolveAll(files, ctx))] : [];
}

// ── R1.4 作業フォルダのコードを決まりで動かす道具 ──
function projectToolFindings(seg: Segment, ctx: CodeContext): CodeFinding[] {
  const args = plainArgs(seg);
  const sub = args.find(a => !a.startsWith('-'))?.toLowerCase();
  const projectFiles = (PROJECT_FILES[seg.cmd] ?? []).map(name => join(ctx.cwd, name)).filter(p => existsSync(p)).slice(0, 1);
  const tool = () => finding(ctx.language, 'code.project_tool', { cmd: seg.cmd }, true, projectFiles);
  if (PACKAGE_TOOLS.has(seg.cmd)) {
    if (infoOnly(args) || (sub === undefined && seg.cmd !== 'yarn' && args.length === 0)) return [];
    if (seg.cmd === 'bun' && sub && fileLike(sub)) return [finding(ctx.language, 'code.file_run', { path: sub }, true, resolveAll([sub], ctx))];
    return sub && PACKAGE_READONLY_SUB.has(sub) ? [] : [tool()];
  }
  if (NPX_TOOLS.has(seg.cmd)) return infoOnly(args) ? [] : [tool()];
  if (RUNNER_TOOLS.has(seg.cmd)) return sub === 'run' || sub === 'exec' ? [tool()] : [];
  if (BUILD_TOOLS.has(seg.cmd)) return infoOnly(args) ? [] : [tool()];
  const readonly = TOOLCHAINS_READONLY.get(seg.cmd);
  if (readonly) return infoOnly(args) || (sub && readonly.has(sub)) || args.length === 0 ? [] : [tool()];
  return [];
}

// ── R1.5 ほかのプロセスを起こす・残す ──
const WRAPPED_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  xargs: new Set(['-a', '-d', '-E', '-e', '-I', '-i', '-L', '-l', '-n', '-P', '-s', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--replace']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '-P', '-u']),
  stdbuf: new Set(['-i', '-o', '-e']),
  watch: new Set(['-n', '-d', '--interval', '--differences']),
  parallel: new Set(['-j', '-S', '-a', '-N', '-n', '--jobs', '--sshlogin']),
  busybox: new Set(),
};

// xargs / timeout / nice / find -exec などが起こす先のコマンドの文字。起こす先が引数を受け取るもの（xargs・parallel）は、受け取る分として {} を足す。取り出せなければ null
function wrappedCommand(seg: Segment): string[] | null | undefined {
  if (seg.cmd === 'find') {
    const at = seg.args.findIndex(a => /^-(?:exec|execdir|ok|okdir)$/u.test(a));
    if (at < 0) return undefined;
    const tokens: string[] = [];
    for (let i = at + 1; i < seg.rawArgs.length; i++) {
      const token = seg.args[i]!;
      if (token === ';' || token === '\\;' || token === '+') break;
      tokens.push(seg.rawArgs[i]!);
    }
    return tokens.length ? tokens : null;
  }
  const valueFlags = WRAPPED_VALUE_FLAGS[seg.cmd];
  if (!valueFlags) return undefined;
  let i = 0;
  while (i < seg.args.length) {
    const a = seg.args[i]!;
    if (a === '--') { i++; break; }
    if (!a.startsWith('-')) break;
    i += valueFlags.has(a) ? 2 : 1;
  }
  if (seg.cmd === 'timeout') i++;
  const tokens = seg.rawArgs.slice(i);
  if (seg.cmd === 'parallel') { const stop = tokens.indexOf(':::'); if (stop >= 0) tokens.length = stop; }
  if (!tokens.length) return null;
  if ((seg.cmd === 'xargs' || seg.cmd === 'parallel') && !tokens.includes('{}')) tokens.push('{}');
  return tokens;
}

function spawnFindings(seg: Segment, ctx: CodeContext): CodeFinding[] {
  const lang = ctx.language;
  if (SPAWNERS.has(seg.cmd)) return [finding(lang, 'code.spawn', { cmd: seg.cmd }, false)];
  if (POWERSHELL.test(seg.cmd)) {
    if (infoOnly(seg.args)) return [];
    const at = seg.args.findIndex(a => /^-(?:f|file)$/iu.test(a));
    return [finding(lang, 'code.powershell', { cmd: seg.cmd }, false, at >= 0 && seg.args[at + 1] ? resolveAll([seg.args[at + 1]!], ctx) : [])];
  }
  if (LAUNCHERS.has(seg.cmd) || (seg.cmd === 'certutil' && seg.args.some(a => /^-urlcache$/iu.test(a)))) return [finding(lang, 'code.launcher', { cmd: seg.cmd }, false)];
  const inner = wrappedCommand(seg);
  if (inner === undefined) return [];
  if (inner === null) return seg.cmd === 'xargs' || seg.cmd === 'find' ? [] : [finding(lang, 'code.wrapped_unknown', { cmd: seg.cmd }, false)];
  if ((ctx.depth ?? 0) >= 3) return [finding(lang, 'code.wrapped_unknown', { cmd: seg.cmd }, false)];
  return segments(inner.join(' ')).flatMap(innerSeg => codeFindings(innerSeg, { ...ctx, prev: undefined, depth: (ctx.depth ?? 0) + 1 }).map(f => ({ ...f, exemptable: false })));
}

// ── R1.6 何を動かすか分からない形 ──
function unknownTargetFindings(seg: Segment, ctx: CodeContext): CodeFinding[] {
  const lang = ctx.language;
  const raw = seg.rawCmd;
  const detail: string[] = [];
  const assignment = /^\$[\w:{}.]+[+\-*/%]?=/u.test(raw) || /^[+\-*/%]?=$/u.test(seg.args[0] ?? '');
  const nested: CodeFinding[] = [];
  if (assignment) {
    const rhs = seg.raw.slice(seg.raw.indexOf('=') + 1).trim();
    if (rhs && (ctx.depth ?? 0) < 3) {
      for (const inner of segments(rhs)) nested.push(...codeFindings(inner, { ...ctx, prev: undefined, depth: (ctx.depth ?? 0) + 1 }));
    }
  } else {
    const bareVar = /^\$(?:\{[^}]+\}|[\w:?]+)$/u.test(raw);
    if (bareVar && seg.args.length > 0 && !PS_OPERATOR.test(seg.args[0]!)) detail.push(raw);
    else if (seg.invoke && /^[$(]/u.test(seg.raw)) detail.push(seg.raw.split(/\s/u)[0]!);
    else if (/^(?:\$\(|@\()/u.test(raw) || raw.startsWith('\x60')) detail.push(raw);
    if (/%[^%\s]+%/u.test(raw)) detail.push(raw);
    if (/^(?:eval|iex|invoke-expression)$/u.test(seg.cmd)) {
      const only = seg.rawArgs.length === 1 ? seg.rawArgs[0]! : '';
      if (!(/^'[^']*'$/u.test(only) || /^"[^"$\x60(]*"$/u.test(only))) detail.push(seg.cmd);
    }
  }
  const unknown = detail.length ? [finding(lang, 'code.unknown_target', { detail: detail[0]! }, false)] : [];
  return [...unknown, ...nested, ...scanFindings(seg, ctx)];
}

// 文字のなかの、.NET の直接呼び出し・New-Object・Add-Type・splatting・/dev/tcp
function scanFindings(seg: Segment, ctx: CodeContext): CodeFinding[] {
  const scan = stripQuotedContent(seg.raw);
  const found: string[] = [];
  for (const m of scan.matchAll(/\[\s*([A-Za-z_][\w.]*)\s*\]\s*::/gu)) {
    const type = m[1]!.toLowerCase().replace(/^system\./u, '');
    if (!SAFE_TYPES.has(type)) found.push(`[${m[1]}]::`);
  }
  if (/\[\s*scriptblock\s*\]/iu.test(scan)) found.push('[scriptblock]');
  if (/(?:^|[\s;|(&])new-object(?![\w-])/iu.test(scan)) found.push('New-Object');
  if (/(?:^|[\s;|(&])add-type(?![\w-])/iu.test(scan)) found.push('Add-Type');
  if (WEB_CMDLETS.has(seg.cmd) && seg.args.some(a => /^@[A-Za-z_]/u.test(a))) found.push('@splatting');
  if (/\/dev\/(?:tcp|udp)\//u.test(seg.raw)) found.push('/dev/tcp');
  return found.length ? [finding(ctx.language, 'code.unknown_target', { detail: [...new Set(found)].join(', ') }, false)] : [];
}

// ── R1.6 の続き: コードを動かせる環境変数 ──
// どれも、あとで起こすプロセスの起動時に読み込まれ、コードを動かせる（NODE_OPTIONS=--require ./put.js など）。NODE_ENV のような設定だけの値は含めない
const CODE_ENV = new RegExp(`^(?:${[
  'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'PYTHONSTARTUP', 'PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_EXTERNAL_DIFF', 'GIT_ASKPASS',
  'GIT_PAGER', 'GIT_EDITOR', 'GIT_EXEC_PATH', 'GIT_PROXY_COMMAND', 'GIT_TEMPLATE_DIR', 'GIT_CONFIG\\w*', 'PAGER', 'EDITOR', 'VISUAL', 'PROMPT_COMMAND', 'PATH', 'PATHEXT', 'PSMODULEPATH', 'COMSPEC',
  'SHELL', 'RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WRAPPER', 'GOFLAGS', 'NPM_CONFIG_SCRIPT_SHELL', 'NPM_CONFIG_NODE_OPTIONS',
].join('|')})$`, 'iu');

function envFindings(seg: Segment, ctx: CodeContext): CodeFinding[] {
  const names: string[] = [...(seg.envAssign ?? [])];
  const assigned = /^\$env:(\w+)/iu.exec(seg.rawCmd);
  // $env:NAME = ...（読むだけの $env:PATH は数えない）
  if (assigned && (/^\$env:\w+\s*[+\-*/]?=/iu.test(seg.rawCmd) || /^[+\-*/]?=$/u.test(seg.args[0] ?? ''))) names.push(assigned[1]!);
  if (/^(?:export|declare|typeset|setx|set|setenv|readonly|local)$/u.test(seg.cmd)) {
    for (const arg of plainArgs(seg).filter(a => !a.startsWith('-')).slice(0, 2)) names.push(/^(\w+)/u.exec(arg)?.[1] ?? '');
  }
  if (/^(?:set-item|si|set-content|sc|new-item|ni|new-itemproperty|set-variable|sv)$/u.test(seg.cmd)) {
    for (const arg of plainArgs(seg)) { const m = /^(?:-[A-Za-z]+[:=])?env:(\w+)/iu.exec(arg); if (m) names.push(m[1]!); }
  }
  const hit = names.find(name => CODE_ENV.test(name));
  return hit ? [finding(ctx.language, 'code.env', { name: hit }, false)] : [];
}

// ── R1.7 この PC の中のサーバー・Clive 自身 ──
function loopbackFindings(seg: Segment, ctx: CodeContext): CodeFinding[] {
  if (noCodeRun(seg)) return [];
  const hit = LOOPBACK.exec(seg.raw);
  if (hit) return [finding(ctx.language, 'code.loopback', { host: hit[0].replace(/^[^\w[:]/u, '') }, false)];
  const lower = seg.raw.toLowerCase();
  const self = ctx.selfHosts.find(host => host && lower.includes(host.toLowerCase()));
  return self ? [finding(ctx.language, 'code.loopback', { host: self }, false)] : [];
}

// ── R1.10 git の設定でコードを仕込む ──
const SAFE_GIT_KEYS = new Set(['user.name', 'user.email']);
function gitConfigFindings(seg: Segment, ctx: CodeContext): CodeFinding[] {
  if (seg.cmd !== 'git') return [];
  const a = seg.args;
  const subAt = a.findIndex(x => !x.startsWith('-'));
  const withC = a.some((x, i) => (x === '-c' || /^-c.+=/u.test(x)) && (subAt < 0 || i < subAt));
  let writes = false;
  if (a[subAt] === 'config') {
    const rest = a.slice(subAt + 1);
    const reading = rest.some(x => /^(?:--get|--get-all|--get-regexp|--get-urlmatch|-l|--list|--show-origin|--show-scope|--name-only)$/u.test(x));
    const editing = rest.some(x => /^(?:--add|--replace-all|--unset|--unset-all|-e|--edit|--rename-section|--remove-section)$/u.test(x));
    const positional = rest.filter(x => !x.startsWith('-'));
    writes = editing || (!reading && positional.length >= 2 && !SAFE_GIT_KEYS.has(positional[0]!.toLowerCase()));
  }
  return withC || writes ? [finding(ctx.language, 'code.git_config', { cmd: `git ${a.slice(0, 3).join(' ')}`.trim() }, false)] : [];
}

export function codeFindings(seg: Segment, ctx: CodeContext): CodeFinding[] {
  const interpreter = interpreterFindings(seg, ctx);
  const fileCommand = interpreter.length ? [] : commandFileFindings(seg, ctx);
  const argFile = interpreter.length || fileCommand.length ? [] : argFileFindings(seg, ctx);
  return [
    ...interpreter, ...fileCommand, ...argFile, ...projectToolFindings(seg, ctx),
    ...spawnFindings(seg, ctx), ...unknownTargetFindings(seg, ctx), ...envFindings(seg, ctx), ...loopbackFindings(seg, ctx), ...gitConfigFindings(seg, ctx),
  ];
}
