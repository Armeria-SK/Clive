import { randomUUID } from 'node:crypto';
import { DEFAULT_LANGUAGE, LANGUAGES, type AppConfig, type Language, type ModelConfig, type ProviderConfig } from '../config/schema.ts';
import type { Conversations, StoredMessage } from '../db/conversations.ts';
import type { KV } from '../db/kv.ts';
import type { Runs } from '../db/runs.ts';
import type { AppPaths } from '../paths.ts';
import { redactSecrets } from '../shared/redaction.ts';
import type { PermissionMode } from '../shared/permission-mode.ts';
import type { EndpointLimiter } from '../providers/limiter.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { ProviderError, providerError, type ProviderAdapter } from '../providers/types.ts';
import { renderBooks, type MemoryStore } from '../memory/store.ts';
import type { ApprovalBroker } from '../tools/approvals.ts';
import { USER_REQUEST_LIMIT, type ClassifierPrompt } from '../tools/auto-approve.ts';
import { PLAN_EFFECTS, REVIEW_FORBIDDEN, runToolCall, TOOL_OUTPUT_LIMIT } from '../tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../tools/policy.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { effectivePolicy } from '../tools/tool-policy.ts';
import { stricterMode } from '../shared/permission-mode.ts';
import type { RunKind, TaskControl, ToolContext, ToolDef } from '../tools/types.ts';
import type { CuriosityStore } from '../curiosity/store.ts';
import type { SkillStore } from '../tools/skills/store.ts';
import type { Task, TaskStore } from '../tasks/store.ts';
import type { RunBus } from './bus.ts';
import { CONTEXT_FILL_RATIO, MEMORY_BUDGET_RATIO, PERSONA_BUDGET_RATIO, contextAvailable, toolOutputLimit } from './context-budget.ts';
import { modelEfforts } from './efforts.ts';
import { ContextOverflow, fitMessages } from './fit.ts';
import { isLocalModel, isLocalPinned, isLocalProvider } from './local-model.ts';
import type { ModelStatus } from './status.ts';
import { extractToolCalls, jsonFallbackInstructions, looksLikeTextToolCall, toJsonFallbackHistory } from './toolcall-parse.ts';
import type { AttachmentMeta, ChatMessage, ContextDetail, EngineErrorKind, EngineResult, ImageRef, StopReason, ToolCall, Usage } from './types.ts';
import { estimateRequest, estimateTextTokens } from './tokens.ts';
import { languageOf } from '../shared/language.ts';
import { providerText } from '../shared/messages/providers.ts';
import { engineText, type EngineMessageKey } from '../shared/messages/engine.ts';
import type { MessageParams } from '../shared/messages/define.ts';
import { compactPrompt, compactSpeaker, compactSystem, nextStepOf, replyLanguageKey, snapshotLanguageKey, summarySection, withReplyReminder, wrapUpPrompt, wrapUpSystem } from './prompts.ts';
import { buildDynamic, buildSnapshot, recordFileVersions } from './workspace.ts';
import { stripAttachments } from '../uploads/store.ts';

export { CONTEXT_FILL_RATIO, MEMORY_BUDGET_RATIO, contextAvailable };
export const TRUNCATION_RATIO = 0.6;
const TRUNCATION_MIN_ESTIMATE = 2048;
const TRUNCATION_STRIKES = 2;
const CALIBRATION_ALPHA = 0.3;
const MAX_BACKOFF_MS = 30_000;
const MAX_INVALID_STREAK = 3;
const UNATTENDED_ITERATION_CEILING = 100;

export function iterationLimit(configured: number, kind: RunKind): number {
  if (configured > 0) return configured;
  return kind === 'chat' ? Infinity : UNATTENDED_ITERATION_CEILING;
}
const COMPACT_MIN_MESSAGES = 4;
// 1 回の実行で要約を重ねられる回数。外す発言が増えるたびに要約し直すが、無限には繰り返さない
const MAX_COMPACTIONS_PER_RUN = 5;
// 1 つの会話で、実行中に待たせておける発言の数
const MAX_PENDING_MESSAGES = 10;
const COMPACT_TRANSCRIPT_CHARS = 60_000;
// 実行を始めるとき、添付の有無を見るために読み戻す発言の数（最後の返事がこの中に無ければ、確かめきれないので承認制の側に倒す）
const TAINT_SCAN_LIMIT = 500;

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
  notify?: NonNullable<ToolContext['services']>['notify'];
  log?: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  retriesPerModel?: number;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const ATTACHMENT_PLACEHOLDER = new RegExp(`^(?:${(['ja', 'en'] as const).flatMap(l => [engineText(l, 'attachment.image'), engineText(l, 'attachment.file')]).map(escapeRegExp).join('|')})$`, 'u');

// messageCode / messageParams は、モデルの確認（probe）の messageCode / messageParams と同じ（確認していない・設定に無いときは engine.problem.*）。画面が自分の言語で組み立てられるように添える。
export interface ModelProblem { modelId: string; status: string; message: string; hint?: string | undefined; messageCode?: string | undefined; messageParams?: MessageParams | undefined }

// 送信と一緒に渡す、会話で選ぶモデルと考える深さ・権限モード。渡さなかったものは会話に覚えているもの。モデルと考える深さの null は自動・モデルの既定
export interface SendChoice { modelId?: string | null | undefined; effort?: string | null | undefined; permissionMode?: PermissionMode | undefined }
const hasChoice = (choice: SendChoice): boolean => choice.modelId !== undefined || choice.effort !== undefined || choice.permissionMode !== undefined;

export type SendOutcome =
  // queued: 実行中だったので待たせた（runId は今の実行。差し込まれる前なら pendingId で取り消せる）
  | { ok: true; runId: string; messageId?: number; queued?: boolean; pendingId?: string }
  | { ok: false; httpStatus: number; errorKind: EngineErrorKind | 'busy' | 'not_found'; errorMessage: string; errorCode?: string; errorParams?: MessageParams; detail?: ContextDetail; problems?: ModelProblem[] };

type Route = { model: ModelConfig; provider: ProviderConfig };

interface ChatItem { content: string; images: ImageRef[]; attachments: AttachmentMeta[] }
// held: 実行が始まったあとに会話のモデルが替わり、そのあとに送られた発言。今の実行（古いモデルの鎖）へは差し込まず、実行が終わってから新しいモデルの実行で読ませる
// afterStop: 今の実行を止めたあとに送られた発言。止めた実行が終わるのを待って、新しい実行を始める（止める前に待たせた発言は、保存だけ）
interface PendingMessage extends ChatItem { id: string; interrupt: boolean; createdAt: number; held: boolean; afterStop: boolean }

export type ContextUsageOutcome =
  | { ok: true; modelId: string; tokens: number; available: number; capacity: number; ratio: number }
  | (Extract<SendOutcome, { ok: false }> & { errorParams?: MessageParams });

// 会話（チャット）や裏の作業が、どのモデルを順に試すか。順番が空なら設定のモデル全部（モデルが 0 個なら空）。
// 送信の画像の可否の確かめも、これを使う（エンジンと確かめの候補を食い違わせない）。
export function candidateModelIds(config: AppConfig, route: 'chat' | 'background'): string[] {
  const preferred = route === 'background' && config.routing.background.length ? config.routing.background : config.routing.chat;
  return preferred.length ? [...preferred] : config.models.map(m => m.id);
}

