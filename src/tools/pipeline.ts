import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Value } from '@sinclair/typebox/value';
import type { RunEvent, ToolCall } from '../engine/types.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { languageOf } from '../shared/language.ts';
import { guardText } from '../shared/messages/guard.ts';
import { toolText } from '../shared/messages/tools.ts';
import type { Language } from '../config/schema.ts';
import { inputHash, type ApprovalBroker } from './approvals.ts';
import { runCommandHook } from './hooks/command-hook.ts';
import { worst, type Decision } from './hooks/shell-guard.ts';
import type { ToolRegistry } from './registry.ts';
import type { PreCheck, ToolContext, ToolDef, ToolOutput } from './types.ts';

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

function capOutput(output: ToolOutput, language: Language, limit: number): ToolOutput {
  const content = redactSecrets(output.content);
  if (content.length <= limit) return { ...output, content };
  const note = output.fullRef ? toolText(language, 'pipeline.note_full', { ref: output.fullRef }) : toolText(language, 'pipeline.note_none');
  return { ...output, content: `${content.slice(0, limit)}\n\n${toolText(language, 'pipeline.truncated', { total: content.length.toLocaleString('en-US'), shown: limit.toLocaleString('en-US'), note })}` };
}

const matches = (matcher: string, name: string) => { try { return new RegExp(`^(?:${matcher})$`, 'u').test(name); } catch { return false; } };

