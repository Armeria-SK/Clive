import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Value } from '@sinclair/typebox/value';
import type { RunEvent, ToolCall } from '../engine/types.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { languageOf } from '../shared/language.ts';
import { stricterMode, type PermissionMode } from '../shared/permission-mode.ts';
import { guardText } from '../shared/messages/guard.ts';
import { toolText } from '../shared/messages/tools.ts';
import type { AppConfig, Language } from '../config/schema.ts';
import { inputHash, type ApprovalBroker } from './approvals.ts';
import { autoDecide, mayClassify, type ClassifierPrompt } from './auto-approve.ts';
import { runCommandHook } from './hooks/command-hook.ts';
import { worst, type Decision } from './hooks/shell-guard.ts';
import type { ToolRegistry } from './registry.ts';
import { effectivePolicy, type HasPolicies, type ToolPolicy } from './tool-policy.ts';
import type { AskKind, PreCheck, ToolContext, ToolDef, ToolOutput } from './types.ts';

export const REVIEW_FORBIDDEN: ReadonlySet<ToolDef['effect']> = new Set(['write', 'exec', 'network']);

export const TOOL_OUTPUT_LIMIT = 16_000;

// 計画モードで使える道具の効果: 読む道具（read）と Web の読み取り（network）。モデルに渡す一覧（engine/chat.ts の #toolsFor）も、パイプラインの拒否も、これを使う
export const PLAN_EFFECTS: ReadonlySet<ToolDef['effect']> = new Set(['read', 'network']);

