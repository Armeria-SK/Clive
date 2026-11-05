import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { AppConfig, Language } from '../../config/schema.ts';
import { languageOf } from '../../shared/language.ts';
import { guardText } from '../../shared/messages/guard.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { redactSecrets } from '../../shared/redaction.ts';
import type { PreviewFile } from '../approvals.ts';
import { selfTouchMarkers } from '../hooks/code-guard.ts';
import { expandPath, isInside, placePath } from '../hooks/scope.ts';
import { checkShellCommand } from '../hooks/shell-guard.ts';
import type { ShellKind } from '../hooks/shell-lex.ts';
import { gitSupportsConfigOverride, prepareGitRun } from '../shell/git-env.ts';
import { findExecutable, resolveShell, runProcess, scrubEnv } from '../shell/runner.ts';
import type { PreCheck, ToolContext, ToolDef } from '../types.ts';

interface ShellInput { command: string; cwd?: string; timeoutSec?: number }

function resolveCwd(input: ShellInput, ctx: ToolContext): { cwd: string } | { problem: string } {
  if (!input.cwd) return { cwd: ctx.workspace };
  const language = languageOf(ctx.config);
  const expanded = expandPath(input.cwd, ctx.workspace, process.env, language);
  if ('unresolved' in expanded) return { problem: guardText(language, 'shell.cwd_unresolved', { detail: expanded.unresolved }) };
  const placement = placePath(expanded.path, ctx.policy);
  if (placement.kind !== 'inside') return { problem: guardText(language, 'shell.cwd_outside', { path: expanded.path }) };
  if (!statSync(expanded.path, { throwIfNoEntry: false })?.isDirectory()) return { problem: guardText(language, 'shell.cwd_missing', { path: expanded.path }) };
  return { cwd: expanded.path };
}

const PREVIEW_CHARS = 8000;
const FINGERPRINT_LIMIT_BYTES = 1_048_576;

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

// server.origins の host。Tailscale の URL なども Clive に届くので、ループバックと同じに確かめる
function selfHostsOf(config: AppConfig): string[] {
  return config.server.origins.flatMap(origin => {
    try { return [new URL(origin).hostname]; } catch { return origin.trim() ? [origin.trim()] : []; }
  });
}

// 子プロセスの環境。git には、ホーム・システムの設定からコードを動かせる項目を落とした設定だけを読ませる（git-env.ts。実行のたびに新しい置き場所に作る）。
// 洗い出せない git（2.32 より古い）、または作業フォルダの中の git は、その版を調べるために動かさず、洗い出していないものとして扱う
function childEnvFor(shell: AppConfig['tools']['shell'], cwd: string, powershell: boolean): { env: Record<string, string>; gitIsolated: boolean; gitExe?: string } {
  const base = scrubEnv(shell.envAllow);
  const gitExe = findExecutable('git', base, cwd, { powershell });
  if (gitExe && (isInside(cwd, gitExe) || !gitSupportsConfigOverride(gitExe))) return { env: base, gitIsolated: false };
  return { env: base, gitIsolated: true, ...(gitExe ? { gitExe } : {}) };
}

interface Peeked { preview: PreviewFile; fingerprint: string; content?: string }

// 確かめの札で見せるファイルを読む。指紋は、承認のあとで中身が変わったかを調べるためのもの
function peek(file: string, language: Language): Peeked {
  const unreadable = (fingerprint: string): Peeked => ({ preview: { path: file, text: guardText(language, 'code.preview_unreadable'), truncated: false }, fingerprint });
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat) return { preview: { path: file, text: guardText(language, 'code.preview_missing'), truncated: false }, fingerprint: `${file}\0missing` };
  if (!stat.isFile() || stat.size > FINGERPRINT_LIMIT_BYTES) return unreadable(`${file}\0${stat.isFile() ? 'big' : 'dir'}\0${stat.size}\0${stat.mtimeMs}`);
  let bytes: Buffer;
  try { bytes = readFileSync(file); } catch { return unreadable(`${file}\0unreadable`); }
  const fingerprint = `${file}\0${sha256(bytes)}`;
  if (bytes.subarray(0, 8000).includes(0)) return unreadable(fingerprint);
  const content = bytes.toString('utf8');
  return { preview: { path: file, text: redactSecrets(content.slice(0, PREVIEW_CHARS)), truncated: content.length > PREVIEW_CHARS }, fingerprint, content };
}

