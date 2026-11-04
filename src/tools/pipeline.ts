import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Value } from '@sinclair/typebox/value';
import type { RunEvent, ToolCall } from '../engine/types.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { inputHash, type ApprovalBroker } from './approvals.ts';
import { runCommandHook } from './hooks/command-hook.ts';
import { worst, type Decision } from './hooks/shell-guard.ts';
import type { ToolRegistry } from './registry.ts';
import type { ToolContext, ToolDef, ToolOutput } from './types.ts';

export const REVIEW_FORBIDDEN: ReadonlySet<ToolDef['effect']> = new Set(['write', 'exec', 'network']);

export const TOOL_OUTPUT_LIMIT = 16_000;

export interface PipelineDeps {
  registry: ToolRegistry;
  approvals: ApprovalBroker;
  db: DatabaseSync;
  emit: (event: RunEvent) => void;
}

export interface ToolCallOutcome {
  output: ToolOutput;
  decision: Decision;
  decidedBy: string;
  invalidArguments: boolean;
}

function capOutput(output: ToolOutput): ToolOutput {
  const content = redactSecrets(output.content);
  if (content.length <= TOOL_OUTPUT_LIMIT) return { ...output, content };
  const note = output.fullRef ? `全文は ${output.fullRef} にあります` : '続きは表示していません';
  return { ...output, content: `${content.slice(0, TOOL_OUTPUT_LIMIT)}\n\n[出力が長いため ${content.length.toLocaleString('en-US')} 文字中 ${TOOL_OUTPUT_LIMIT.toLocaleString('en-US')} 文字だけを返しました。${note}]` };
}

const matches = (matcher: string, name: string) => { try { return new RegExp(`^(?:${matcher})$`, 'u').test(name); } catch { return false; } };