// 1 回の実行の要約の状態: 要約した回数・失敗したか（失敗したら外すだけ）・要約した発言の合計・「外しました」で最後に知らせた件数
interface CompactionState { count: number; failed: boolean; summarized: number; trimmedShown: number }

type Failure = { kind: EngineErrorKind; message: string; code?: string; params?: MessageParams; retryable: boolean; detail?: ContextDetail; route?: Route; upstream?: string };

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

interface Active { runId: string; conversationId: string; kind: RunKind; taskId?: string; providers: Set<string>; controller: AbortController; done: Promise<EngineResult> }

export class ChatEngine {
  readonly #d: ChatEngineDeps;
  #active = new Map<string, Active>();
  #byConversation = new Map<string, string>();
  #preempted = new Set<string>();
  // 会話の実行が止めたタスク（会話の実行が終わるとき、会話で進んだ分をこのタスクに引き継ぐ）
  #preemptedTasks = new Map<string, string[]>();
  #initialTaint = new Map<string, string[]>();
  // 会話のチャットの実行が始まったときに選ばれていたモデル（null は自動）。待たせる発言が、そのあとのモデルの変更より後かを見分けるのに使う
  #runModel = new Map<string, string | null>();
  // 会話のチャットの実行が始まったときの権限モード。待たせる発言が、そのあとのモードの変更より後かを見分けるのに使う（モデルと同じ決まり）
  #runMode = new Map<string, PermissionMode>();
  // 止める操作（stop）を受けた実行
  #stopped = new Set<string>();
  // 実行中に送られて、まだ履歴に入っていない発言（会話ごと。再起動で消える）
  #pending = new Map<string, PendingMessage[]>();
  lastUserActivity = 0;
  onRunEnd: ((run: { runId: string; conversationId: string; kind: RunKind }) => void) | undefined;

