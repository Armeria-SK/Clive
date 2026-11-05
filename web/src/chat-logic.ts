import { ApiError, type ModelView } from './api.ts';
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

export type ChatItemKind = 'user' | 'assistant' | 'think' | 'tool' | 'run' | 'note' | 'fail';

const TOOL_KINDS: ReadonlySet<ChatItemKind> = new Set<ChatItemKind>(['tool', 'run']);

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
] as const satisfies ReadonlyArray<{ name: string; desc: PlainKey }>;

export type SlashCommand = (typeof SLASH_COMMANDS)[number];
export type SlashName = SlashCommand['name'];

export function slashMatches(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return [];
  const query = input.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter(c => c.name.startsWith(query));
}

export function renameTitleOf(input: string): string | null {
  const title = /^\/rename\s+([\s\S]+)$/u.exec(input.trim())?.[1]?.trim();
  return title ? title.slice(0, 200) : null;
}

export const isRenameWithoutTitle = (input: string): boolean => /^\/rename\s*$/u.test(input.trim());

export const TOOL_ICONS: Readonly<Record<string, IconName>> = {
  file_read: 'file', file_write: 'filePen', file_edit: 'pencil', file_list: 'folder',
  shell_run: 'terminal',
  web_fetch: 'globe', web_search: 'search',
  memory_save: 'bookmark', memory_update: 'bookmark', memory_forget: 'bookmark', memory_search: 'bookmark',
  history_search: 'clock', history_read: 'clock',
  skill_view: 'wrench', skill_draft: 'wrench',
  task_create: 'tasks', task_list: 'tasks', task_update: 'tasks', task_checkpoint: 'tasks', task_complete: 'tasks',
  ask_user: 'help',
  curiosity_add: 'sparkles', curiosity_list: 'sparkles', curiosity_update: 'sparkles',
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
