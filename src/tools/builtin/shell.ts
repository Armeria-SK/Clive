import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { expandPath, placePath } from '../hooks/scope.ts';
import { checkShellCommand } from '../hooks/shell-guard.ts';
import { resolveShell, runProcess, scrubEnv } from '../shell/runner.ts';
import type { PreCheck, ToolContext, ToolDef } from '../types.ts';

interface ShellInput { command: string; cwd?: string; timeoutSec?: number }

function resolveCwd(input: ShellInput, ctx: ToolContext): { cwd: string } | { problem: string } {
  if (!input.cwd) return { cwd: ctx.workspace };
  const expanded = expandPath(input.cwd, ctx.workspace);
  if ('unresolved' in expanded) return { problem: `cwd が判定できません: ${expanded.unresolved}` };
  const placement = placePath(expanded.path, ctx.policy);
  if (placement.kind !== 'inside') return { problem: `cwd は許可フォルダの中にしてください（${expanded.path}）` };
  if (!statSync(expanded.path, { throwIfNoEntry: false })?.isDirectory()) return { problem: `cwd のフォルダがありません（${expanded.path}）` };
  return { cwd: expanded.path };
}

export function shellPreCheck(input: ShellInput, ctx: ToolContext): PreCheck {
  if (!ctx.config.tools.shell.enabled) return { decision: 'deny', reasons: ['シェルの実行は設定で無効になっています'] };
  const cwd = resolveCwd(input, ctx);
  if ('problem' in cwd) return { decision: 'deny', reasons: [cwd.problem] };
  const shell = ctx.config.tools.shell;
  const verdict = checkShellCommand(input.command, cwd.cwd, {
    policy: ctx.policy, outsideRoots: ctx.config.tools.outsideRoots, allow: shell.allow, ask: shell.ask, deny: shell.deny,
  });
  const details = verdict.paths.map(p => `${p.input} → ${p.path ?? '（判定できない）'}：${
    p.placement.kind === 'inside' ? (p.placement.mode === 'write' ? '許可フォルダ（読み書き）' : '許可フォルダ（読むだけ）')
      : p.placement.kind === 'outside' ? '許可フォルダの外' : p.placement.kind === 'deny' ? '拒否' : '判定できない'}`);
  return { decision: verdict.decision, reasons: verdict.reasons, details };
}

export const shellRun: ToolDef<ShellInput> = {
  name: 'shell_run',
  description: [
    'シェルのコマンドを1つ実行する（Windows は PowerShell、Linux は bash）。cwd は許可フォルダの中にする（省略時は作業フォルダ）。',
    'cd で外に出ず、cwd を指定すること。外への送信・パッケージの導入・許可フォルダの外に触れる操作はユーザーの承認が要る。',
    '破壊的な操作や秘密情報の読み取りは実行できない。',
  ].join(''),
  input: Type.Object({
    command: Type.String({ minLength: 1, maxLength: 8000 }),
    cwd: Type.Optional(Type.String({ maxLength: 1024 })),
    timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
  }, { additionalProperties: false }),
  effect: 'exec',
  allowedIn: ['chat', 'task'],
  preCheck: shellPreCheck,
  summarize: input => ({ title: 'コマンドを実行する', body: input.command, ...(input.cwd ? { cwd: input.cwd } : {}) }),
  async execute(input, ctx) {
    const cwd = resolveCwd(input, ctx);
    if ('problem' in cwd) return { content: cwd.problem, isError: true };
    const settings = ctx.config.tools.shell;
    const shell = resolveShell(settings.shell);
    const timeoutSec = Math.min(input.timeoutSec ?? settings.timeoutSec, settings.maxTimeoutSec);
    const result = await runProcess(shell.file, shell.args(input.command), {
      cwd: cwd.cwd, env: scrubEnv(settings.envAllow), timeoutMs: timeoutSec * 1000, signal: ctx.signal,
      maxBytes: settings.outputCapBytes, fullOutputDir: join(ctx.paths.data, 'tool_outputs'), outputId: `shell-${randomUUID()}`,
    });
    if (result.spawnError) return { content: `シェル（${shell.name}）を起動できません: ${result.spawnError}`, isError: true };
    const parts = [`$ ${input.command}`, `（${shell.name}、cwd: ${cwd.cwd}、終了コード: ${result.exitCode ?? '—'}、${(result.durationMs / 1000).toFixed(1)} 秒）`];
    if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
    if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (result.truncated) parts.push(`[出力が ${result.totalBytes.toLocaleString('en-US')} バイトあったため、先頭 ${settings.outputCapBytes.toLocaleString('en-US')} バイトだけを返しました${result.fullOutputPath ? `。全文: ${result.fullOutputPath}` : ''}]`);
    if (result.timedOut) parts.push(`[${timeoutSec} 秒でタイムアウトしたため止めました（子プロセスも含めて）]`);
    if (result.aborted) parts.push('[中止しました]');
    return {
      content: parts.join('\n\n'),
      isError: result.timedOut || result.aborted || result.exitCode !== 0,
      ...(result.fullOutputPath ? { fullRef: result.fullOutputPath } : {}),
    };
  },
};