export async function runToolCall(call: ToolCall, ctx: ToolContext, deps: PipelineDeps): Promise<ToolCallOutcome> {
  const id = randomUUID();
  const started = Date.now();
  const tool = deps.registry.get(call.name);
  const shownInput = redactSecrets(JSON.stringify(call.arguments ?? call.raw ?? null)).slice(0, 4000);
  deps.emit({ type: 'tool.call', runId: ctx.runId, conversationId: ctx.conversationId, callId: call.id, name: call.name, input: shownInput });

  const finish = (outcome: ToolCallOutcome, approvalId?: string): ToolCallOutcome => {
    const output = capOutput(outcome.output);
    deps.db.prepare(`INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, approval_id, ok, duration_ms, output_preview, full_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, ctx.runId, ctx.conversationId, call.name, shownInput, outcome.decision, outcome.decidedBy, approvalId ?? null,
      output.isError ? 0 : 1, Date.now() - started, output.content.slice(0, 2000), output.fullRef ?? null, started,
    );
    deps.emit({ type: 'tool.result', runId: ctx.runId, conversationId: ctx.conversationId, callId: call.id, name: call.name, ok: !output.isError, decision: outcome.decision, preview: output.content.slice(0, 1500) });
    return { ...outcome, output };
  };
  const refuse = (decision: Decision, decidedBy: string, message: string, invalid = false) =>
    finish({ output: { content: message, isError: true }, decision, decidedBy, invalidArguments: invalid });

  if (!tool) return refuse('deny', 'registry', `ツール「${call.name}」はありません。使えるツール: ${deps.registry.forRun(ctx.kind).map(t => t.name).join(', ')}`, true);
  if (!tool.allowedIn.includes(ctx.kind)) return refuse('deny', 'registry', `ツール「${call.name}」はこの種類の実行では使えません`);
  // 振り返りでは、登録の設定にかかわらず、外に影響する道具（書き込み・実行・送信）を使わせない（二重の禁止）
  if (ctx.kind === 'review' && REVIEW_FORBIDDEN.has(tool.effect)) return refuse('deny', 'registry', `振り返りでは「${call.name}」は使えません`);
  if (call.arguments === undefined) return refuse('deny', 'validation', `引数が JSON として読めません。正しい JSON で呼び直してください: ${(call.raw ?? '').slice(0, 300)}`, true);
  const args = Value.Default(tool.input, Value.Clone(call.arguments));
  if (!Value.Check(tool.input, args)) {
    const errors = [...Value.Errors(tool.input, args)].slice(0, 5).map(e => `${e.path || '/'}: ${e.message}`);
    return refuse('deny', 'validation', `引数の形が正しくありません。直して呼び直してください:\n- ${errors.join('\n- ')}`, true);
  }

  // ── 実行前フック ──
  let decision: Decision = 'allow';
  let decidedBy = 'builtin';
  const reasons: string[] = [];
  let details: string[] = [];
  if (tool.preCheck) {
    try {
      const pre = await tool.preCheck(args, ctx);
      decision = pre.decision; reasons.push(...pre.reasons); details = pre.details ?? [];
    } catch (error) {
      decision = 'deny'; reasons.push(`実行前の判定に失敗しました: ${(error as Error).message}`);
    }
  }
  if (ctx.config.tools.taintEscalation && ctx.taint.tainted && (tool.effect === 'exec' || tool.effect === 'write') && decision === 'allow') {
    decision = 'ask';
    reasons.push(`Web や添付の内容（${ctx.taint.sources.slice(0, 3).join('、')}）を読んだ後なので、念のため確認します`);
  }
  for (const hook of ctx.config.tools.hooks.preToolUse) {
    if (!matches(hook.matcher, tool.name) || decision === 'deny') continue;
    const summary = tool.summarize?.(args);
    const result = await runCommandHook(hook, {
      hook_event_name: 'PreToolUse', tool_name: tool.name, tool_input: args, cwd: summary?.cwd ?? ctx.workspace, run_id: ctx.runId, conversation_id: ctx.conversationId,
    }, ctx.signal);
    if (result.decision && worst(decision, result.decision) !== decision) { decision = result.decision; decidedBy = `hook:${result.hook}`; }
    if (result.reason && result.decision && result.decision !== 'allow') reasons.push(result.reason);
  }

  const hash = inputHash(tool.name, args);
  if (decision === 'ask' && deps.approvals.isGranted(ctx.conversationId, hash)) { decision = 'allow'; decidedBy = 'conversation-grant'; }
  if (decision === 'deny') return refuse('deny', decidedBy, `実行しませんでした（拒否）:\n- ${reasons.join('\n- ')}\n別の方法を考えるか、ユーザーに相談してください`);

  let approvalId: string | undefined;
  if (decision === 'ask') {
    const summary = tool.summarize?.(args) ?? { title: tool.name, body: JSON.stringify(args, null, 2) };
    const pending = deps.approvals.request({
      runId: ctx.runId, conversationId: ctx.conversationId, tool: tool.name, input: args, title: summary.title, body: summary.body,
      cwd: summary.cwd, reasons, details,
    }, ctx.config.tools.shell.approvalTimeoutSec * 1000, ctx.signal);
    approvalId = deps.approvals.pending().find(p => p.inputHash === hash && p.runId === ctx.runId)?.id;
    const outcome = await pending;
    if (outcome !== 'approved') {
      const message = outcome === 'denied' ? 'ユーザーが実行を拒否しました。別の方法を考えるか、理由を尋ねてください'
        : outcome === 'expired' ? '承認の待ち時間が過ぎたため実行しませんでした'
        : '中止しました';
      return finish({ output: { content: message, isError: true }, decision: 'ask', decidedBy: 'user', invalidArguments: false }, approvalId);
    }
    decidedBy = 'user';
  }

  // ── 実行 ──
  let output: ToolOutput;
  try { output = await tool.execute(args, ctx); }
  catch (error) { output = { content: `ツールの実行中にエラーが起きました: ${(error as Error).message}`, isError: true }; }
  if (tool.effect === 'network') { ctx.taint.tainted = true; ctx.taint.sources.push(tool.name); }

  // ── 実行後フック（記録用。結果は変えない） ──
  for (const hook of ctx.config.tools.hooks.postToolUse) {
    if (!matches(hook.matcher, tool.name)) continue;
    await runCommandHook(hook, {
      hook_event_name: 'PostToolUse', tool_name: tool.name, tool_input: args, tool_output: output.content.slice(0, 8000),
      cwd: ctx.workspace, run_id: ctx.runId, conversation_id: ctx.conversationId,
    }, ctx.signal).catch(() => undefined);
  }
  return finish({ output, decision, decidedBy, invalidArguments: false }, approvalId);
}
