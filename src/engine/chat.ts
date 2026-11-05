import { randomUUID } from 'node:crypto';
import { DEFAULT_LANGUAGE, LANGUAGES, type AppConfig, type Language, type ModelConfig, type ProviderConfig } from '../config/schema.ts';
import type { Conversations, StoredMessage } from '../db/conversations.ts';
import type { KV } from '../db/kv.ts';
import type { Runs } from '../db/runs.ts';
import type { AppPaths } from '../paths.ts';
import type { EndpointLimiter } from '../providers/limiter.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { ProviderError, providerError, type ProviderAdapter } from '../providers/types.ts';
import { renderBooks, type MemoryStore } from '../memory/store.ts';
import type { ApprovalBroker } from '../tools/approvals.ts';
import { REVIEW_FORBIDDEN, runToolCall } from '../tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../tools/policy.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { RunKind, TaskControl, ToolContext, ToolDef } from '../tools/types.ts';
import type { CuriosityStore } from '../curiosity/store.ts';
import type { SkillStore } from '../tools/skills/store.ts';
import type { Task, TaskStore } from '../tasks/store.ts';
import type { RunBus } from './bus.ts';
import { ContextOverflow, fitMessages } from './fit.ts';
import type { ModelStatus } from './status.ts';
import { extractToolCalls, jsonFallbackInstructions, looksLikeTextToolCall, toJsonFallbackHistory } from './toolcall-parse.ts';
import type { AttachmentMeta, ChatMessage, ContextDetail, EngineErrorKind, EngineResult, ImageRef, StopReason, ToolCall, Usage } from './types.ts';
import { estimateTextTokens } from './tokens.ts';
import { languageOf } from '../shared/language.ts';
import { providerText } from '../shared/messages/providers.ts';
import { engineText, type EngineMessageKey } from '../shared/messages/engine.ts';
import type { MessageParams } from '../shared/messages/define.ts';
import { compactPrompt, compactSpeaker, compactSystem, replyLanguageKey, snapshotLanguageKey, summarySection, withReplyReminder } from './prompts.ts';
import { buildDynamic, buildSnapshot, recordFileVersions } from './workspace.ts';
import { stripAttachments } from '../uploads/store.ts';

export const CONTEXT_FILL_RATIO = 0.95;
export const TRUNCATION_RATIO = 0.6;
const TRUNCATION_MIN_ESTIMATE = 2048;
const TRUNCATION_STRIKES = 2;
const CALIBRATION_ALPHA = 0.3;
const MAX_BACKOFF_MS = 30_000;
const MAX_INVALID_STREAK = 3;
const COMPACT_MIN_MESSAGES = 4;
const COMPACT_TRANSCRIPT_CHARS = 60_000;

export interface ChatEngineDeps {
  config: () => AppConfig;
  conversations: Conversations;
  runs: Runs;
  kv: KV;
  registry: ProviderRegistry;
  status: ModelStatus;
  bus: RunBus;
  limiter: EndpointLimiter;
  paths: AppPaths;
  tools?: { registry: ToolRegistry; approvals: ApprovalBroker };
  memory?: MemoryStore;
  tasks?: TaskStore;
  curiosity?: CuriosityStore;
  skills?: SkillStore;
  web?: NonNullable<ToolContext['services']>['web'];
  log?: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  retriesPerModel?: number;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const ATTACHMENT_PLACEHOLDER = new RegExp(`^(?:${(['ja', 'en'] as const).flatMap(l => [engineText(l, 'attachment.image'), engineText(l, 'attachment.file')]).map(escapeRegExp).join('|')})$`, 'u');

// messageCode / messageParams は、モデルの確認（probe）の messageCode / messageParams と同じ（確認していない・設定に無いときは engine.problem.*）。画面が自分の言語で組み立てられるように添える。
export interface ModelProblem { modelId: string; status: string; message: string; hint?: string | undefined; messageCode?: string | undefined; messageParams?: MessageParams | undefined }

export type SendOutcome =
  | { ok: true; runId: string; messageId?: number }
  | { ok: false; httpStatus: number; errorKind: EngineErrorKind | 'busy' | 'not_found'; errorMessage: string; errorCode?: string; detail?: ContextDetail; problems?: ModelProblem[] };

type Route = { model: ModelConfig; provider: ProviderConfig };

// 会話（チャット）や裏の作業が、どのモデルを順に試すか。順番が空なら設定のモデル全部（モデルが 0 個なら空）。
// 送信の画像の可否の確かめも、これを使う（エンジンと確かめの候補を食い違わせない）。
export function candidateModelIds(config: AppConfig, route: 'chat' | 'background'): string[] {
  const preferred = route === 'background' && config.routing.background.length ? config.routing.background : config.routing.chat;
  return preferred.length ? [...preferred] : config.models.map(m => m.id);
}

type Failure = { kind: EngineErrorKind; message: string; code?: string; params?: MessageParams; retryable: boolean; detail?: ContextDetail; route?: Route };

type CallResult =
  | { ok: true; index: number; text: string; toolCalls: ToolCall[]; usage: Usage; stop: StopReason; estimate: number; language: Language }
  | { ok: false; cancelled: boolean; partial: string; failure: Failure; route?: Route };

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface Active { runId: string; conversationId: string; kind: RunKind; providers: Set<string>; controller: AbortController; done: Promise<EngineResult> }

export class ChatEngine {
  readonly #d: ChatEngineDeps;
  #active = new Map<string, Active>();
  #byConversation = new Map<string, string>();
  #preempted = new Set<string>();
  #initialTaint = new Map<string, string[]>();
  lastUserActivity = 0;
  onRunEnd: ((run: { runId: string; conversationId: string; kind: RunKind }) => void) | undefined;