  constructor(deps: ChatEngineDeps) { this.#d = deps; }

  #busy(key: EngineMessageKey): SendOutcome {
    return { ok: false, httpStatus: 409, errorKind: 'busy', errorMessage: engineText(languageOf(this.#d.config()), key), errorCode: `engine.${key}` };
  }

  // 実行中の会話に送った発言は、新しい実行にせず待たせる（待ちの発言）。今の実行が次の区切り（道具の結果を返して、次にモデルを呼ぶ前）に来たら
  // 履歴に入れ、実行が先に終わったら、その発言で新しい実行を始める。interrupt なら、今の実行を止めて、待っていた発言と一緒に新しい実行を始める
  send(conversationId: string, text: string, images: ImageRef[] = [], attachments: AttachmentMeta[] = [], choice: SendChoice = {}, options: { interrupt?: boolean } = {}): SendOutcome {
    const item: ChatItem = { content: text, images, attachments };
    const running = this.#byConversation.get(conversationId);
    if (running === undefined) return this.#beginChat(conversationId, [item], choice);
    if (this.#active.get(running)?.kind !== 'chat') return this.#busy('send.busy_chat');
    const queue = this.#pending.get(conversationId) ?? [];
    if (queue.length >= MAX_PENDING_MESSAGES) {
      return { ok: false, httpStatus: 409, errorKind: 'busy', errorMessage: engineText(languageOf(this.#d.config()), 'send.queue_full', { max: MAX_PENDING_MESSAGES }), errorCode: 'engine.send.queue_full', errorParams: { max: MAX_PENDING_MESSAGES } };
    }
    this.lastUserActivity = this.#d.now?.().getTime() ?? Date.now();
    // 選んだモデルと考える深さは、次の実行から効く（今の実行の鎖は変えない）。権限モードは、厳しくなる向きはその場から、緩む向きは次の実行から効く（pipeline.ts）
    if (hasChoice(choice)) this.#d.conversations.setChoice(conversationId, choice);
    // 実行が始まってから会話のモデルや権限モードが替わっていたら（PATCH でも、この送信の modelId・permissionMode でも）、この発言は古いモデル・古いモードの実行に読ませない。
    // 一度保留した発言があれば、あとの発言も順番を守るため保留する
    const held = queue.some(p => p.held) || (this.#d.conversations.get(conversationId)?.model_id ?? null) !== (this.#runModel.get(running) ?? null)
      || this.#d.conversations.modeOf(conversationId) !== (this.#runMode.get(running) ?? 'normal');
    const pending: PendingMessage = { id: randomUUID(), ...item, interrupt: options.interrupt === true, createdAt: this.#d.now?.().getTime() ?? Date.now(), held, afterStop: this.#stopped.has(running) };
    this.#pending.set(conversationId, [...queue, pending]);
    this.#d.bus.publish({ type: 'pending.changed', conversationId });
    if (pending.interrupt) this.stop(running);
    return { ok: true, runId: running, queued: true, pendingId: pending.id };
  }

  // 待っている発言（画面に出す形）
  pending(conversationId: string): Array<{ id: string; text: string; attachments: AttachmentMeta[]; interrupt: boolean; createdAt: number }> {
    return (this.#pending.get(conversationId) ?? []).map(p => ({ id: p.id, text: stripAttachments(p.content), attachments: p.attachments, interrupt: p.interrupt, createdAt: p.createdAt }));
  }

  // 差し込まれる前の待ちの発言を取り消す。もう差し込まれた・無いときは false
  cancelPending(conversationId: string, pendingId: string): boolean {
    const queue = this.#pending.get(conversationId);
    if (!queue?.some(p => p.id === pendingId)) return false;
    const rest = queue.filter(p => p.id !== pendingId);
    if (rest.length) this.#pending.set(conversationId, rest); else this.#pending.delete(conversationId);
    this.#d.bus.publish({ type: 'pending.changed', conversationId });
    return true;
  }

  // 発言を保存して、チャットの実行を始める（1 つ以上の発言を順に保存し、1 つの実行で読ませる）。使えるモデルが無ければ、何も保存せずに断る
  #beginChat(conversationId: string, items: ChatItem[], choice: SendChoice): SendOutcome {
    const existing = this.#d.conversations.get(conversationId);
    const pinned = choice.modelId !== undefined ? choice.modelId : existing?.model_id ?? null;
    const effort = choice.effort !== undefined ? choice.effort : existing?.effort ?? null;
    const chain = this.#chain('chat', pinned);
    if (!chain.usable.length) return this.#noUsableModel(chain.problems);
    const preempted = this.#preemptFor(chain.usable);
    this.lastUserActivity = this.#d.now?.().getTime() ?? Date.now();
    // ユーザーが同じ id へ新しく送ったときは、消したばかりの会話の覚えを外す（動いていた実行の遅れた書き込みだけを見送るため）
    this.#d.conversations.reopen(conversationId);
    if (hasChoice(choice)) this.#d.conversations.setChoice(conversationId, choice);
    const runId = randomUUID();
    if (preempted.length) this.#preemptedTasks.set(runId, preempted);
    let firstId: number | undefined;
    for (const { content, images, attachments } of items) {
      const saved = this.#d.conversations.append(conversationId, { role: 'user', content, ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}) });
      firstId ??= saved.id;
      // 添付の中身はタイトルにしない（本文が無ければ添付の名前にする）
      this.#d.conversations.autoTitle(conversationId, attachments.length ? stripAttachments(content).replace(ATTACHMENT_PLACEHOLDER, '') || attachments[0]!.name : content);
      this.#d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    }
    this.#taintFromHistory(runId, conversationId);
    this.#start(runId, conversationId, chain.usable, 'chat', undefined, undefined, effort);
    return { ok: true, runId, messageId: firstId! };
  }

  // 外から読んだ内容が残ったまま始まる実行は、シェルと書き込みを承認制にする（taint）。次のどれかなら、始まる実行も「外から読んだ」扱いにする:
  // - 最後の返事（道具の呼び出しだけではない assistant の発言）より後のユーザーの発言に添付がある。今送った発言・保存だけになった待ちの発言・やり直す発言のどれでも数え、道具を呼んだ assistant の発言は返事ではないので、またいで見る
  // - 最後の返事を、読み出す発言の数（TAINT_SCAN_LIMIT）の中に見つけられない。添付の有無を確かめきれないので、承認制の側に倒す
  // - 前のチャットの実行が、外から読んだまま、最後まで返事を書かずに終わった（止めた・失敗・取り消し・道具の上限のまとめ）。Web を読んだ分もこれで持ち越す。やり直し・続きは、その実行のやり直し・続きとみなす
  #taintFromHistory(runId: string, conversationId: string): void {
    const language = languageOf(this.#d.config());
    const sources: string[] = [];
    const stored = this.#d.conversations.messages(conversationId, TAINT_SCAN_LIMIT);
    let replied = false;
    for (let i = stored.length - 1; i >= 0; i--) {
      const message = stored[i]!.message;
      if (message.role === 'assistant' && !message.toolCalls?.length) { replied = true; break; }
      if (message.role === 'user') sources.unshift(...(message.attachments ?? []).map(a => engineText(language, 'attachment.taint', { name: a.name })));
    }
    if (!replied && stored.length >= TAINT_SCAN_LIMIT) sources.push(engineText(language, 'taint.unknown'));
    if (this.#previousRunLeftTaint(conversationId)) sources.push(engineText(language, 'taint.carried'));
    if (sources.length) this.#initialTaint.set(runId, sources);
  }

  // 前のチャットの実行が、外から読んだ印を持ったまま、最後まで返事を書かずに終わったか。最後まで返事を書いて終わった実行（ok で、道具の上限のまとめではない）の印は持ち越さない
  #previousRunLeftTaint(conversationId: string): boolean {
    const last = this.#d.runs.latestChat(conversationId);
    if (!last || last.tainted !== 1) return false;
    let wrappedUp = true;
    try { wrappedUp = (JSON.parse(last.flags) as string[]).includes('max_iterations'); } catch { }
    return !(last.ok === 1 && !wrappedUp);
  }

  // 実行の区切りで、待っている発言を履歴に入れる（承認の札を待っているあいだは、実行が道具の呼び出しの中で待っているので、区切りに来ない。承認の答えが先）。
  // 添付つきの発言は外から来た文なので、この実行の残りも「外から読んだ」扱いにする。
  // 実行が始まったあとにモデルを替えて送られた発言（held）は入れない（古いモデルへ渡さない）。実行が終わってから新しい実行で読ませる
  #injectPending(runId: string, conversationId: string, ctx: ToolContext): void {
    const d = this.#d;
    const queue = this.#pending.get(conversationId);
    if (!queue?.length) return;
    const injectable = queue.filter(p => !p.held);
    if (!injectable.length) return;
    const held = queue.filter(p => p.held);
    if (held.length) this.#pending.set(conversationId, held); else this.#pending.delete(conversationId);
    const language = languageOf(d.config());
    for (const { content, images, attachments } of injectable) {
      const saved = d.conversations.append(conversationId, { role: 'user', content, ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}) }, runId);
      d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
      if (attachments.length) {
        ctx.taint.tainted = true;
        ctx.taint.sources.push(...attachments.map(a => engineText(language, 'attachment.taint', { name: a.name })));
      }
    }
    d.bus.publish({ type: 'pending.changed', conversationId });
  }

  // 実行が終わったとき、まだ待っている発言があれば: 実行が成功で終わった（または止めて送る）なら、その発言で新しい実行を始める。
  // 失敗・取り消しで終わったときは、発言を保存だけして（新しい実行は始めない）、そのことを知らせる
  #drainPending(conversationId: string, endedRunId: string, ended: EngineResult | undefined): void {
    const d = this.#d;
    const queue = this.#pending.get(conversationId);
    if (!queue?.length) return;
    this.#pending.delete(conversationId);
    // 成功で終わった（または止めて送る）なら、待っていた発言を全部まとめて新しい実行で読ませる。
    // 失敗・取り消しで終わったときは、新しい実行を求めた発言（モデルを替えたあと・止めたあとに送られたもの）だけが新しい実行を始め、ほかは保存だけにする
    const startAll = ended?.ok === true || queue.some(p => p.interrupt);
    const wantsRun = (p: PendingMessage) => p.held || p.afterStop;
    const starters = startAll ? queue : queue.filter(wantsRun);
    const saveOnly = startAll ? [] : queue.filter(p => !wantsRun(p));
    if (saveOnly.length) this.#saveQueued(conversationId, saveOnly, endedRunId, 'stopped');
    if (starters.length && !this.#beginChat(conversationId, starters, {}).ok) this.#saveQueued(conversationId, starters, endedRunId, 'not_started');
    d.bus.publish({ type: 'pending.changed', conversationId });
  }

  // 待っていた発言を、ふつうのユーザーの発言として保存だけする（新しい実行は始めない）。保存したことを警告で知らせる。
  // 理由: stopped = 返事が止まった（失敗・取り消し・終了）、not_started = 返事を始められなかった（使えるモデルが無い）
  #saveQueued(conversationId: string, messages: PendingMessage[], runId: string, reason: 'stopped' | 'not_started'): void {
    const d = this.#d;
    for (const { content, images, attachments } of messages) {
      const saved = d.conversations.append(conversationId, { role: 'user', content, ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}) });
      d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    }
    const language = languageOf(d.config());
    const [code, key] = reason === 'stopped' ? ['queued_saved', 'warn.queued_saved'] as const : ['queued_not_started', 'warn.queued_not_started'] as const;
    d.bus.publish({ type: 'warning', runId, conversationId, code, message: engineText(language, key, { count: messages.length }), params: { count: messages.length } });
  }

  // 終了するとき（DB を閉じる前に呼ぶ）、待たせている発言を全部、保存だけして残す。待ちはメモリの中だけなので、これをしないと再起動で消える
  saveQueued(): number {
    let count = 0;
    for (const [conversationId, queue] of [...this.#pending]) {
      this.#pending.delete(conversationId);
      this.#saveQueued(conversationId, queue, this.#byConversation.get(conversationId) ?? '', 'stopped');
      this.#d.bus.publish({ type: 'pending.changed', conversationId });
      count += queue.length;
    }
    return count;
  }

  retry(conversationId: string): SendOutcome {
    if (this.#byConversation.has(conversationId)) return this.#busy('send.busy');
    const last = this.#d.conversations.messages(conversationId, 1).at(-1);
    if (!last || last.role === 'assistant') return { ok: false, httpStatus: 409, errorKind: 'not_found', errorMessage: engineText(languageOf(this.#d.config()), 'send.nothing_to_retry'), errorCode: 'engine.send.nothing_to_retry' };
    const conversation = this.#d.conversations.get(conversationId);
    const chain = this.#chain('chat', conversation?.model_id ?? null);
    if (!chain.usable.length) return this.#noUsableModel(chain.problems);
    const preempted = this.#preemptFor(chain.usable);
    this.lastUserActivity = this.#d.now?.().getTime() ?? Date.now();
    const runId = randomUUID();
    if (preempted.length) this.#preemptedTasks.set(runId, preempted);
    this.#taintFromHistory(runId, conversationId);
    this.#start(runId, conversationId, chain.usable, 'chat', undefined, undefined, conversation?.effort ?? null);
    return { ok: true, runId };
  }

  // task.local_only: 手元のモデルを選んだ会話から作ったタスク。裏方の順番のうち手元のモデルだけで動かし、使えるものが無ければ（チャットの順番や外のモデルに回さず）始めない（localOnly: true で知らせる）
  runTask(task: Task, conversationId: string, prompt: string): { ok: true; runId: string; control: { value: TaskControl }; done: Promise<EngineResult> } | { ok: false; errorMessage: string; localOnly?: true } {
    if (this.#byConversation.has(conversationId)) return { ok: false, errorMessage: engineText(languageOf(this.#d.config()), 'send.task_running') };
    const localOnly = task.local_only === 1;
    const chain = this.#chain('background', null, localOnly);
    if (!chain.usable.length) {
      const outcome = this.#noUsableModel(chain.problems);
      return { ok: false, errorMessage: outcome.ok ? '' : outcome.errorMessage, ...(localOnly ? { localOnly: true as const } : {}) };
    }
    const saved = this.#d.conversations.append(conversationId, { role: 'user', content: prompt });
    const runId = randomUUID();
    this.#d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    const control = { value: { outcome: 'none' } as TaskControl };
    this.#start(runId, conversationId, chain.usable, 'task', { task, control });
    return { ok: true, runId, control, done: this.#active.get(runId)!.done };
  }

  // localOnly: 手元のモデルで話した会話の振り返り。裏方の順番のうち手元のモデルだけを使い、無ければ（チャットの順番や外のモデルに回さず）始めない
  runReview(conversationId: string, prompt: string, options: { forbidTools?: readonly string[]; localOnly?: boolean } = {}): { ok: true; runId: string; done: Promise<EngineResult> } | { ok: false; errorMessage: string } {
    if (this.#byConversation.has(conversationId)) return { ok: false, errorMessage: engineText(languageOf(this.#d.config()), 'send.review_running') };
    const chain = this.#chain('background', null, options.localOnly === true);
    if (!chain.usable.length) {
      const outcome = this.#noUsableModel(chain.problems);
      return { ok: false, errorMessage: outcome.ok ? '' : outcome.errorMessage };
    }
    const saved = this.#d.conversations.append(conversationId, { role: 'user', content: prompt });
    const runId = randomUUID();
    this.#d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    this.#start(runId, conversationId, chain.usable, 'review', undefined, options.forbidTools?.length ? new Set(options.forbidTools) : undefined);
    return { ok: true, runId, done: this.#active.get(runId)!.done };
  }

  wasPreempted(runId: string): boolean { return this.#preempted.has(runId); }

  // 手元のモデルで話した会話の振り返りに使える、手元の裏方モデルがあるか
  localReviewAvailable(): boolean { return this.#chain('background', null, true).usable.length > 0; }

  // 会話の最初に固定する system に入れる記憶の予算（トークン）。チャットと裏方で使える（確認が通った）モデルのうち、
  // 容量が分かるものの available のいちばん小さい値の 12%。容量が分かるモデルが無ければ undefined（予算なし = 全部入れる。0 にはしない）。
  memoryBudget(): number | undefined {
    const smallest = this.#smallestAvailable();
    return smallest === undefined ? undefined : Math.floor(smallest * MEMORY_BUDGET_RATIO);
  }

  // SOUL.md と USER.md（固定する system に入る）の大きさの目安。いちばん小さい使えるモデルの available の 10%（記憶の予算とは別）。
  personaBudget(): number | undefined {
    const smallest = this.#smallestAvailable();
    return smallest === undefined ? undefined : Math.floor(smallest * PERSONA_BUDGET_RATIO);
  }

  // 会話で使うモデル（選んでいればそれ。自動なら使える先頭、使えるものが無ければ候補の先頭）で選べる考える深さ。画面の検査と一覧に使う
  effortChoices(pinned: string | null): { modelId: string | undefined; efforts: string[] } {
    const config = this.#d.config();
    const id = pinned ?? this.#chain('chat').usable[0]?.model.id ?? candidateModelIds(config, 'chat')[0];
    const model = config.models.find(m => m.id === id);
    return { modelId: model?.id, efforts: model ? modelEfforts(config, model, this.#d.status.get(model.id)) : [] };
  }

  #smallestAvailable(): number | undefined {
    const config = this.#d.config();
    const ids = new Set([...candidateModelIds(config, 'chat'), ...candidateModelIds(config, 'background')]);
    let smallest: number | undefined;
    for (const id of ids) {
      const model = config.models.find(m => m.id === id);
      if (!model || !this.#d.status.usable(id)) continue;
      const capacity = this.#d.status.get(id)?.effective ?? model.contextLength ?? 0;
      if (!(capacity > 0)) continue;
      const available = contextAvailable(capacity, model);
      if (available > 0) smallest = smallest === undefined ? available : Math.min(smallest, available);
    }
    return smallest;
  }

  // 会話の実行が使うプロバイダを使っている裏の実行を止める。止めたタスクの id を返す
  #preemptFor(routes: Route[]): string[] {
    const providers = new Set(routes.map(r => r.provider.id));
    const tasks: string[] = [];
    for (const active of this.#active.values()) {
      if (active.kind === 'chat' || ![...active.providers].some(p => providers.has(p))) continue;
      this.#preempted.add(active.runId);
      if (active.taskId) tasks.push(active.taskId);
      active.controller.abort(new ProviderError('cancelled', engineText('ja', 'run.preempted'), { retryable: false }));
    }
    return tasks;
  }

  stop(runId: string): boolean {
    const active = this.#active.get(runId);
    if (!active) return false;
    this.#stopped.add(runId);
    active.controller.abort(providerError('cancelled', 'cancelled', {}, { retryable: false }));
    return true;
  }

  stopAll(): void { for (const runId of this.#active.keys()) this.stop(runId); }

  wait(runId: string): Promise<EngineResult> | undefined { return this.#active.get(runId)?.done; }
  get chatting(): boolean { return [...this.#active.values()].some(a => a.kind === 'chat'); }
  activeRuns(): Array<{ runId: string; conversationId: string; kind: RunKind }> {
    return [...this.#active.values()].map(a => ({ runId: a.runId, conversationId: a.conversationId, kind: a.kind }));
  }

  // 会話で選んだモデルがあれば（pinned）、そのモデルだけで鎖を作る。使えなければ、ほかのモデルへ切り替えずに、そのモデルの問題だけを返す
  // localOnly: 裏方の順番（routing.background）のうち、手元のモデルだけ。順番が空でもチャットの順番や設定のモデル全部には回さない
  #chain(route: 'chat' | 'background', pinned: string | null = null, localOnly = false): { usable: Route[]; problems: ModelProblem[] } {
    const config = this.#d.config();
    const language = languageOf(config);
    const ids = localOnly ? config.routing.background.filter(id => isLocalModel(config, id)) : pinned ? [pinned] : candidateModelIds(config, route);
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

  #noUsableModel(problems: ModelProblem[]): Extract<SendOutcome, { ok: false }> {
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

  #start(runId: string, conversationId: string, chain: Route[], kind: RunKind, task?: { task: Task; control: { value: TaskControl } }, forbid?: ReadonlySet<string>, effort: string | null = null): void {
    const controller = new AbortController();
    this.#byConversation.set(conversationId, runId);
    if (kind === 'chat') { this.#runModel.set(runId, this.#d.conversations.get(conversationId)?.model_id ?? null); this.#runMode.set(runId, this.#d.conversations.modeOf(conversationId)); }
    let ended: EngineResult | undefined;
    const done = this.#execute(runId, conversationId, chain, controller.signal, kind, task, forbid, effort)
      .catch((error): EngineResult => {
        this.#d.log?.(`[ERROR] run ${runId}: ${(error as Error).stack ?? error}`);
        this.#d.runs.finish(runId, { ok: false, attempts: 0, errorKind: 'internal', errorMessage: (error as Error).message });
        const language = languageOf(this.#d.config());
        const internal = engineText(language, 'run.internal', { detail: (error as Error).message });
        this.#d.bus.publish({ type: 'run.end', runId, conversationId, ok: false, errorKind: 'internal', errorMessage: internal, errorCode: 'engine.run.internal', errorParams: { detail: (error as Error).message } });
        return { ok: false, runId, text: '', errorKind: 'internal', errorMessage: internal, errorCode: 'engine.run.internal', errorParams: { detail: (error as Error).message }, retryable: false };
      })
      .then(result => { ended = result; return result; })
      .finally(() => {
        this.#active.delete(runId);
        this.#byConversation.delete(conversationId);
        this.#preemptedTasks.delete(runId);
        this.#runModel.delete(runId);
        this.#runMode.delete(runId);
        this.#stopped.delete(runId);
        setTimeout(() => this.#preempted.delete(runId), 60_000).unref?.();
        // 待っている発言の引き取り（会話の実行の鎖が途切れないよう、ロックを外した直後に、同じ呼び出しの中で次の実行を始める）
        if (kind === 'chat') {
          try { this.#drainPending(conversationId, runId, ended); } catch (error) { this.#d.log?.(`[ERROR] 待っていた発言の引き取り: ${(error as Error).stack ?? error}`); }
        }
        try { this.onRunEnd?.({ runId, conversationId, kind }); } catch (error) { this.#d.log?.(`[ERROR] onRunEnd: ${(error as Error).message}`); }
      });
    this.#active.set(runId, { runId, conversationId, kind, ...(task ? { taskId: task.task.id } : {}), providers: new Set(chain.map(r => r.provider.id)), controller, done });
  }

  // モデルに渡す道具の一覧。外す条件はここだけ（maxTools の数える前に外す）: 振り返りで禁止の効果・この実行で禁止された道具・持ち主が「止める」にした道具（tools.policies）。
  // 「止める」は、パイプラインと同じく、実行を始めたときの設定（started）といまの設定の厳しい方。始めたときに止めていた道具は、途中で緩めても、その実行のあいだは戻らない。
  // 計画モード（plan）の会話では、読む道具と Web の読み取り（PLAN_EFFECTS）だけを渡す（パイプラインの二重の拒否は runToolCall）。
  // 実行に効くモードは、実行を始めたときのモード（#assemble の startedMode）と会話のいまのモードの厳しい方。始めたときが計画なら、途中でふつうに戻しても、その実行のあいだは計画のまま
  #toolsFor(model: ModelConfig, kind: RunKind, forbid?: ReadonlySet<string>, started?: AppConfig, mode: PermissionMode = 'normal'): ToolDef[] {
    if (!this.#d.tools || model.maxTools === 0) return [];
    const config = this.#d.config();
    const exclude = (t: ToolDef) => (kind === 'review' && REVIEW_FORBIDDEN.has(t.effect)) || forbid?.has(t.name) === true || effectivePolicy(t.name, config, started) === 'block'
      || (mode === 'plan' && !PLAN_EFFECTS.has(t.effect));
    return this.#d.tools.registry.forRun(kind, { limit: model.maxTools, exclude });
  }

  async #execute(runId: string, conversationId: string, chain: Route[], signal: AbortSignal, kind: RunKind, task?: { task: Task; control: { value: TaskControl } }, forbid?: ReadonlySet<string>, effort: string | null = null): Promise<EngineResult> {
    const d = this.#d;
    const config = d.config();
    d.runs.start(runId, kind, conversationId);
    const snapshot = this.#snapshot(conversationId);
    d.bus.publish({ type: 'run.start', runId, conversationId, modelId: chain[0]!.model.id });
    const flags: string[] = [];
    const usage: Usage = {};
    const counters = { attempts: 0, iterations: 0, toolCalls: 0, workCalls: 0 };
    let index = 0;
    let invalidStreak = 0;
    let lastEstimate = 0;
    let lastRoute: Route = chain[0]!;
    const policy = buildPolicy(config, d.paths);
    // 道具が書き込む「どう終えるか」の印は、ワーカーが読む control.value と同じ入れ物にする
    const taskSlot = task ? { id: task.task.id, get control() { return task.control.value; }, set control(v: TaskControl) { task.control.value = v; } } : undefined;
    const touchedTasks = new Set<string>();
    const ctx: ToolContext = {
      runId, conversationId, kind, signal, config, paths: d.paths, policy, workspace: defaultWorkspace(policy, d.paths),
      taint: (() => { const sources = this.#initialTaint.get(runId) ?? []; this.#initialTaint.delete(runId); return { tainted: sources.length > 0, sources }; })(),
      log: d.log ?? (() => undefined),
      services: d.memory ? { db: d.conversations.db, memory: d.memory, tasks: d.tasks, curiosity: d.curiosity, skills: d.skills, web: d.web, notify: d.notify, emit: e => d.bus.publish(e) } : undefined,
      task: taskSlot,
      touchedTasks,
      ...(forbid ? { forbiddenTools: forbid } : {}),
      ...(kind === 'chat' ? { permissionMode: this.#runMode.get(runId) ?? 'normal' } : {}),
    };
    ctx.modelsLocal = chain.every(route => isLocalProvider(route.provider));
    ctx.localOnly = kind === 'chat' ? isLocalPinned(config, d.conversations.get(conversationId)?.model_id) : task?.task.local_only === 1;
    // 外から読んだ印は、実行の記録に読んだ時点で書く（途中で止まる・落ちる実行でも、やり直し・続きが引き継げるように）
    let taintRecorded = false;
    const recordTaint = () => { if (taintRecorded || !ctx.taint.tainted) return; taintRecorded = true; d.runs.markTainted(runId); };
    const addUsage = (u: Usage) => {
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
        if (typeof u[key] === 'number') usage[key] = (usage[key] ?? 0) + u[key]!;
      }
    };
    let replyLanguage: Language | undefined;
    const finishOk = (text: string, stop: StopReason, wrapUp?: { nextAction: string | undefined }): EngineResult => {
      if (replyLanguage && this.#lastReplyLanguage(conversationId) !== replyLanguage) d.kv.set(replyLanguageKey(conversationId), replyLanguage);
      if (kind === 'chat') this.#handOver(runId, conversationId, { note: text, nextAction: wrapUp?.nextAction }, { wrapUp: wrapUp !== undefined, workCalls: counters.workCalls, touched: touchedTasks, tainted: ctx.taint.tainted, localOnly: ctx.localOnly === true });
      d.runs.finish(runId, { ok: true, modelId: lastRoute.model.id, providerId: lastRoute.provider.id, model: lastRoute.model.model, attempts: counters.attempts, stop, iterations: counters.iterations, toolCalls: counters.toolCalls, usage, estPromptTokens: lastEstimate, flags });
      d.bus.publish({ type: 'run.end', runId, conversationId, ok: true });
      return { ok: true, runId, text, modelId: lastRoute.model.id, usage, stop };
    };
    const finishFail = (f: Failure): EngineResult => {
      const route = f.route ?? lastRoute;
      // 実行ログには、相手のサーバーの本文も残す（画面に届く出来事・結果には入れない）
      d.runs.finish(runId, { ok: false, attempts: counters.attempts, errorKind: f.kind, errorMessage: f.upstream ? `${f.message}: ${f.upstream}` : f.message, flags, iterations: counters.iterations, toolCalls: counters.toolCalls, usage, modelId: route.model.id, model: route.model.model, providerId: route.provider.id });
      d.bus.publish({ type: 'run.end', runId, conversationId, ok: false, errorKind: f.kind, errorMessage: f.message, ...(f.code ? { errorCode: f.code, errorParams: f.params ?? {} } : {}), ...(f.detail ? { detail: f.detail } : {}) });
      return { ok: false, runId, text: '', errorKind: f.kind, errorMessage: f.message, ...(f.code ? { errorCode: f.code, errorParams: f.params ?? {} } : {}), retryable: f.retryable, ...(f.detail ? { detail: f.detail } : {}) };
    };

    const maxIterations = iterationLimit(config.tools.maxIterations, kind);
    const compaction: CompactionState = { count: 0, failed: false, summarized: 0, trimmedShown: -1 };
    for (counters.iterations = 1; counters.iterations <= maxIterations; counters.iterations++) {
      if (kind === 'chat') { this.#injectPending(runId, conversationId, ctx); recordTaint(); }
      const call = await this.#callModel({ runId, conversationId, chain, start: index, snapshot, signal, counters, flags, compaction, kind, forbid, effort, started: config, startedMode: ctx.permissionMode });
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
        if (!toolCall.name.startsWith('task_')) counters.workCalls++;
        const toolModel = lastRoute.model;
        const toolCapacity = d.status.get(toolModel.id)?.effective ?? toolModel.contextLength ?? 0;
        ctx.outputLimit = toolCapacity > 0 ? toolOutputLimit(contextAvailable(toolCapacity, toolModel), TOOL_OUTPUT_LIMIT) : undefined;
        const outcome = await runToolCall(toolCall, ctx, {
          registry: d.tools.registry, approvals: d.tools.approvals, db: d.conversations.db, emit: e => d.bus.publish(e), config: d.config,
          permissionMode: () => d.conversations.modeOf(conversationId),
          autoClassify: (prompt, classifierSignal) => this.#autoAsk(lastRoute, ctx, prompt, classifierSignal),
          lastUserRequest: () => this.#lastUserRequest(conversationId),
        });
        recordTaint();
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
    if (kind !== 'chat') return finishOk('', 'other');
    // 会話は黙って止まらない: 道具なしで 1 回だけ、ここまで・次の一手を書かせて返事として残す。書けなければ決まった文
    const wrapped = await this.#wrapUp({ route: lastRoute, conversationId, signal, onUsage: addUsage });
    if (wrapped === 'cancelled') return this.#finishCancelled(runId, conversationId, counters, lastRoute, '');
    const text = wrapped ?? engineText(languageOf(config), 'wrapup.fallback', { max: maxIterations });
    const saved = d.conversations.append(conversationId, { role: 'assistant', content: text }, runId);
    d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'assistant' });
    return finishOk(text, 'other', { nextAction: wrapped ? nextStepOf(wrapped) : undefined });
  }

  // 自動承認の判定役に見せる、会話の利用者の最後の発言（添付の中身は除く）。無ければ空（判定役には回らず、確かめる）
  #lastUserRequest(conversationId: string): string {
    const stored = this.#d.conversations.messages(conversationId, 50);
    for (let i = stored.length - 1; i >= 0; i--) {
      const message = stored[i]!.message;
      if (message.role === 'user') return stripAttachments(message.content).slice(0, USER_REQUEST_LIMIT);
    }
    return '';
  }

  // 自動承認の判定役（モデル）を 1 回呼び、返事の文字を返す。呼べなければ投げる（呼ぶ側は確かめる側に倒す）。
  // 使うのは、この実行がいま使っているモデル（route）だけで、ほかのモデルは探さない。手元のモデルを選んだ会話（ctx.localOnly）は、手元のモデルのときだけ。道具は渡さない。
  // 判定役の呼び出しは engine_runs に入れず、会話も作らない
  async #autoAsk(route: Route, ctx: ToolContext, prompt: ClassifierPrompt, signal: AbortSignal): Promise<string> {
    const d = this.#d;
    const { model, provider } = route;
    if (ctx.localOnly && !isLocalProvider(provider)) throw new Error('the classifier model must be local for a local conversation');
    const adapter = d.registry.get(provider.id);
    if (!adapter) throw new Error('no adapter for the classifier model');
    let release: (() => void) | undefined;
    try {
      release = await d.limiter.acquire(provider.id, () => provider.maxParallel, signal);
      let text = '';
      for await (const event of adapter.stream({
        model, system: { frozen: prompt.system, dynamic: '' }, messages: [{ role: 'user', content: prompt.user }], tools: [], maxOutputTokens: Math.min(400, model.maxOutputTokens), signal,
      })) {
        if (event.type === 'text') text += event.delta;
      }
      return text;
    } finally { release?.(); }
  }

  // 上限で止まった会話のまとめ。道具を渡さず、直近のやり取りを文字の記録にして 1 通で渡す（道具の呼び出しの履歴を送ると、道具の定義が要るプロバイダがあるため）。
  // 書けた文を返す。空・失敗は null、止められたときは 'cancelled'
  async #wrapUp(c: { route: Route; conversationId: string; signal: AbortSignal; onUsage: (usage: Usage) => void }): Promise<string | 'cancelled' | null> {
    const d = this.#d;
    const language = languageOf(d.config());
    const { model, provider } = c.route;
    const adapter = d.registry.get(provider.id);
    if (!adapter) return null;
    const capacity = d.status.get(model.id)?.effective ?? model.contextLength ?? 0;
    const available = contextAvailable(capacity, model);
    const conversation = d.conversations.get(c.conversationId);
    const stored = d.conversations.messages(c.conversationId).filter(m => m.id > (conversation?.summary_upto ?? 0));
    const maxChars = Math.min(COMPACT_TRANSCRIPT_CHARS, Math.max(1000, Math.floor(available * 0.5)));
    const transcript = stored.map(m => `${compactSpeaker(m.message, language)}: ${m.text.slice(0, 1500)}`).join('\n').slice(-maxChars);
    let release: (() => void) | undefined;
    let usage: Usage = {};
    try {
      release = await d.limiter.acquire(provider.id, () => provider.maxParallel, c.signal);
      let text = '';
      for await (const event of adapter.stream({
        model, system: { frozen: wrapUpSystem(language), dynamic: '' },
        messages: [{ role: 'user', content: wrapUpPrompt(transcript, language) }], tools: [], maxOutputTokens: Math.min(1000, model.maxOutputTokens), signal: c.signal,
      })) {
        if (event.type === 'text') text += event.delta;
        else if (event.type === 'usage') usage = { ...usage, ...event.usage };
      }
      return text.trim() || null;
    } catch {
      return c.signal.aborted ? 'cancelled' : null;
    } finally { c.onUsage(usage); release?.(); }
  }

  // 会話の実行が終わるとき、会話で進んだ分をタスクの経過（メモ）に書く。書く先は次のとおりで、普通の終わりで何にも触っていなければ何も書かない:
  // - この実行で作った・task_update で触ったタスク（作る以外の道具を使った実行だけ。作っただけの確認の返事はメモにしない）
  // - 道具の上限で止まったときは、さらに、この会話で作った実行待ち・返事待ちのタスク。まとめに次の一手があれば、次の一手も書く
  // この実行が止めたタスク（preempted）は、止めただけでは書かない（止めるのは、同じモデルの提供元を使っているだけで、別の会話のタスクかもしれない）。触った・この会話で作ったときだけ書き、そのとき実行中のままの状態（running）も許す
  // 外から読んだ実行（taint）は書かない: メモはタスクの詳細に入り、外を読んでいないタスクの実行が指示として読むため
  // 手元のモデルの会話の実行（localOnly）が書いたタスクは、手元のモデルだけで動かすタスクにする（メモに会話の文が入るため）
  #handOver(runId: string, conversationId: string, summary: { note: string; nextAction?: string | undefined }, run: { wrapUp: boolean; workCalls: number; touched: ReadonlySet<string>; tainted: boolean; localOnly: boolean }): void {
    const d = this.#d;
    const note = summary.note.trim();
    if (!d.tasks || !note || run.tainted) return;
    const preempted = new Set(this.#preemptedTasks.get(runId) ?? []);
    const targets = new Set<string>();
    if (run.wrapUp || run.workCalls > 0) for (const id of run.touched) targets.add(id);
    if (run.wrapUp) for (const id of d.tasks.createdByConversation(conversationId)) targets.add(id);
    if (!targets.size) return;
    const language = languageOf(d.config());
    for (const id of targets) {
      const task = d.tasks.get(id);
      if (!task) continue;
      const open = preempted.has(id) ? ['ready', 'running', 'waiting'] : ['ready', 'waiting'];
      if (!open.includes(task.status)) continue;
      d.tasks.update(id, { appendNote: engineText(language, 'handover.note', { text: note.slice(0, 1500) }), ...(summary.nextAction ? { nextAction: summary.nextAction } : {}) }, 'clive', runId);
      if (run.localOnly) d.tasks.markLocalOnly(id);
    }
  }

  async #callModel(p: { runId: string; conversationId: string; chain: Route[]; start: number; snapshot: string; signal: AbortSignal; counters: { attempts: number }; flags: string[]; compaction: CompactionState; kind: RunKind; forbid?: ReadonlySet<string> | undefined; effort?: string | null | undefined; started?: AppConfig | undefined; startedMode?: PermissionMode | undefined }): Promise<CallResult> {
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

      for (let attempt = 0; attempt <= retries; attempt++) {
        if (p.signal.aborted) return { ok: false, cancelled: true, partial: '', failure: last, route };
        p.counters.attempts++;
        const { toolDefs, fallbackMode, system, history, stored, conversation, apiTools, capacity, available, factor } = this.#assemble({ conversationId: p.conversationId, snapshot: p.snapshot, model, kind: p.kind, forbid: p.forbid, started: p.started, startedMode: p.startedMode });
        const toolNames = new Set(toolDefs.map(t => t.name));
        // 考える深さは、そのモデルが受け付ける値のときだけ送る（鎖の途中で別のモデルに替わったとき、受け付けない値を送らない）
        const effort = p.effort && modelEfforts(d.config(), model, d.status.get(model.id)).includes(p.effort) ? p.effort : undefined;
        let fitted;
        try {
          fitted = fitMessages({ system: `${system.frozen}\n${system.dynamic}`, messages: history, tools: apiTools, available, factor });
        } catch (error) {
          if (!(error instanceof ContextOverflow)) throw error;
          last = { kind: 'context_overflow', message: engineText(language, 'fit.overflow', { required: error.required.toLocaleString('en-US'), available: error.available.toLocaleString('en-US') }), code: 'engine.fit.overflow', params: { required: error.required, available: error.available }, retryable: false, route,
            detail: { reason: 'prompt_exceeds', measured: available, required: error.required, hint: engineText(language, 'hint.prompt_exceeds') } };
          break;
        }
        // 外す発言が多ければ、外す部分を前の要約に足して要約し直してから組み立て直す（同じ実行の中でも、外す発言が増えたらまた。
        // 1 回の実行で MAX_COMPACTIONS_PER_RUN 回まで。要約に失敗したら、その実行は外すだけにして、要約を呼び続けない）
        if (fitted.removed >= COMPACT_MIN_MESSAGES && !fallbackMode && !p.compaction.failed && p.compaction.count < MAX_COMPACTIONS_PER_RUN) {
          p.compaction.count++;
          const removed = stored.slice(0, fitted.removed);
          const ok = await this.#compact({ route, adapter, runId: p.runId, conversationId: p.conversationId, removed, previous: conversation?.summary ?? null, capacity, signal: p.signal });
          if (ok) {
            // お知らせは 1 回の実行で 1 回ずつ。件数は、この実行で要約した発言の合計に更新する（画面は同じお知らせを置き換える）
            p.compaction.summarized += removed.length;
            d.bus.publish({ type: 'compaction', runId: p.runId, conversationId: p.conversationId, summarized: p.compaction.summarized });
            d.bus.publish({ type: 'warning', runId: p.runId, conversationId: p.conversationId, code: 'compacted', message: engineText(language, 'warn.compacted', { count: p.compaction.summarized }), params: { count: p.compaction.summarized } });
            if (!p.flags.includes('compacted')) p.flags.push('compacted');
            attempt--; continue;
          }
          p.compaction.failed = true;
        }
        if (fitted.removed > 0) {
          if (p.compaction.trimmedShown !== fitted.removed) {
            p.compaction.trimmedShown = fitted.removed;
            d.bus.publish({ type: 'warning', runId: p.runId, conversationId: p.conversationId, code: 'context_trimmed', message: engineText(language, 'warn.context_trimmed', { count: fitted.removed }), params: { count: fitted.removed } });
          }
          if (!p.flags.includes('context_trimmed')) p.flags.push('context_trimmed');
        }

        let text = '';
        let usage: Usage = {};
        let stop: StopReason = 'other';
        const toolCalls: ToolCall[] = [];
        let release: (() => void) | undefined;
        try {
          release = await d.limiter.acquire(provider.id, () => provider.maxParallel, p.signal);
          for await (const event of adapter.stream({ model, system, messages: fitted.messages, tools: apiTools, maxOutputTokens: model.maxOutputTokens, ...(effort ? { effort } : {}), signal: p.signal })) {
            if (event.type === 'text') { text += event.delta; d.bus.publish({ type: 'text.delta', runId: p.runId, conversationId: p.conversationId, text: event.delta }); }
            else if (event.type === 'usage') usage = { ...usage, ...event.usage };
            else if (event.type === 'tool_call') toolCalls.push(event.call);
            else if (event.type === 'done') stop = event.stop;
          }
        } catch (error) {
          const e = error instanceof ProviderError ? error
            : p.signal.aborted ? providerError('cancelled', 'cancelled', {}, { retryable: false })
            : providerError('internal', 'unexpected', {}, { retryable: false, upstream: redactSecrets((error as Error).message).slice(0, 200) });
          if (e.kind === 'cancelled' || p.signal.aborted) return { ok: false, cancelled: true, partial: text, failure: last, route };
          last = { kind: e.kind, message: e.text(language), ...(e.code ? { code: `provider.${e.code}`, params: e.params } : {}), retryable: e.retryable, route, ...(e.detail ? { detail: e.detail } : {}), ...(e.upstream ? { upstream: e.upstream } : {}) };
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
        if (effort && !p.flags.includes(`effort:${effort}`)) p.flags.push(`effort:${effort}`);
        return { ok: true, index, text, toolCalls, usage, stop: toolCalls.length ? 'tool_use' : stop, estimate: fitted.estimate.tokens, language };
      }
    }
    return { ok: false, cancelled: false, partial: '', failure: last };
  }

  // モデルへ送る 1 回分の組み立て（system・履歴・道具の仕様・見積もりの補正）。実行（#callModel）と使用量（contextUsage）の両方がここを通るので、数がずれない。
  // 何も書かない。固定の system（snapshot）は呼ぶ側が渡す
  // startedMode: 実行を始めたときの権限モード（実行の中でだけ渡す。使用量の数え方は次の実行のためなので、会話のいまのモードで数える）
  #assemble(p: { conversationId: string; snapshot: string; model: ModelConfig; kind: RunKind; forbid?: ReadonlySet<string> | undefined; started?: AppConfig | undefined; startedMode?: PermissionMode | undefined }) {
    const d = this.#d;
    const { model } = p;
    const config = d.config();
    const language = languageOf(config);
    const current = d.conversations.modeOf(p.conversationId);
    const mode: PermissionMode = p.kind === 'chat' ? stricterMode(p.startedMode ?? current, current) : 'normal';
    const toolDefs = this.#toolsFor(model, p.kind, p.forbid, p.started, mode);
    const specs = ToolRegistry.specs(toolDefs);
    const fallbackMode = model.toolMode === 'json_fallback';
    const capacity = d.status.get(model.id)?.effective ?? model.contextLength ?? 0;
    const available = contextAvailable(capacity, model);
    const conversation = d.conversations.get(p.conversationId);
    const upto = conversation?.summary_upto ?? 0;
    const stored = d.conversations.messages(p.conversationId).filter(m => m.id > upto);
    const summary = summarySection(conversation?.summary ?? '', language);
    const dynamic = [buildDynamic(config.timezone, language, d.now?.() ?? new Date(), mode), summary, fallbackMode ? jsonFallbackInstructions(specs, language) : ''].filter(Boolean).join('\n\n');
    const system = { frozen: p.snapshot, dynamic };
    let history = stored.map(m => m.message);
    if (fallbackMode) history = toJsonFallbackHistory(history, language);
    if (this.#frozenLanguage(p.conversationId) !== language || this.#lastReplyLanguage(p.conversationId) !== language) history = withReplyReminder(history, language);
    const apiTools = fallbackMode ? [] : specs;
    const factor = d.kv.getJson<number>(`calibration:${model.id}`) ?? 1;
    return { toolDefs, fallbackMode, system, history, stored, conversation, apiTools, capacity, available, factor };
  }

  // いまの会話を次に送るとき、モデルへ送る量（トークンの見積もり）。古い発言を削る前の全体で、available（削り始める境目）に対する割合 ratio は 1 を超えうる。
  // 副作用を持たない: 無い会話を作らず、固定の system が無い会話は固定せず（そのとき作るはずの文で数える）、ファイルの版も言語の記録も書かない。
  contextUsage(conversationId: string, modelId?: string): ContextUsageOutcome {
    const d = this.#d;
    const config = d.config();
    const language = languageOf(config);
    let model: ModelConfig | undefined;
    const existing = d.conversations.get(conversationId);
    // 数えるモデル: 指定されたもの → 会話で選んだもの → 設定の順番の先頭の使えるもの。選んだモデルが使えなくても、ほかのモデルで数えない
    const wanted = modelId ?? existing?.model_id ?? undefined;
    if (wanted !== undefined) {
      model = config.models.find(m => m.id === wanted);
      if (!model) {
        if (modelId === undefined) return this.#noUsableModel(this.#chain('chat', wanted).problems);
        return { ok: false, httpStatus: 404, errorKind: 'not_found', errorMessage: engineText(language, 'usage.model_missing', { id: wanted }), errorCode: 'engine.usage.model_missing', errorParams: { id: wanted } };
      }
      if (!((d.status.get(model.id)?.effective ?? model.contextLength ?? 0) > 0)) {
        return this.#noUsableModel([{ modelId: model.id, status: 'unknown', message: engineText(language, 'problem.unchecked'), messageCode: 'engine.problem.unchecked' }]);
      }
    } else {
      const chain = this.#chain('chat');
      model = chain.usable.map(r => r.model).find(m => (d.status.get(m.id)?.effective ?? m.contextLength ?? 0) > 0);
      if (!model) return this.#noUsableModel(chain.problems);
    }
    const snapshot = existing?.snapshot ?? this.#previewSnapshot(language);
    const built = this.#assemble({ conversationId, snapshot, model, kind: 'chat' });
    const { tokens } = estimateRequest(`${built.system.frozen}\n${built.system.dynamic}`, built.history, built.apiTools, built.factor);
    return { ok: true, modelId: model.id, tokens, available: built.available, capacity: built.capacity, ratio: tokens / built.available };
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
    const snapshot = this.#buildSnapshotText(language);
    if (d.conversations.setSnapshotOnce(conversationId, snapshot.text, snapshot.hash)) d.kv.set(snapshotLanguageKey(conversationId), language);
    return d.conversations.get(conversationId)?.snapshot ?? snapshot.text;
  }

  // 会話の始めに固定する system の文。作るだけで、何も書かない
  #buildSnapshotText(language: Language) {
    const d = this.#d;
    return buildSnapshot(d.paths, {
      ...(d.memory ? { memories: renderBooks(d.memory.list(), language, this.memoryBudget()) } : {}),
      ...(d.skills ? { skills: d.skills.index(language) } : {}),
    }, language);
  }

  #previewSnapshot(language: Language): string { return this.#buildSnapshotText(language).text; }

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