export function shellPreCheck(input: ShellInput, ctx: ToolContext): PreCheck {
  const language = languageOf(ctx.config);
  if (!ctx.config.tools.shell.enabled) return { decision: 'deny', reasons: [guardText(language, 'shell.disabled')] };
  const cwd = resolveCwd(input, ctx);
  if ('problem' in cwd) return { decision: 'deny', reasons: [cwd.problem] };
  const shell = ctx.config.tools.shell;
  const spec = resolveShell(shell.shell);
  const powershell = spec.name === 'powershell' || spec.name === 'pwsh';
  const { env: childEnv, gitIsolated } = childEnvFor(shell, cwd.cwd, powershell);
  const verdict = checkShellCommand(input.command, cwd.cwd, {
    policy: ctx.policy, outsideRoots: ctx.config.tools.outsideRoots, allow: shell.allow, ask: shell.ask, deny: shell.deny, language,
    selfHosts: selfHostsOf(ctx.config), shell: spec.name as ShellKind, windows: process.platform === 'win32', dataDir: ctx.paths.data,
    gitIsolated,
    which: name => findExecutable(name, childEnv, cwd.cwd, { powershell }),
  });
  const details = verdict.paths.map(p => guardText(language, 'shell.detail', {
    input: p.input, path: p.path ?? guardText(language, 'shell.unresolved_path'),
    place: guardText(language, p.placement.kind === 'inside' ? (p.placement.mode === 'write' ? 'shell.place.write' : 'shell.place.read')
      : p.placement.kind === 'outside' ? 'shell.place.outside' : p.placement.kind === 'deny' ? 'shell.place.deny' : 'shell.place.unknown'),
  }));
  if (!verdict.onceOnly || verdict.decision === 'deny') return { decision: verdict.decision, reasons: verdict.reasons, details };
  const peeked = verdict.scripts.map(file => peek(file, language));
  const markers = selfTouchMarkers([input.command, ...peeked.flatMap(p => p.content ?? [])].join('\n'), selfHostsOf(ctx.config));
  const base = verdict.limits ? [...verdict.reasons, guardText(language, 'code.limits')] : verdict.reasons;
  const reasons = markers.length ? [guardText(language, 'code.self_touch', { markers: markers.join(', ') }), ...base] : base;
  return {
    decision: verdict.decision, reasons, details, onceOnly: true, askKinds: verdict.askKinds,
    preview: peeked.map(p => p.preview), bind: sha256(peeked.map(p => p.fingerprint).join('\n')),
  };
}

export const shellRun: ToolDef<ShellInput> = {
  name: 'shell_run',
  description: [
    'シェルのコマンドを1つ実行する（Windows は PowerShell、Linux は bash）。cwd は許可フォルダの中にする（省略時は作業フォルダ）。',
    'cd で外に出ず、cwd を指定すること。外への送信・パッケージの導入・許可フォルダの外に触れる操作はユーザーの承認が要る。',
    '破壊的な操作や秘密情報の読み取りは実行できない。',
    'node_modules や .git のような大きなフォルダを -Recurse などでたどると、遅く（1.5 万ファイルで 20 秒以上）、結果も長すぎて文脈に入りきらない。除外するか、-Name・-Filter・-Depth で範囲を絞ること。',
    'Windows の PowerShell は制限モードで動くので、.NET の型の書き方（[Math]::・[IO.File]::・[pscustomobject]）や New-Object・Add-Type は使わず、コマンドレットと文字列のメソッドで書く。',
    'PowerShell のコマンドレットは、引用符で囲んだパスの * ? [ ] もワイルドカードとして解決する。[ ] を含む名前のファイルを指すときは -LiteralPath を使う。',
  ].join(''),
  input: Type.Object({
    command: Type.String({ minLength: 1, maxLength: 8000 }),
    cwd: Type.Optional(Type.String({ maxLength: 1024 })),
    timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
  }, { additionalProperties: false }),
  effect: 'exec',
  allowedIn: ['chat', 'task'],
  preCheck: shellPreCheck,
  summarize: (input, language) => ({ title: toolText(language, 'summary.shell'), body: input.command, ...(input.cwd ? { cwd: input.cwd } : {}) }),
  async execute(input, ctx, info) {
    const cwd = resolveCwd(input, ctx);
    if ('problem' in cwd) return { content: cwd.problem, isError: true };
    const language = languageOf(ctx.config);
    const settings = ctx.config.tools.shell;
    const shell = resolveShell(settings.shell);
    const timeoutSec = Math.min(input.timeoutSec ?? settings.timeoutSec, settings.maxTimeoutSec);
    const child = childEnvFor(settings, cwd.cwd, shell.name === 'powershell' || shell.name === 'pwsh');
    const gitRun = child.gitIsolated ? prepareGitRun({ dataDir: ctx.paths.data, env: child.env, ownerHooks: info?.approvedOnce === true, ...(child.gitExe ? { gitExe: child.gitExe } : {}) }) : undefined;
    let result;
    try {
      result = await runProcess(shell.file, shell.args(input.command), {
        cwd: cwd.cwd, env: { ...child.env, ...gitRun?.env }, timeoutMs: timeoutSec * 1000, signal: ctx.signal,
        maxBytes: settings.outputCapBytes, fullOutputDir: join(ctx.paths.data, 'tool_outputs'), outputId: `shell-${randomUUID()}`,
      });
    } finally { gitRun?.cleanup(); }
    if (result.spawnError) return { content: toolText(language, 'shell.spawn_failed', { shell: shell.name, detail: result.spawnError }), isError: true };
    const parts = [`$ ${input.command}`, toolText(language, 'shell.header', { shell: shell.name, cwd: cwd.cwd, code: result.exitCode ?? '—', seconds: (result.durationMs / 1000).toFixed(1) })];
    if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
    if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (result.truncated) parts.push(toolText(language, 'shell.truncated', { total: result.totalBytes.toLocaleString('en-US'), cap: settings.outputCapBytes.toLocaleString('en-US'), tail: result.fullOutputPath ? toolText(language, 'shell.truncated_tail', { path: result.fullOutputPath }) : '' }));
    if (result.timedOut) parts.push(toolText(language, 'shell.timeout', { seconds: timeoutSec }));
    if (result.aborted) parts.push(toolText(language, 'shell.aborted'));
    return {
      content: parts.join('\n\n'),
      isError: result.timedOut || result.aborted || result.exitCode !== 0,
      ...(result.fullOutputPath ? { fullRef: result.fullOutputPath } : {}),
    };
  },
};