export async function runToolCall(call: ToolCall, ctx: ToolContext, deps: PipelineDeps): Promise<ToolCallOutcome> {
  const id = randomUUID();
  const language = languageOf(ctx.config);
  const started = Date.now();
  const tool = deps.registry.get(call.name);
  const shownInput = redactSecrets(JSON.stringify(call.arguments ?? call.raw ?? null)).slice(0, 4000);
  deps.emit({ type: 'tool.call', runId: ctx.runId, conversationId: ctx.conversationId, callId: call.id, name: call.name, input: shownInput });

  const finish = (outcome: ToolCallOutcome, approvalId?: string): ToolCallOutcome => {
    const output = capOutput(outcome.output, language, ctx.outputLimit ?? TOOL_OUTPUT_LIMIT);
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

  if (!tool) return refuse('deny', 'registry', toolText(language, 'pipeline.tool_missing', { name: call.name, names: deps.registry.forRun(ctx.kind).map(t => t.name).join(', ') }), true);
  if (!tool.allowedIn.includes(ctx.kind) || ctx.forbiddenTools?.has(tool.name)) return refuse('deny', 'registry', toolText(language, 'pipeline.tool_not_allowed', { name: call.name }));
  // 振り返りでは、登録の設定にかかわらず、外に影響する道具（書き込み・実行・送信）を使わせない（二重の禁止）
  if (ctx.kind === 'review' && REVIEW_FORBIDDEN.has(tool.effect)) return refuse('deny', 'registry', toolText(language, 'pipeline.review_forbidden', { name: call.name }));
  if (call.arguments === undefined) return refuse('deny', 'validation', toolText(language, 'pipeline.bad_json', { raw: (call.raw ?? '').slice(0, 300) }), true);
  const args = Value.Default(tool.input, Value.Clone(call.arguments));
  if (!Value.Check(tool.input, args)) {
    const errors = [...Value.Errors(tool.input, args)].slice(0, 5).map(e => `${e.path || '/'}: ${e.message}`);
    return refuse('deny', 'validation', toolText(language, 'pipeline.bad_args', { errors: errors.join('\n- ') }), true);
  }

  // ── 実行前フック ──
  let decision: Decision = 'allow';
  let decidedBy = 'builtin';
  const reasons: string[] = [];
  let details: string[] = [];
  let first: PreCheck | undefined;
  if (tool.preCheck) {
    try {
      const pre = await tool.preCheck(args, ctx);
      first = pre;
      decision = pre.decision; reasons.push(...pre.reasons); details = pre.details ?? [];
    } catch (error) {
      decision = 'deny'; reasons.push(guardText(language, 'pipeline.precheck_failed', { detail: (error as Error).message }));
    }
  }
  if (ctx.config.tools.taintEscalation && ctx.taint.tainted && (tool.effect === 'exec' || tool.effect === 'write' || tool.escalateOnTaint) && decision === 'allow') {
    decision = 'ask';
    reasons.push(guardText(language, 'pipeline.taint', { sources: ctx.taint.sources.slice(0, 3).join(guardText(language, 'pipeline.taint_sep')) }));
  }
  for (const hook of ctx.config.tools.hooks.preToolUse) {
    if (!matches(hook.matcher, tool.name) || decision === 'deny') continue;
    const summary = tool.summarize?.(args, language);
    const result = await runCommandHook(hook, {
      hook_event_name: 'PreToolUse', tool_name: tool.name, tool_input: args, cwd: summary?.cwd ?? ctx.workspace, run_id: ctx.runId, conversation_id: ctx.conversationId,
    }, ctx.signal, language);
    if (result.decision && worst(decision, result.decision) !== decision) { decision = result.decision; decidedBy = `hook:${result.hook}`; }
    if (result.reason && result.decision && result.decision !== 'allow') reasons.push(result.reason);
  }

  const hash = inputHash(tool.name, args);
  // コードを動かす確かめは中身が変わりうるので、前に同じ文字のコマンドを「この会話では許可」にしていても、また確かめる
  const onceOnly = first?.onceOnly === true;
  if (decision === 'ask' && !onceOnly && deps.approvals.isGranted(ctx.conversationId, hash)) { decision = 'allow'; decidedBy = 'conversation-grant'; }
  if (decision === 'deny') return refuse('deny', decidedBy, toolText(language, 'pipeline.denied', { reasons: reasons.join('\n- ') }));

  let approvalId: string | undefined;
  let approvedOnce = false;
  if (decision === 'ask') {
    const summary = tool.summarize?.(args, language) ?? { title: tool.name, body: JSON.stringify(args, null, 2) };
    const pending = deps.approvals.request({
      runId: ctx.runId, conversationId: ctx.conversationId, tool: tool.name, input: args, title: summary.title, body: summary.body,
      cwd: summary.cwd, reasons, details, onceOnly, preview: first?.preview, paths: first?.paths,
    }, ctx.config.tools.shell.approvalTimeoutSec * 1000, ctx.signal);
    approvalId = deps.approvals.pending().find(p => p.inputHash === hash && p.runId === ctx.runId)?.id;
    const outcome = await pending;
    if (outcome !== 'approved') {
      const message = outcome === 'denied' ? toolText(language, 'pipeline.user_denied')
        : outcome === 'expired' ? toolText(language, 'pipeline.expired')
        : toolText(language, 'pipeline.cancelled');
      return finish({ output: { content: message, isError: true }, decision: 'ask', decidedBy: 'user', invalidArguments: false }, approvalId);
    }
    decidedBy = 'user';

    // 見せたあとで中身が変わっていたら（ほかの会話やタスクが書き換えた場合など）、許可されたものとは別のコードなので動かさない
    if (onceOnly && tool.preCheck) {
      let again: PreCheck;
      try { again = await tool.preCheck(args, ctx); }
      catch (error) { again = { decision: 'deny', reasons: [guardText(language, 'pipeline.precheck_failed', { detail: (error as Error).message })] }; }
      if (again.decision === 'deny') return finish({ output: { content: toolText(language, 'pipeline.denied', { reasons: again.reasons.join('\n- ') }), isError: true }, decision: 'deny', decidedBy: 'recheck', invalidArguments: false }, approvalId);
      if (again.bind !== first?.bind) return finish({ output: { content: toolText(language, 'pipeline.changed'), isError: true }, decision: 'deny', decidedBy: 'recheck', invalidArguments: false }, approvalId);
    }
    approvedOnce = onceOnly;
  }

  // ── 実行 ──
  let output: ToolOutput;
  try { output = await tool.execute(args, ctx, { approvedOnce, ...(approvedOnce && first ? { check: first } : {}) }); }
  catch (error) { output = { content: toolText(language, 'pipeline.exec_error', { detail: (error as Error).message }), isError: true }; }
  // 外から読んだ印は、中身を読めたときだけ付ける（通信に失敗した呼び出しは、何も読んでいない）
  if (tool.effect === 'network' && !output.isError) { ctx.taint.tainted = true; ctx.taint.sources.push(tool.name); }

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
