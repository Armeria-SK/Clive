import type { PermissionMode } from '../../src/shared/permission-mode.ts';
import { ApiError, type ApprovalPathView, type ModelChoice, type ModelView } from './api.ts';
import { formatElapsed, getLanguage, getTimezone, type Lang, type PlainKey } from './i18n/index.ts';
import type { IconName } from './icon-paths.ts';
import { probeMessage, serverText } from './server-text.ts';

export interface ModelProblem { modelId: string; status: string; message: string; hint?: string | undefined; messageCode?: string | undefined; messageParams?: Record<string, string | number> | undefined }

export interface ContextNumbers {
  effective: number | null;
  required: number | null;
  declared: number | null;
  measured: number | null;
  modelMax: number | null;
}

export interface ContextCardData {
  modelId: string;
  status: string;
  hint: string | null;
  numbers: ContextNumbers;
}

export interface SendFailure {
  message: string;
  hint: string | null;
  context: boolean;
  noModels: boolean;
  body: unknown;
}

const CONTEXT_STATUSES: ReadonlySet<string> = new Set(['too_small', 'exceeds_model', 'unknown']);

const asRecord = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function isProblem(value: unknown): value is ModelProblem {
  const record = asRecord(value);
  return record !== null && typeof record.modelId === 'string' && typeof record.status === 'string' && typeof record.message === 'string';
}

// 「使えるモデルがない」の 409 は、モデルごとの理由の行（{lines}）をサーバーが文にして入れている（コードには値が付かない）。
// 画面の言語で出すため、problems の行を組み立て直す。各行は、problems[] 自身の messageCode / messageParams から作る。
// 古いサーバーでコードが付かないときだけ、同じ状態のモデルの確認（コード付き）から作る。組み立てられなければ null（サーバーの文のまま）。
export function noUsableText(body: unknown, models: readonly ModelView[], language: Lang): string | null {
  const record = asRecord(body);
  if (record?.errorCode !== 'engine.no_usable' || !Array.isArray(record.problems) || !record.problems.every(isProblem)) return null;
  const lines: string[] = [];
  for (const problem of record.problems.filter(isProblem)) {
    const probe = models.find(m => m.id === problem.modelId)?.probe ?? null;
    const message = problem.messageCode
      ? probeMessage({ message: problem.message, messageCode: problem.messageCode, messageParams: problem.messageParams }, language)
      : probe !== null && probe.status === problem.status ? probeMessage(probe, language) : problem.message;
    const hintPart = problem.hint ? serverText('engine.problem.hint_suffix', { hint: problem.hint }, language) : '';
    const line = hintPart === null ? null : serverText('engine.problem.line', { id: problem.modelId, message, hintPart }, language);
    if (line === null) return null;
    lines.push(line);
  }
  const text = lines.length ? lines.join('\n') : serverText('engine.problem.none', {}, language);
  return text === null ? null : serverText('engine.no_usable', { lines: text }, language);
}

export function sendFailureOf(error: unknown, fallback: string, models: readonly ModelView[] = []): SendFailure {
  if (!(error instanceof ApiError)) return { message: fallback, hint: null, context: false, noModels: false, body: null };
  const body = asRecord(error.body);
  return {
    noModels: body?.errorCode === 'engine.no_usable' && Array.isArray(body.problems) && body.problems.length === 0,
    message: noUsableText(error.body, models, getLanguage()) ?? error.message,
    hint: text(asRecord(body?.detail)?.hint),
    context: (body?.errorKind ?? body?.error) === 'context_overflow',
    body: error.body,
  };
}

export function contextCardOf(body: unknown, models: readonly ModelView[]): ContextCardData | null {
  const record = asRecord(body);
  if (!record || (record.errorKind ?? record.error) !== 'context_overflow') return null;
  const problems = Array.isArray(record.problems) ? record.problems.filter(isProblem) : [];
  const problem = problems.find(p => CONTEXT_STATUSES.has(p.status)) ?? null;
  const probe = problem ? models.find(m => m.id === problem.modelId)?.probe ?? null : null;
  return {
    modelId: problem?.modelId ?? '',
    status: problem?.status ?? '',
    hint: text(problem?.hint) ?? text(asRecord(record.detail)?.hint),
    numbers: {
      effective: num(probe?.effective), required: num(probe?.required), declared: num(probe?.declared),
      measured: num(probe?.measured), modelMax: num(probe?.modelMax),
    },
  };
}

export function runOverflowOf(notice: { errorKind?: string | undefined; measured?: number | undefined; required?: number | undefined }): { available: number; required: number } | null {
  if (notice.errorKind !== 'context_overflow') return null;
  const available = num(notice.measured);
  const required = num(notice.required);
  return available !== null && required !== null ? { available, required } : null;
}

export interface ChatRunRow { id: string; model_id: string | null; model?: string | null; started_at: number }