  constructor(deps: ChatEngineDeps) { this.#d = deps; }

  #busy(key: EngineMessageKey): SendOutcome {
    return { ok: false, httpStatus: 409, errorKind: 'busy', errorMessage: engineText(languageOf(this.#d.config()), key), errorCode: `engine.${key}` };
  }

  send(conversationId: string, text: string, images: ImageRef[] = [], attachments: AttachmentMeta[] = []): SendOutcome {
    if (this.#byConversation.has(conversationId)) return this.#busy('send.busy_chat');
    const chain = this.#chain('chat');
    if (!chain.usable.length) return this.#noUsableModel(chain.problems);
    this.#preemptFor(chain.usable);
    this.lastUserActivity = this.#d.now?.().getTime() ?? Date.now();
    const saved = this.#d.conversations.append(conversationId, { role: 'user', content: text, ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}) });
    // 添付の中身はタイトルにしない（本文が無ければ添付の名前にする）
    this.#d.conversations.autoTitle(conversationId, attachments.length ? stripAttachments(text).replace(ATTACHMENT_PLACEHOLDER, '') || attachments[0]!.name : text);
    const runId = randomUUID();
    this.#d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    // 添付の中身は外部のデータなので、この実行ではシェルと書き込みを承認制にする（taint）
    if (attachments.length) this.#initialTaint.set(runId, attachments.map(a => engineText(languageOf(this.#d.config()), 'attachment.taint', { name: a.name })));
    this.#start(runId, conversationId, chain.usable, 'chat');
    return { ok: true, runId, messageId: saved.id };
  }

  retry(conversationId: string): SendOutcome {
    if (this.#byConversation.has(conversationId)) return this.#busy('send.busy');
    const last = this.#d.conversations.messages(conversationId, 1).at(-1);
    if (!last || last.role === 'assistant') return { ok: false, httpStatus: 409, errorKind: 'not_found', errorMessage: engineText(languageOf(this.#d.config()), 'send.nothing_to_retry'), errorCode: 'engine.send.nothing_to_retry' };
    const chain = this.#chain('chat');
    if (!chain.usable.length) return this.#noUsableModel(chain.problems);
    this.#preemptFor(chain.usable);
    this.lastUserActivity = this.#d.now?.().getTime() ?? Date.now();
    const runId = randomUUID();
    this.#start(runId, conversationId, chain.usable, 'chat');
    return { ok: true, runId };
  }

  runTask(task: Task, conversationId: string, prompt: string): { ok: true; runId: string; control: { value: TaskControl }; done: Promise<EngineResult> } | { ok: false; errorMessage: string } {
    if (this.#byConversation.has(conversationId)) return { ok: false, errorMessage: engineText(languageOf(this.#d.config()), 'send.task_running') };
    const chain = this.#chain('background');
    if (!chain.usable.length) {
      const outcome = this.#noUsableModel(chain.problems);
      return { ok: false, errorMessage: outcome.ok ? '' : outcome.errorMessage };
    }
    const saved = this.#d.conversations.append(conversationId, { role: 'user', content: prompt });
    const runId = randomUUID();
    this.#d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    const control = { value: { outcome: 'none' } as TaskControl };
    this.#start(runId, conversationId, chain.usable, 'task', { task, control });
    return { ok: true, runId, control, done: this.#active.get(runId)!.done };
  }

  runReview(conversationId: string, prompt: string): { ok: true; runId: string; done: Promise<EngineResult> } | { ok: false; errorMessage: string } {
    if (this.#byConversation.has(conversationId)) return { ok: false, errorMessage: engineText(languageOf(this.#d.config()), 'send.review_running') };
    const chain = this.#chain('background');
    if (!chain.usable.length) {
      const outcome = this.#noUsableModel(chain.problems);
      return { ok: false, errorMessage: outcome.ok ? '' : outcome.errorMessage };
    }
    const saved = this.#d.conversations.append(conversationId, { role: 'user', content: prompt });
    const runId = randomUUID();
    this.#d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    this.#start(runId, conversationId, chain.usable, 'review');
    return { ok: true, runId, done: this.#active.get(runId)!.done };
  }

  wasPreempted(runId: string): boolean { return this.#preempted.has(runId); }

  #preemptFor(routes: Route[]): void {
    const providers = new Set(routes.map(r => r.provider.id));
    for (const active of this.#active.values()) {
      if (active.kind === 'chat' || ![...active.providers].some(p => providers.has(p))) continue;
      this.#preempted.add(active.runId);
      active.controller.abort(new ProviderError('cancelled', engineText('ja', 'run.preempted'), { retryable: false }));
    }
  }

  stop(runId: string): boolean {
    const active = this.#active.get(runId);
    if (!active) return false;
    active.controller.abort(providerError('cancelled', 'cancelled', {}, { retryable: false }));
    return true;
  }

  stopAll(): void { for (const runId of this.#active.keys()) this.stop(runId); }

  wait(runId: string): Promise<EngineResult> | undefined { return this.#active.get(runId)?.done; }
  get chatting(): boolean { return [...this.#active.values()].some(a => a.kind === 'chat'); }
  activeRuns(): Array<{ runId: string; conversationId: string; kind: RunKind }> {
    return [...this.#active.values()].map(a => ({ runId: a.runId, conversationId: a.conversationId, kind: a.kind }));
  }

  #chain(route: 'chat' | 'background'): { usable: Route[]; problems: ModelProblem[] } {
    const config = this.#d.config();
    const language = languageOf(config);
    const ids = candidateModelIds(config, route);
    const usable: Route[] = [];
    const cooling: Route[] = [];
    const problems: ModelProblem[] = [];
    for (const id of ids) {
      const model = config.models.find(m => m.id === id);
      const provider = model && config.providers.find(p => p.id === model.provider);
      if (!model || !provider) { problems.push({ modelId: id, status: 'error', message: engineText(language, 'problem.not_in_config'), messageCode: 'engine.problem.not_in_config' }); continue; }
      const probe = this.#d.status.get(id);
      if (probe?.status === 'ok') (this.#d.status.coolingDown(id, this.#d.now?.().getTime()) ? cooling : usable).push({ model, provider });
      else problems.push({
        modelId: id, status: probe?.status ?? 'unknown', message: probe?.message ?? engineText(language, 'problem.unchecked'), hint: probe?.hint,
        ...(probe ? (probe.messageCode ? { messageCode: probe.messageCode, ...(probe.messageParams ? { messageParams: probe.messageParams } : {}) } : {}) : { messageCode: 'engine.problem.unchecked' }),
      });
    }
    return { usable: [...usable, ...cooling], problems };
  }

  #noUsableModel(problems: ModelProblem[]): SendOutcome {
    const contextProblem = problems.find(p => p.status === 'too_small' || p.status === 'exceeds_model' || p.status === 'unknown');
    const language = languageOf(this.#d.config());
    const lines = problems.map(p => engineText(language, 'problem.line', { id: p.modelId, message: p.message, hintPart: p.hint ? engineText(language, 'problem.hint_suffix', { hint: p.hint }) : '' }));
    return {
      ok: false, httpStatus: 409,
      errorKind: contextProblem ? 'context_overflow' : 'provider_error',
      errorMessage: engineText(language, 'no_usable', { lines: lines.join('\n') || engineText(language, 'problem.none') }),
      errorCode: 'engine.no_usable',
      ...(contextProblem ? { detail: { reason: contextProblem.status === 'unknown' ? 'context_unknown' : contextProblem.status === 'exceeds_model' ? 'exceeds_model_limit' : 'server_ctx_too_small', ...(contextProblem.hint ? { hint: contextProblem.hint } : {}) } } : {}),
      problems,
    };
  }

  #start(runId: string, conversationId: string, chain: Route[], kind: RunKind, task?: { task: Task; control: { value: TaskControl } }): void {
    const controller = new AbortController();
    this.#byConversation.set(conversationId, runId);
    const done = this.#execute(runId, conversationId, chain, controller.signal, kind, task)
      .catch((error): EngineResult => {
        this.#d.log?.(`[ERROR] run ${runId}: ${(error as Error).stack ?? error}`);
        this.#d.runs.finish(runId, { ok: false, attempts: 0, errorKind: 'internal', errorMessage: (error as Error).message });
        const language = languageOf(this.#d.config());
        const internal = engineText(language, 'run.internal', { detail: (error as Error).message });
        this.#d.bus.publish({ type: 'run.end', runId, conversationId, ok: false, errorKind: 'internal', errorMessage: internal, errorCode: 'engine.run.internal', errorParams: { detail: (error as Error).message } });
        return { ok: false, runId, text: '', errorKind: 'internal', errorMessage: internal, errorCode: 'engine.run.internal', errorParams: { detail: (error as Error).message }, retryable: false };
      })
      .finally(() => {
        this.#active.delete(runId);
        this.#byConversation.delete(conversationId);
        setTimeout(() => this.#preempted.delete(runId), 60_000).unref?.();
        try { this.onRunEnd?.({ runId, conversationId, kind }); } catch (error) { this.#d.log?.(`[ERROR] onRunEnd: ${(error as Error).message}`); }
      });
    this.#active.set(runId, { runId, conversationId, kind, providers: new Set(chain.map(r => r.provider.id)), controller, done });
  }

  #toolsFor(model: ModelConfig, kind: RunKind): ToolDef[] {
    if (!this.#d.tools || model.maxTools === 0) return [];
    return this.#d.tools.registry.forRun(kind, { limit: model.maxTools, ...(kind === 'review' ? { exclude: t => REVIEW_FORBIDDEN.has(t.effect) } : {}) });
  }

  async #execute(runId: string, conversationId: string, chain: Route[], signal: AbortSignal, kind: RunKind, task?: { task: Task; control: { value: TaskControl } }): Promise<EngineResult> {
    const d = this.#d;
    const config = d.config();
    d.runs.start(runId, kind, conversationId);
    const snapshot = this.#snapshot(conversationId);
    d.bus.publish({ type: 'run.start', runId, conversationId, modelId: chain[0]!.model.id });
    const flags: string[] = [];
    const usage: Usage = {};
    const counters = { attempts: 0, iterations: 0, toolCalls: 0 };
    let index = 0;
    let invalidStreak = 0;
    let lastEstimate = 0;
    let lastRoute: Route = chain[0]!;
    const policy = buildPolicy(config, d.paths);
    // 道具が書き込む「どう終えるか」の印は、ワーカーが読む control.value と同じ入れ物にする
    const taskSlot = task ? { id: task.task.id, get control() { return task.control.value; }, set control(v: TaskControl) { task.control.value = v; } } : undefined;
    const ctx: ToolContext = {
      runId, conversationId, kind, signal, config, paths: d.paths, policy, workspace: defaultWorkspace(policy, d.paths),
      taint: (() => { const sources = this.#initialTaint.get(runId) ?? []; this.#initialTaint.delete(runId); return { tainted: sources.length > 0, sources }; })(),
      log: d.log ?? (() => undefined),
      services: d.memory ? { db: d.conversations.db, memory: d.memory, tasks: d.tasks, curiosity: d.curiosity, skills: d.skills, web: d.web, emit: e => d.bus.publish(e) } : undefined,
      task: taskSlot,
    };
    const addUsage = (u: Usage) => {
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
        if (typeof u[key] === 'number') usage[key] = (usage[key] ?? 0) + u[key]!;
      }
    };
    let replyLanguage: Language | undefined;
    const finishOk = (text: string, stop: StopReason): EngineResult => {
      if (replyLanguage && this.#lastReplyLanguage(conversationId) !== replyLanguage) d.kv.set(replyLanguageKey(conversationId), replyLanguage);
      d.runs.finish(runId, { ok: true, modelId: lastRoute.model.id, providerId: lastRoute.provider.id, model: lastRoute.model.model, attempts: counters.attempts, stop, iterations: counters.iterations, toolCalls: counters.toolCalls, usage, estPromptTokens: lastEstimate, flags });
      d.bus.publish({ type: 'run.end', runId, conversationId, ok: true });
      return { ok: true, runId, text, modelId: lastRoute.model.id, usage, stop };
    };
    const finishFail = (f: Failure): EngineResult => {
      const route = f.route ?? lastRoute;
      d.runs.finish(runId, { ok: false, attempts: counters.attempts, errorKind: f.kind, errorMessage: f.message, flags, iterations: counters.iterations, toolCalls: counters.toolCalls, usage, modelId: route.model.id, model: route.model.model, providerId: route.provider.id });
      d.bus.publish({ type: 'run.end', runId, conversationId, ok: false, errorKind: f.kind, errorMessage: f.message, ...(f.code ? { errorCode: f.code, errorParams: f.params ?? {} } : {}), ...(f.detail ? { detail: f.detail } : {}) });
      return { ok: false, runId, text: '', errorKind: f.kind, errorMessage: f.message, ...(f.code ? { errorCode: f.code, errorParams: f.params ?? {} } : {}), retryable: f.retryable, ...(f.detail ? { detail: f.detail } : {}) };
    };

    const maxIterations = config.tools.maxIterations;
    const compaction = { done: false };
    for (counters.iterations = 1; counters.iterations <= maxIterations; counters.iterations++) {
      const call = await this.#callModel({ runId, conversationId, chain, start: index, snapshot, signal, counters, flags, compaction, kind });
      if (!call.ok) {
        if (call.cancelled) return this.#finishCancelled(runId, conversationId, counters, call.route ?? lastRoute, call.partial);
        return finishFail(call.failure);
      }
      index = call.index;
      lastRoute = chain[index]!;
      lastEstimate = call.estimate;
      addUsage(call.usage);
      // 考える部分を別に返すモデル（Qwen3 など）は、答えの頭に空行が付く。保存する前に落とす
      call.text = call.text.replace(/^\s+/u, '');

      replyLanguage = call.language;
      const saved = d.conversations.append(conversationId, { role: 'assistant', content: call.text, ...(call.toolCalls.length ? { toolCalls: call.toolCalls } : {}) }, runId);
      d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'assistant' });
      if (!call.toolCalls.length) return finishOk(call.text, call.stop);
      if (!d.tools) return finishOk(call.text, call.stop);

      let invalidThisRound = 0;
      for (const toolCall of call.toolCalls) {
        if (signal.aborted) return this.#finishCancelled(runId, conversationId, counters, lastRoute, '');
        counters.toolCalls++;
        const outcome = await runToolCall(toolCall, ctx, { registry: d.tools.registry, approvals: d.tools.approvals, db: d.conversations.db, emit: e => d.bus.publish(e) });
        if (outcome.invalidArguments) invalidThisRound++;
        const toolSaved = d.conversations.append(conversationId, {
          role: 'tool', toolCallId: toolCall.id, name: toolCall.name, content: outcome.output.content, ...(outcome.output.isError ? { isError: true } : {}),
        }, runId);
        d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: toolSaved.id, role: 'tool' });
      }
      if (signal.aborted) return this.#finishCancelled(runId, conversationId, counters, lastRoute, '');
      // タスクの終え方（完了・途中経過・質問）が決まったら、モデルを呼び直さずに終える
      if (task && task.control.value.outcome !== 'none') return finishOk(call.text, 'end_turn');
      invalidStreak = invalidThisRound === call.toolCalls.length ? invalidStreak + 1 : 0;
      if (invalidStreak >= MAX_INVALID_STREAK) {
        const language = languageOf(config);
        return finishFail({ kind: 'provider_error', message: engineText(language, 'tool.invalid_streak', { count: MAX_INVALID_STREAK }), code: 'engine.tool.invalid_streak', params: { count: MAX_INVALID_STREAK }, retryable: false, detail: { reason: 'prompt_exceeds', hint: engineText(language, 'tool.invalid_streak_hint') } });
      }
    }
    flags.push('max_iterations');
    d.bus.publish({ type: 'warning', runId, conversationId, code: 'max_iterations', message: engineText(languageOf(config), 'warn.max_iterations', { max: maxIterations }), params: { max: maxIterations } });
    return finishOk('', 'other');
  }

  async #callModel(p: { runId: string; conversationId: string; chain: Route[]; start: number; snapshot: string; signal: AbortSignal; counters: { attempts: number }; flags: string[]; compaction: { done: boolean }; kind: RunKind }): Promise<CallResult> {
    const d = this.#d;
    const sleep = d.sleep ?? abortableSleep;
    const retries = d.retriesPerModel ?? d.config().routing.retriesPerModel;
    const language = languageOf(d.config());
    let last: Failure = { kind: 'internal', message: engineText(language, 'run.no_model'), code: 'engine.run.no_model', retryable: false };
    for (let index = p.start; index < p.chain.length; index++) {
      const route = p.chain[index]!;
      const { model, provider } = route;
      if (index > p.start) {
        d.bus.publish({ type: 'model.switch', runId: p.runId, conversationId: p.conversationId, from: p.chain[index - 1]!.model.id, to: model.id, reason: last.message });
        d.log?.(`[WARN] model ${p.chain[index - 1]!.model.id} が使えなかったため ${model.id} に切り替えます: ${last.message.split('\n')[0]}`);
      }
      const adapter = d.registry.get(provider.id);
      if (!adapter) { last = { kind: 'internal', message: engineText(language, 'run.no_provider', { id: provider.id }), code: 'engine.run.no_provider', params: { id: provider.id }, retryable: false, route }; continue; }
      const toolDefs = this.#toolsFor(model, p.kind);
      const specs = ToolRegistry.specs(toolDefs);
      const fallbackMode = model.toolMode === 'json_fallback';
      const toolNames = new Set(toolDefs.map(t => t.name));

      for (let attempt = 0; attempt <= retries; attempt++) {
        if (p.signal.aborted) return { ok: false, cancelled: true, partial: '', failure: last, route };
        p.counters.attempts++;
        const capacity = d.status.get(model.id)?.effective ?? model.contextLength ?? 0;
        const available = Math.floor(capacity * CONTEXT_FILL_RATIO) - model.maxOutputTokens;
        const conversation = d.conversations.get(p.conversationId);
        const upto = conversation?.summary_upto ?? 0;
        const stored = d.conversations.messages(p.conversationId).filter(m => m.id > upto);
        const config = d.config();
        const summary = summarySection(conversation?.summary ?? '', language);
        const dynamic = [buildDynamic(config.timezone, language, d.now?.() ?? new Date()), summary, fallbackMode ? jsonFallbackInstructions(specs, language) : ''].filter(Boolean).join('\n\n');
        const system = { frozen: p.snapshot, dynamic };
        let history = stored.map(m => m.message);
        if (fallbackMode) history = toJsonFallbackHistory(history, language);
        if (this.#frozenLanguage(p.conversationId) !== language || this.#lastReplyLanguage(p.conversationId) !== language) history = withReplyReminder(history, language);
        const apiTools = fallbackMode ? [] : specs;
        const factor = d.kv.getJson<number>(`calibration:${model.id}`) ?? 1;
        let fitted;
        try {
          fitted = fitMessages({ system: `${system.frozen}\n${system.dynamic}`, messages: history, tools: apiTools, available, factor });
        } catch (error) {
          if (!(error instanceof ContextOverflow)) throw error;
          last = { kind: 'context_overflow', message: engineText(language, 'fit.overflow', { required: error.required.toLocaleString('en-US'), available: error.available.toLocaleString('en-US') }), code: 'engine.fit.overflow', params: { required: error.required, available: error.available }, retryable: false, route,
            detail: { reason: 'prompt_exceeds', measured: available, required: error.required, hint: engineText(language, 'hint.prompt_exceeds') } };
          break;
        }
        // 外す発言が多ければ、外す部分を要約してから組み立て直す（1回の実行で1回まで。要約に失敗したら外すだけにする）
        if (fitted.removed >= COMPACT_MIN_MESSAGES && !fallbackMode && !p.compaction.done) {
          p.compaction.done = true;
          const ok = await this.#compact({ route, adapter, runId: p.runId, conversationId: p.conversationId, removed: stored.slice(0, fitted.removed), previous: conversation?.summary ?? null, capacity, signal: p.signal });
          if (ok) { if (!p.flags.includes('compacted')) p.flags.push('compacted'); attempt--; continue; }
        }
        if (fitted.removed > 0) {
          d.bus.publish({ type: 'warning', runId: p.runId, conversationId: p.conversationId, code: 'context_trimmed', message: engineText(language, 'warn.context_trimmed', { count: fitted.removed }), params: { count: fitted.removed } });
          if (!p.flags.includes('context_trimmed')) p.flags.push('context_trimmed');
        }

        let text = '';
        let usage: Usage = {};
        let stop: StopReason = 'other';
        const toolCalls: ToolCall[] = [];
        let release: (() => void) | undefined;
        try {
          release = await d.limiter.acquire(provider.id, () => provider.maxParallel, p.signal);
          for await (const event of adapter.stream({ model, system, messages: fitted.messages, tools: apiTools, maxOutputTokens: model.maxOutputTokens, signal: p.signal })) {
            if (event.type === 'text') { text += event.delta; d.bus.publish({ type: 'text.delta', runId: p.runId, conversationId: p.conversationId, text: event.delta }); }
            else if (event.type === 'usage') usage = { ...usage, ...event.usage };
            else if (event.type === 'tool_call') toolCalls.push(event.call);
            else if (event.type === 'done') stop = event.stop;
          }
        } catch (error) {
          const e = error instanceof ProviderError ? error
            : p.signal.aborted ? providerError('cancelled', 'cancelled', {}, { retryable: false })
            : providerError('internal', 'unexpected', { detail: (error as Error).message }, { retryable: false });
          if (e.kind === 'cancelled' || p.signal.aborted) return { ok: false, cancelled: true, partial: text, failure: last, route };
          last = { kind: e.kind, message: e.text(language), ...(e.code ? { code: `provider.${e.code}`, params: e.params } : {}), retryable: e.retryable, route, ...(e.detail ? { detail: e.detail } : {}) };
          if (text) {
            d.bus.publish({ type: 'warning', runId: p.runId, conversationId: p.conversationId, code: 'partial_discarded', message: engineText(language, 'warn.partial_discarded') });
            break;
          }
          if (e.retryable && attempt < retries) {
            const wait = Math.min(e.retryAfterMs ?? 1000 * 2 ** attempt, MAX_BACKOFF_MS);
            d.bus.publish({ type: 'warning', runId: p.runId, conversationId: p.conversationId, code: 'retrying', message: engineText(language, 'warn.retrying', { message: e.text(language), seconds: Math.ceil(wait / 1000), attempt: attempt + 1, retries }), params: { seconds: Math.ceil(wait / 1000), attempt: attempt + 1, retries, ...(e.code ? { errorCode: `provider.${e.code}`, errorParams: e.params } : { detail: e.message }) } });
            try { await sleep(wait, p.signal); } catch { return { ok: false, cancelled: true, partial: '', failure: last, route }; }
            continue;
          }
          break;
        } finally { release?.(); }

        // 本文に書かれたツール呼び出しを拾う（ツール非対応のモデル、または tool_calls を使わずに本文に書いたモデル）
        if (!toolCalls.length && toolNames.size && (fallbackMode || looksLikeTextToolCall(text))) {
          const parsed = extractToolCalls(text, toolNames);
          if (parsed.calls.length) {
            toolCalls.push(...(fallbackMode ? parsed.calls.slice(0, 1) : parsed.calls));
            text = parsed.text;
            if (!p.flags.includes('text_tool_calls')) p.flags.push('text_tool_calls');
          }
        }
        this.#checkTruncation(p.runId, p.conversationId, model, fitted.estimate, usage, capacity, p.flags);
        return { ok: true, index, text, toolCalls, usage, stop: toolCalls.length ? 'tool_use' : stop, estimate: fitted.estimate.tokens, language };
      }
    }
    return { ok: false, cancelled: false, partial: '', failure: last };
  }

  #finishCancelled(runId: string, conversationId: string, counters: { attempts: number; iterations: number; toolCalls: number }, route: Route, partial: string): EngineResult {
    const d = this.#d;
    const language = languageOf(d.config());
    if (partial.trim()) {
      const saved = d.conversations.append(conversationId, { role: 'assistant', content: `${partial}\n\n${engineText(language, 'message.stopped_partway')}` }, runId);
      d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'assistant' });
    }
    d.runs.finish(runId, { ok: false, attempts: counters.attempts, iterations: counters.iterations, toolCalls: counters.toolCalls, errorKind: 'cancelled', errorMessage: providerText(language, 'cancelled'), modelId: route.model.id, providerId: route.provider.id, model: route.model.model });
    d.bus.publish({ type: 'run.end', runId, conversationId, ok: false, errorKind: 'cancelled', errorMessage: providerText(language, 'cancelled'), errorCode: 'provider.cancelled' });
    return { ok: false, runId, text: '', errorKind: 'cancelled', errorMessage: providerText(language, 'cancelled'), errorCode: 'provider.cancelled', retryable: false };
  }

  async #compact(c: { route: Route; adapter: ProviderAdapter; runId: string; conversationId: string; removed: StoredMessage[]; previous: string | null; capacity: number; signal: AbortSignal }): Promise<boolean> {
    const d = this.#d;
    const language = languageOf(d.config());
    const transcript = c.removed.map(m => `${compactSpeaker(m.message, language)}: ${m.text.slice(0, 1500)}`).join('\n').slice(-COMPACT_TRANSCRIPT_CHARS);
    const prompt = compactPrompt({ previous: c.previous, transcript }, language);
    const maxOutputTokens = Math.min(2000, c.route.model.maxOutputTokens);
    if (estimateTextTokens(prompt) * 1.15 + maxOutputTokens > c.capacity * CONTEXT_FILL_RATIO) return false;
    let release: (() => void) | undefined;
    try {
      release = await d.limiter.acquire(c.route.provider.id, () => c.route.provider.maxParallel, c.signal);
      let text = '';
      for await (const event of c.adapter.stream({
        model: c.route.model, system: { frozen: compactSystem(language), dynamic: '' },
        messages: [{ role: 'user', content: prompt }], tools: [], maxOutputTokens, signal: c.signal,
      })) if (event.type === 'text') text += event.delta;
      if (!text.trim()) return false;
      d.conversations.setSummary(c.conversationId, text.trim(), c.removed.at(-1)!.id);
      d.bus.publish({ type: 'compaction', runId: c.runId, conversationId: c.conversationId, summarized: c.removed.length });
      d.bus.publish({ type: 'warning', runId: c.runId, conversationId: c.conversationId, code: 'compacted', message: engineText(language, 'warn.compacted', { count: c.removed.length }), params: { count: c.removed.length } });
      return true;
    } catch {
      if (c.signal.aborted) return false;
      d.bus.publish({ type: 'warning', runId: c.runId, conversationId: c.conversationId, code: 'compaction_failed', message: engineText(language, 'warn.compaction_failed') });
      return false;
    } finally { release?.(); }
  }

  #frozenLanguage(conversationId: string): Language {
    return LANGUAGES.find(l => l === this.#d.kv.get(snapshotLanguageKey(conversationId))) ?? DEFAULT_LANGUAGE;
  }

  #lastReplyLanguage(conversationId: string): Language {
    return LANGUAGES.find(l => l === this.#d.kv.get(replyLanguageKey(conversationId))) ?? this.#frozenLanguage(conversationId);
  }

  #snapshot(conversationId: string): string {
    const d = this.#d;
    const existing = d.conversations.get(conversationId)?.snapshot;
    if (existing) return existing;
    recordFileVersions(d.conversations.db, d.paths);
    const language = languageOf(d.config());
    const snapshot = buildSnapshot(d.paths, {
      ...(d.memory ? { memories: renderBooks(d.memory.list(), language) } : {}),
      ...(d.skills ? { skills: d.skills.index(language) } : {}),
    }, language);
    if (d.conversations.setSnapshotOnce(conversationId, snapshot.text, snapshot.hash)) d.kv.set(snapshotLanguageKey(conversationId), language);
    return d.conversations.get(conversationId)?.snapshot ?? snapshot.text;
  }

  #checkTruncation(runId: string, conversationId: string, model: ModelConfig, estimate: { raw: number; tokens: number }, usage: Usage, capacity: number, flags: string[]): void {
    const d = this.#d;
    const actual = usage.inputTokens;
    if (typeof actual !== 'number' || actual <= 0) return;
    const key = `truncation:${model.id}`;
    if (estimate.tokens > TRUNCATION_MIN_ESTIMATE && actual < estimate.tokens * TRUNCATION_RATIO) {
      const strikes = (d.kv.getJson<number>(key) ?? 0) + 1;
      d.kv.setJson(key, strikes);
      if (!flags.includes('server_truncation_suspected')) flags.push('server_truncation_suspected');
      const language = languageOf(d.config());
      const params = { actual: actual.toLocaleString('en-US'), estimate: estimate.tokens.toLocaleString('en-US') };
      const message = engineText(language, 'warn.server_truncation', params);
      d.bus.publish({ type: 'warning', runId, conversationId, code: 'server_truncation_suspected', message, params });
      if (strikes >= TRUNCATION_STRIKES) {
        d.status.disable(model.id, engineText(language, 'truncation.disable', { message, strikes }));
      }
      return;
    }
    d.kv.delete(key);
    // 切り捨てが起こりえない範囲（容量の半分未満）でだけ、実測との比を学習する
    if (capacity > 0 && estimate.tokens < capacity * 0.5 && estimate.raw > 200) {
      const ratio = Math.min(2, Math.max(0.5, actual / estimate.raw));
      const previous = d.kv.getJson<number>(`calibration:${model.id}`) ?? 1;
      d.kv.setJson(`calibration:${model.id}`, Number((previous * (1 - CALIBRATION_ALPHA) + ratio * CALIBRATION_ALPHA).toFixed(4)));
    }
  }
}