export interface PipelineDeps {
  registry: ToolRegistry;
  approvals: ApprovalBroker;
  db: DatabaseSync;
  emit: (event: RunEvent) => void;
  // いまの設定。実行の途中で道具の方針が厳しくなったら、その場から効かせる（緩くなったときは、実行を始めたときの設定のまま = 次の実行から）
  config?: (() => AppConfig) | undefined;
  // 会話のいまの権限モード。実行に効くのは、実行を始めたときのモード（ctx.permissionMode）との厳しい方（effectiveMode）
  permissionMode?: (() => PermissionMode) | undefined;
  // 自動承認の判定役（モデル）を 1 回呼ぶ。返事の文字を返し、呼べなければ投げる。無ければ、自動承認は何も許さない
  autoClassify?: ((prompt: ClassifierPrompt, signal: AbortSignal) => Promise<string>) | undefined;
  // 判定役に見せる、会話の利用者の最後の発言（添付の中身は除く）
  lastUserRequest?: (() => string) | undefined;
  // 判定役を待つ時間の上限（ミリ秒。試験用。既定 20 秒）
  autoTimeoutMs?: number | undefined;
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

// この呼び出しに効く道具ごとの方針: 実行を始めたときの設定と、いまの設定の厳しい方
function policyFor(name: string, ctx: ToolContext, deps: PipelineDeps): ToolPolicy {
  let now: HasPolicies | undefined;
  try { now = deps.config?.(); } catch { }
  return effectivePolicy(name, now ?? ctx.config, ctx.config);
}

// この呼び出しに効く権限モード: 実行を始めたときのモードと、会話のいまのモードの厳しい方（厳しい向きはその場から、緩む向きは次の実行から）。
// 会話（チャット）の実行だけ。タスク・振り返りは、会話のモードに関係なくふつう
export function effectiveMode(ctx: ToolContext, deps: PipelineDeps): PermissionMode {
  if (ctx.kind !== 'chat') return 'normal';
  const start = ctx.permissionMode ?? 'normal';
  let now: PermissionMode = start;
  if (deps.permissionMode) { try { now = deps.permissionMode(); } catch { now = 'normal'; } }
  return stricterMode(start, now);
}

export async function runToolCall(call: ToolCall, ctx: ToolContext, deps: PipelineDeps): Promise<ToolCallOutcome> {
  const id = randomUUID();
  const language = languageOf(ctx.config);
  const started = Date.now();
  const tool = deps.registry.get(call.name);
  const shownInput = redactSecrets(JSON.stringify(call.arguments ?? call.raw ?? null)).slice(0, 4000);
  deps.emit({ type: 'tool.call', runId: ctx.runId, conversationId: ctx.conversationId, callId: call.id, name: call.name, input: shownInput });

  // 自動承認の判定役が許したときの短い理由（結果の知らせに添える）
  let autoWhy: string | undefined;
  const finish = (outcome: ToolCallOutcome, approvalId?: string): ToolCallOutcome => {
    const output = capOutput(outcome.output, language, ctx.outputLimit ?? TOOL_OUTPUT_LIMIT);
    deps.db.prepare(`INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, approval_id, ok, duration_ms, output_preview, full_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, ctx.runId, ctx.conversationId, call.name, shownInput, outcome.decision, outcome.decidedBy, approvalId ?? null,
      output.isError ? 0 : 1, Date.now() - started, output.content.slice(0, 2000), output.fullRef ?? null, started,
    );
    deps.emit({ type: 'tool.result', runId: ctx.runId, conversationId: ctx.conversationId, callId: call.id, name: call.name, ok: !output.isError, decision: outcome.decision, preview: output.content.slice(0, 1500), ...(autoWhy !== undefined && outcome.decidedBy === 'auto-mode' && outcome.decision === 'allow' ? { autoReason: autoWhy } : {}) });
    return { ...outcome, output };
  };
  const refuse = (decision: Decision, decidedBy: string, message: string, invalid = false) =>
    finish({ output: { content: message, isError: true }, decision, decidedBy, invalidArguments: invalid });

  if (!tool) return refuse('deny', 'registry', toolText(language, 'pipeline.tool_missing', { name: call.name, names: deps.registry.forRun(ctx.kind).map(t => t.name).join(', ') }), true);
  if (!tool.allowedIn.includes(ctx.kind) || ctx.forbiddenTools?.has(tool.name)) return refuse('deny', 'registry', toolText(language, 'pipeline.tool_not_allowed', { name: call.name }));
  // 振り返りでは、登録の設定にかかわらず、外に影響する道具（書き込み・実行・送信）を使わせない（二重の禁止）
  if (ctx.kind === 'review' && REVIEW_FORBIDDEN.has(tool.effect)) return refuse('deny', 'registry', toolText(language, 'pipeline.review_forbidden', { name: call.name }));
  // 持ち主が「止める」にした道具（モデルに渡す一覧からも外している。二重の拒否）。会話の許可・フックの allow では越えられない
  const policy = policyFor(tool.name, ctx, deps);
  if (policy === 'block') return refuse('deny', 'policy', toolText(language, 'pipeline.policy_blocked', { name: tool.name }));
  // 計画モードでは、読む道具と Web の読み取りのほかは使わせない（モデルに渡す一覧からも外している。二重の拒否）
  if (effectiveMode(ctx, deps) === 'plan' && !PLAN_EFFECTS.has(tool.effect)) return refuse('deny', 'mode', toolText(language, 'pipeline.mode_plan', { name: tool.name }));
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
  // 確かめ（ask）になった理由の種類。理由を足すたびに、その種類も足す（段 8b の自動承認は、これで判定役に回すかを決める）
  const askKinds = new Set<AskKind>();
  if (tool.preCheck) {
    try {
      const pre = await tool.preCheck(args, ctx);
      first = pre;
      decision = pre.decision; reasons.push(...pre.reasons); details = pre.details ?? [];
      // 事前の判定が理由ごとに付けた種類。何も付けていない確かめは precheck（細かい種類なし）で、自動承認の判定役には回らない
      if (pre.decision === 'ask') { for (const kind of pre.askKinds ?? []) askKinds.add(kind); if (!pre.askKinds?.length) askKinds.add('precheck'); }
    } catch (error) {
      decision = 'deny'; reasons.push(guardText(language, 'pipeline.precheck_failed', { detail: (error as Error).message }));
    }
  }
  // 外から読んだ内容のあとは、ほかの理由で既に ask でも、理由の種類に taint を載せる（自動承認が、外を読んだあとのものを判定役に回さないため）。拒否は拒否のまま
  if (ctx.config.tools.taintEscalation && ctx.taint.tainted && (tool.effect === 'exec' || tool.effect === 'write' || tool.escalateOnTaint) && decision !== 'deny') {
    decision = worst(decision, 'ask');
    askKinds.add('taint');
    reasons.push(guardText(language, 'pipeline.taint', { sources: ctx.taint.sources.slice(0, 3).join(guardText(language, 'pipeline.taint_sep')) }));
  }
  // 道具ごとの方針 ask: 今の判定に「承認を求める」を足すだけ（拒否は拒否のまま。allow は何もしない）。振り返りには承認する人がいないので拒否として扱う
  if (policy === 'ask' && decision !== 'deny') {
    if (ctx.kind === 'review') {
      decision = 'deny'; decidedBy = 'policy';
      reasons.push(guardText(language, 'pipeline.policy_review', { name: tool.name }));
    } else {
      decision = worst(decision, 'ask');
      askKinds.add('policy');
      reasons.push(guardText(language, 'pipeline.policy_ask', { name: tool.name }));
    }
  }
  // 自動承認で許可フォルダの外を読んだ実行では、その残りのあいだ、通信の道具は確かめる（外で読んだ中身を、確かめなしに外へ送らせない）
  const afterAutoRead = ctx.autoReadOutside === true && tool.effect === 'network' && decision !== 'deny';
  if (afterAutoRead) {
    decision = worst(decision, 'ask');
    askKinds.add('egress');
    reasons.push(guardText(language, 'pipeline.auto_egress'));
  }
  for (const hook of ctx.config.tools.hooks.preToolUse) {
    if (!matches(hook.matcher, tool.name) || decision === 'deny') continue;
    const summary = tool.summarize?.(args, language);
    const result = await runCommandHook(hook, {
      hook_event_name: 'PreToolUse', tool_name: tool.name, tool_input: args, cwd: summary?.cwd ?? ctx.workspace, run_id: ctx.runId, conversation_id: ctx.conversationId,
    }, ctx.signal, language);
    if (result.decision && worst(decision, result.decision) !== decision) { decision = result.decision; decidedBy = `hook:${result.hook}`; }
    if (result.decision === 'ask') askKinds.add('hook');
    if (result.reason && result.decision && result.decision !== 'allow') reasons.push(result.reason);
  }

  const hash = inputHash(tool.name, args);
  // コードを動かす確かめは中身が変わりうるので、前に同じ文字のコマンドを「この会話では許可」にしていても、また確かめる。方針が ask の確かめも、毎回確かめる
  const onceOnly = first?.onceOnly === true;
  const everyTime = askKinds.has('policy') || afterAutoRead;
  if (decision === 'ask' && !onceOnly && !everyTime && deps.approvals.isGranted(ctx.conversationId, hash)) { decision = 'allow'; decidedBy = 'conversation-grant'; }
  if (decision === 'deny') return refuse('deny', decidedBy, toolText(language, 'pipeline.denied', { reasons: reasons.join('\n- ') }));

  let approvalId: string | undefined;
  // ── 自動承認（段 8b）: 判定役に回してよい確かめだけを、判定役に聞く。許せば実行、確かめる・失敗・時間切れ・読めない返事なら、いつもの承認の札 ──
  if (decision === 'ask' && deps.autoClassify && mayClassify({ mode: effectiveMode(ctx, deps), runKind: ctx.kind, decision, kinds: askKinds, onceOnly, everyTime, tainted: ctx.taint.tainted })) {
    const summary = tool.summarize?.(args, language) ?? { title: tool.name, body: JSON.stringify(args, null, 2) };
    const autoEvent = (state: 'checking' | 'allowed' | 'asked', reason?: string) =>
      deps.emit({ type: 'tool.auto', runId: ctx.runId, conversationId: ctx.conversationId, callId: call.id, name: call.name, state, ...(reason !== undefined ? { reason } : {}) });
    autoEvent('checking');
    const verdict = await autoDecide({
      userRequest: deps.lastUserRequest?.() ?? '', tool: tool.name, title: summary.title, body: summary.body, cwd: summary.cwd, reasons, paths: first?.paths ?? [],
    }, deps.autoClassify, ctx.signal, deps.autoTimeoutMs);
    if (ctx.signal.aborted) {
      autoEvent('asked');
      return finish({ output: { content: toolText(language, 'pipeline.cancelled'), isError: true }, decision: 'ask', decidedBy: 'auto-mode', invalidArguments: false });
    }
    const why = verdict.reason || guardText(language, 'pipeline.auto_no_reason');
    if (verdict.decision === 'allow') {
      approvalId = deps.approvals.recordAuto({
        runId: ctx.runId, conversationId: ctx.conversationId, tool: tool.name, input: args, title: summary.title, body: summary.body, cwd: summary.cwd, reasons, details, kinds: [...askKinds],
      }, why);
      decision = 'allow'; decidedBy = 'auto-mode'; autoWhy = why;
      if (askKinds.has('outside_read')) ctx.autoReadOutside = true;
      autoEvent('allowed', why);
    } else {
      reasons.push(verdict.failed ? guardText(language, 'pipeline.auto_failed') : guardText(language, 'pipeline.auto_asked', { reason: why }));
      autoEvent('asked');
    }
  }
  let approvedOnce = false;
  if (decision === 'ask') {
    const summary = tool.summarize?.(args, language) ?? { title: tool.name, body: JSON.stringify(args, null, 2) };
    const pending = deps.approvals.request({
      runId: ctx.runId, conversationId: ctx.conversationId, tool: tool.name, input: args, title: summary.title, body: summary.body,
      cwd: summary.cwd, reasons, details, onceOnly, everyTime, kinds: [...askKinds], preview: first?.preview, paths: first?.paths, pathsMore: first?.pathsMore,
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
  // 外から読んだ印は、通信の道具が「結果の文に相手の文字が 1 つも入らない失敗」と自分で言ったとき（noRemoteContent）のほかは付ける。失敗の文にも相手の文字（Content-Type・転送先の URL など）は入りうる
  if (tool.effect === 'network' && !(output.isError && output.noRemoteContent)) { ctx.taint.tainted = true; ctx.taint.sources.push(tool.name); }

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