type IdSource = { randomUUID?: () => string; getRandomValues: (bytes: Uint8Array) => Uint8Array };

// 新しい会話の id。randomUUID は https か localhost でしか使えないので、http の画面では getRandomValues から UUID（v4）を作る。
export function newConversationId(source: IdSource = globalThis.crypto): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// 送る先の会話。まだ無い会話（最初の発言）は、画面が id を決めてそこへ送る（サーバーは受け付けたときだけ会話を作る）。
// 断られたあとのやり直しは、同じ id をもう一度使う。
export function sendTarget(conversationId: string | null, created: string | null, generate: () => string = newConversationId): { id: string; created: string | null } {
  if (conversationId) return { id: conversationId, created };
  const id = created ?? generate();
  return { id, created: id };
}

// 発言と一緒に送る、モデルと考える深さの選び。会話がまだ無いときは、画面で覚えている選びを最初の発言と一緒に送る（サーバーにまだ覚える会話が無いため）。
// 会話があれば送らない（サーバーが覚えている）。override（使えるモデルで送る道など、その場で決めた選び）は、画面で覚えている選びより優先して、そのまま送る
// （画面の状態は、押した直後はまだ古いので使わない。モデルだけを替えるときは、古い考える深さも持ち越さない）
// 会話の変更のうち、使用量の輪を数え直すもの: 使うモデルが変わるとき、権限モードが変わるとき（計画モードは、モデルに渡す道具の一覧と指示が変わる）
export const recountsUsage = (kind: string): boolean => kind === 'model' || kind === 'mode';

export function sendChoiceOf(conversationId: string | null, current: { modelId: string | null; effort: string | null; permissionMode?: PermissionMode }, override?: ModelChoice): ModelChoice {
  if (override) return { ...override };
  if (conversationId) return {};
  return { ...(current.modelId ? { modelId: current.modelId } : {}), ...(current.effort ? { effort: current.effort } : {}), ...(current.permissionMode && current.permissionMode !== 'normal' ? { permissionMode: current.permissionMode } : {}) };
}

export type ChatItemKind = 'user' | 'assistant' | 'think' | 'tool' | 'run' | 'note' | 'fail';

const TOOL_KINDS: ReadonlySet<ChatItemKind> = new Set<ChatItemKind>(['tool', 'run']);

// 流れている返事を描き直す間隔（ミリ秒）。描き直しは文の長さに比例して重く（1000 文字で約 1 ms、5 万文字で約 60 ms）、
// 断片が届くたびに全文を描き直すと、長い返事の終わりごろには画面がほぼ描き直しだけで埋まる。短い返事は今までどおり届くたびに描く
export function liveRenderDelay(length: number): number {
  return length < 3000 ? 0 : Math.min(1000, Math.round(length / 100));
}

export interface ThrottleTimers {
  // fn を ms 後に呼ぶ。止める関数を返す
  setTimer: (fn: () => void, ms: number) => () => void;
  now: () => number;
  redraw: () => void;
}

// 流れている文を、長さに応じた間隔でしか描き直さない。間隔が過ぎていれば、届いた分をすぐ描く。届かなくなったら、残りを間隔の終わりに描く。
// 画面の部品（useThrottledText）はこれを呼ぶだけにして、時計と待ちを差し替えて試せるようにしてある
export class TextThrottle {
  shown: string;
  drawnAt = 0;
  constructor(initial: string) { this.shown = initial; }

  // 描くたびに呼ぶ。今描く文を返す
  next(text: string, now: number): string {
    const delay = liveRenderDelay(text.length);
    if (delay === 0 || now - this.drawnAt >= delay || !text.startsWith(this.shown)) { this.shown = text; this.drawnAt = now; }
    return this.shown;
  }

  // 描いていない残りがあるとき、間隔の終わりに描き直す待ちを置く。置いたものを止める関数を返す（残りが無ければ undefined）
  arm(text: string, timers: ThrottleTimers): (() => void) | undefined {
    if (this.shown === text) return undefined;
    // 待ちが鳴った時点で残りを描いたことにする。時計が少し早く鳴ると、次の描き直しで「間隔がまだ過ぎていない」と見て、
    // 残りが描かれないまま、文が変わるまで待ちも置き直されない（描き残し）ため
    return timers.setTimer(() => { this.shown = text; this.drawnAt = timers.now(); timers.redraw(); }, Math.max(0, liveRenderDelay(text.length) - (timers.now() - this.drawnAt)));
  }
}

export interface ReplyTurn {
  // この返事の文に、見出し（姿・名前・時刻）を付ける。1 回の返事（同じ runId）の最初の文だけ
  head: boolean;
  // コピーのボタンを付ける。1 回の返事の最後の文だけ（まだ続いている最中は付けない）。押すと、その回の文を全部まとめてコピーする
  copyText: string | null;
}

// 1 回の返事（同じ runId）の中で、道具を使うたびに文が分かれて保存される。画面では見出しを 1 つにして、
// 中間の文と道具の行を、見出しの下に順に並べる。発言（user）が入ったら、そこで次の返事になる。runId の無い文は、それぞれが 1 回の返事
export function replyTurns(
  messages: ReadonlyArray<{ id: number; role: string; runId: string | null; text: string }>,
  liveRunId: string | null = null,
): Map<number, ReplyTurn> {
  const out = new Map<number, ReplyTurn>();
  let group: Array<{ id: number; text: string }> = [];
  let groupRun: string | null = null;
  const close = (): void => {
    const last = group.at(-1);
    if (!last) return;
    const copyText = groupRun !== null && groupRun === liveRunId ? null : group.map(g => g.text).join('\n\n');
    group.forEach((g, i) => out.set(g.id, { head: i === 0, copyText: g === last ? copyText : null }));
    group = [];
    groupRun = null;
  };
  for (const m of messages) {
    if (m.role === 'user') { close(); continue; }
    if (m.role !== 'assistant') continue;
    if (m.runId === null || m.runId !== groupRun) close();
    groupRun = m.runId;
    group.push({ id: m.id, text: m.text });
  }
  close();
  return out;
}

export function joinsToolRun(kinds: readonly ChatItemKind[]): boolean[] {
  return kinds.map((kind, i) => i > 0 && TOOL_KINDS.has(kind) && TOOL_KINDS.has(kinds[i - 1]!));
}

export const SLASH_COMMANDS = [
  { name: 'new', desc: 'slash.new' },
  { name: 'task', desc: 'slash.task' },
  { name: 'tasks', desc: 'slash.tasks' },
  { name: 'skills', desc: 'slash.skills' },
  { name: 'log', desc: 'slash.log' },
  { name: 'memory', desc: 'slash.memory' },
  { name: 'stop', desc: 'slash.stop' },
  { name: 'rename', desc: 'slash.rename' },
  { name: 'archive', desc: 'slash.archive' },
  { name: 'summary', desc: 'slash.summary' },
] as const satisfies ReadonlyArray<{ name: string; desc: PlainKey }>;

export type SlashCommand = (typeof SLASH_COMMANDS)[number];
export type SlashName = SlashCommand['name'];

export function slashMatches(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return [];
  const query = input.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter(c => c.name.startsWith(query));
}

// 実行ごとのお知らせの並び。key が同じ（同じ実行の同じ種類）お知らせは、並べずに最新の内容で置き換える
// （要約した件数・外した件数が増えるたびに、同じお知らせが並ばないように）。max 件を超えたら古いものから落とす
export function mergeNotice<T extends { runId: string; key?: string | undefined }>(list: readonly T[], notice: T, max = 8): T[] {
  const at = notice.key === undefined ? -1 : list.findIndex(n => n.runId === notice.runId && n.key === notice.key);
  const next = at >= 0 ? list.map((n, i) => (i === at ? notice : n)) : [...list, notice];
  return next.slice(-max);
}

export function renameTitleOf(input: string): string | null {
  const title = /^\/rename\s+([\s\S]+)$/u.exec(input.trim())?.[1]?.trim();
  return title ? title.slice(0, 200) : null;
}

export const isRenameWithoutTitle = (input: string): boolean => /^\/rename\s*$/u.test(input.trim());

export const TOOL_ICONS: Readonly<Record<string, IconName>> = {
  file_read: 'file', file_write: 'filePen', file_edit: 'pencil', file_list: 'folder', file_search: 'search',
  shell_run: 'terminal',
  web_fetch: 'globe', web_search: 'search',
  memory_save: 'bookmark', memory_update: 'bookmark', memory_forget: 'bookmark', memory_search: 'bookmark',
  history_search: 'clock', history_read: 'clock',
  skill_view: 'wrench', skill_draft: 'wrench',
  task_create: 'tasks', task_list: 'tasks', task_update: 'tasks', task_checkpoint: 'tasks', task_complete: 'tasks',
  ask_user: 'help',
  curiosity_add: 'sparkles', curiosity_list: 'sparkles', curiosity_update: 'sparkles',
  calculate: 'sliders', date_calc: 'clock',
  checklist_write: 'check', notify_owner: 'bell',
};

export const toolIcon = (name: string | null | undefined): IconName => TOOL_ICONS[name ?? ''] ?? 'terminal';

const INPUT_KEYS = ['command', 'path', 'url', 'query', 'topic', 'title', 'name', 'content', 'text'];
const oneLine = (value: string): string => value.replace(/\s+/gu, ' ').trim();

export function toolInputSummary(input: string, max = 240): string {
  let shown = input;
  try {
    const parsed: unknown = JSON.parse(input);
    const record = asRecord(parsed);
    if (typeof parsed === 'string') shown = parsed;
    else if (record) {
      const key = INPUT_KEYS.find(k => typeof record[k] === 'string' && record[k] !== '')
        ?? Object.keys(record).find(k => typeof record[k] === 'string' && record[k] !== '');
      shown = key ? record[key] as string : JSON.stringify(record);
    }
  } catch { shown = input; }
  const line = oneLine(shown);
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function firstLine(value: string, max = 160): string {
  const line = value.split('\n').find(l => l.trim()) ?? '';
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export const formatCountdown = (ms: number): string => formatElapsed(Math.max(0, ms));

// 「この返事のあいだ、このフォルダ以下への書き込みを許可」のボタンに出すフォルダ名: 長い絶対パスは、末尾の 2 つの名前だけ（全部はボタンの title）
export function grantFolderLabel(folder: string): string {
  const parts = folder.split(/[\\/]+/u).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/') || folder;
}

// 承認の札の、見つけたパスごとの判定の札。中は読み書き・読むだけで文が分かれ、知らない判定は「判定できない」
export function approvalPathKey(path: Pick<ApprovalPathView, 'verdict' | 'mode'>): PlainKey {
  switch (path.verdict) {
    case 'in': return path.mode === 'read' ? 'approval.verdict.inRead' : 'approval.verdict.inWrite';
    case 'out': return 'approval.verdict.out';
    case 'deny': return 'approval.verdict.deny';
    default: return 'approval.verdict.unknown';
  }
}

// サーバーが切って出さなかったパスの行の数（古い応答には無いので 0）
export const approvalPathsMore = (a: { pathsMore?: number }): number => Math.max(0, Math.floor(a.pathsMore ?? 0));

// 許可フォルダの中は目立たせず、それ以外（外・拒否・判定できない）は縁取りで目立たせる（デザインどおり）
export const approvalPathTone = (verdict: ApprovalPathView['verdict']): 'neutral' | 'outline' => (verdict === 'in' ? 'neutral' : 'outline');

// コンテキストの使用量の表示。割合は四捨五入し、1 を超えたら「100%+」（輪は 100% で止める）
export function contextPercent(ratio: number): { text: string; over: boolean; fraction: number } {
  const value = Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
  if (value > 1) return { text: '100%+', over: true, fraction: 1 };
  return { text: `${Math.round(value * 100)}%`, over: false, fraction: value };
}

// トークン数を 12.4k / 180k / 1.25M のようにまとめる
export function compactTokens(n: number): string {
  const value = Number.isFinite(n) && n > 0 ? n : 0;
  if (value < 1000) return String(Math.round(value));
  if (value >= 999_950) return `${Number((Math.round(value / 10_000) / 100).toFixed(2))}M`;
  return `${Number((Math.round(value / 100) / 10).toFixed(1))}k`;
}

export function approvalFraction(expiresAt: number, now: number, totalMs: number): number {
  if (!(totalMs > 0)) return 0;
  return Math.min(1, Math.max(0, (expiresAt - now) / totalMs));
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

export function chatTime(ms: number, language = getLanguage(), zone = getTimezone()): string {
  const key = `${language}|${zone}`;
  let formatter = clockFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(language, { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    clockFormatters.set(key, formatter);
  }
  return formatter.format(ms);
}

export const APPROVAL_ENTER_GRACE_MS = 1000;

// Enter で「今回だけ許可」できる先頭の承認。コードを動かす確かめ（onceOnly）は、中身を見てボタンで許可するので Enter では許可しない
export function enterApprovalId(approvals: ReadonlyArray<{ id: string; onceOnly?: boolean }>): string | null {
  const front = approvals[0];
  return front && !front.onceOnly ? front.id : null;
}

export interface ApprovalGate { id: string | null; since: number }

export function advanceApprovalGate(gate: ApprovalGate, frontId: string | null, now: number): ApprovalGate {
  return gate.id === frontId ? gate : { id: frontId, since: now };
}

export function restartApprovalGate(gate: ApprovalGate, now: number): ApprovalGate {
  return { id: gate.id, since: now };
}

export function approvalEnterAllowed(gate: ApprovalGate, shownId: string | null, now: number, graceMs = APPROVAL_ENTER_GRACE_MS): boolean {
  return shownId !== null && gate.id === shownId && now - gate.since >= graceMs;
}

export interface DecisionTracker { start: (id: string) => boolean; release: (id: string) => void; has: (id: string) => boolean }

export function createDecisionTracker(): DecisionTracker {
  const pending = new Set<string>();
  return {
    start: id => { if (pending.has(id)) return false; pending.add(id); return true; },
    release: id => { pending.delete(id); },
    has: id => pending.has(id),
  };
}

export function isNearBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }, slack = 80): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}
