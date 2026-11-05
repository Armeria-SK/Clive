import type { CuriosityItem, Task, TaskStatus } from './api.ts';
import type { PlainKey } from './i18n/types.ts';
import type { IconName } from './icon-paths.ts';

// タスク画面の、画面を使わない部分（分け方・並べ方・どの操作を出すか）。文字は辞書のキーで持ち、表示のときに引く。

export type TaskSection = 'attn' | 'act' | 'sch' | 'done';
export const SECTION_ORDER: readonly TaskSection[] = ['attn', 'act', 'sch', 'done'];

export const STATUS_KEY: Record<TaskStatus, PlainKey> = {
  inbox: 'task.status.inbox', ready: 'task.status.ready', running: 'task.status.running', waiting: 'task.status.waiting',
  scheduled: 'task.status.scheduled', done: 'task.status.done', failed: 'task.status.failed', cancelled: 'task.status.cancelled',
};
export const STATUS_ICON: Record<TaskStatus, IconName> = {
  inbox: 'sparkles', ready: 'circle', running: 'loader', waiting: 'help', scheduled: 'repeat', done: 'circleCheck', failed: 'circleX', cancelled: 'circleSlash',
};
export const ORIGIN_KEY: Record<Task['origin'], PlainKey> = {
  user: 'tasks.origin.user', self: 'tasks.origin.self', schedule: 'tasks.origin.schedule', curiosity: 'tasks.origin.curiosity',
};
export const CURIOSITY_STATUS_KEY: Record<CuriosityItem['status'], PlainKey> = {
  open: 'curiosity.status.open', researching: 'curiosity.status.researching', done: 'curiosity.status.done', dropped: 'curiosity.status.dropped',
};

const PRIORITY_KEYS = { 1: 'tasks.priority.1', 2: 'tasks.priority.2', 3: 'tasks.priority.3' } as const satisfies Record<number, PlainKey>;
export const priorityKey = (priority: number): PlainKey => (priority === 1 ? PRIORITY_KEYS[1] : priority === 3 ? PRIORITY_KEYS[3] : PRIORITY_KEYS[2]);

const EVENT_KEYS = {
  created: 'tasks.event.created', note: 'tasks.event.note', requeued: 'tasks.event.requeued', question: 'tasks.event.question', approval: 'tasks.event.approval',
  answer: 'tasks.event.answer', run: 'tasks.event.run', done: 'tasks.event.done', failed: 'tasks.event.failed', cancelled: 'tasks.event.cancelled',
  approved: 'tasks.event.approved', reopened: 'tasks.event.reopened', skipped: 'tasks.event.skipped', edited: 'tasks.event.edited', context: 'tasks.event.context',
} as const satisfies Record<string, PlainKey>;
export function eventKey(kind: string): PlainKey | null {
  return Object.hasOwn(EVENT_KEYS, kind) ? EVENT_KEYS[kind as keyof typeof EVENT_KEYS] : null;
}

export const isFinished = (status: TaskStatus): boolean => status === 'done' || status === 'failed' || status === 'cancelled';
export const needsAttention = (status: TaskStatus): boolean => status === 'waiting' || status === 'inbox';
export const isAccent = (status: TaskStatus): boolean => status === 'running' || status === 'waiting' || status === 'inbox';

// 実行待ちで開始の時刻がこれから先のもの（日時指定、再試行までの休み、止めたあとの 20 秒）は「予定」に置く。
export function sectionOf(task: Task, now: number): TaskSection {
  if (needsAttention(task.status)) return 'attn';
  if (isFinished(task.status)) return 'done';
  if (task.status === 'scheduled' || (task.status === 'ready' && task.run_at !== null && task.run_at > now)) return 'sch';
  return 'act';
}

const fold = (text: string): string => text.normalize('NFKC').toLowerCase();
const matches = (task: Task, query: string): boolean => fold(`${task.title}\n${task.body}\n${task.next_action ?? ''}\n${task.waiting_text ?? ''}`).includes(query);

const byPriority = (a: Task, b: Task): number => a.priority - b.priority || b.updated_at - a.updated_at;
const first = (wanted: TaskStatus) => (a: Task, b: Task): number => Number(b.status === wanted) - Number(a.status === wanted);

export function groupTasks(tasks: readonly Task[], now: number, query = ''): Record<TaskSection, Task[]> {
  const q = fold(query.trim());
  const groups: Record<TaskSection, Task[]> = { attn: [], act: [], sch: [], done: [] };
  for (const task of tasks) if (!q || matches(task, q)) groups[sectionOf(task, now)].push(task);
  groups.attn.sort((a, b) => first('waiting')(a, b) || byPriority(a, b));
  groups.act.sort((a, b) => first('running')(a, b) || byPriority(a, b));
  groups.sch.sort((a, b) => (a.run_at ?? Infinity) - (b.run_at ?? Infinity) || byPriority(a, b));
  groups.done.sort((a, b) => (b.completed_at ?? b.updated_at) - (a.completed_at ?? a.updated_at));
  return groups;
}

export interface TaskSummary { attention: number; running: number; ready: number; scheduled: number }

export function summarize(tasks: readonly Task[], now: number): TaskSummary {
  const summary: TaskSummary = { attention: 0, running: 0, ready: 0, scheduled: 0 };
  for (const task of tasks) {
    const section = sectionOf(task, now);
    if (section === 'attn') summary.attention += 1;
    else if (section === 'sch') summary.scheduled += 1;
    else if (task.status === 'running') summary.running += 1;
    else if (section === 'act') summary.ready += 1;
  }
  return summary;
}

// 行の補足の 1 行。Markdown や改行は平らにして、長い本文も 1 行に収まる長さで切る。
export function plainLine(text: string | null | undefined, max = 160): string {
  if (!text) return '';
  const line = text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/^[\s#>*+-]+/gmu, '')
    .replace(/[*_`~]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return [...line].length > max ? `${[...line].slice(0, max).join('')}…` : line;
}

export type RowSub =
  | { kind: 'question'; text: string }
  | { kind: 'next'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'nextRun' }
  | { kind: 'none' };

export function rowSub(task: Task): RowSub {
  const some = (text: string, kind: 'question' | 'next' | 'text'): RowSub => (text ? { kind, text } : { kind: 'none' });
  if (task.status === 'waiting') return some(plainLine(task.waiting_text), 'question');
  if (isFinished(task.status)) return some(plainLine(task.result_summary), 'text');
  if (task.status === 'scheduled') return task.run_at !== null ? { kind: 'nextRun' } : some(plainLine(task.body), 'text');
  if (task.status === 'inbox') return some(plainLine(task.body), 'text');
  const next = plainLine(task.next_action);
  return next ? { kind: 'next', text: next } : some(plainLine(task.body), 'text');
}

export type QuickKind = 'run' | 'runNow' | 'stop' | 'retry';

// 行の右の 1 つ目のボタン。「止める」は、いまワーカーが実際に動かしている実行（runId のあるもの）にだけ出す。
export function quickOf(task: Task, runningHere: boolean, now: number): QuickKind | null {
  switch (task.status) {
    case 'ready': return task.run_at !== null && task.run_at > now ? 'runNow' : 'run';
    case 'scheduled': return 'runNow';
    case 'running': return runningHere ? 'stop' : null;
    case 'failed': return 'retry';
    default: return null;
  }
}

export type SheetAction = 'approve' | 'runNow' | 'retry' | 'done' | 'cancel';
export interface SheetActionSpec { action: SheetAction; primary: boolean }

// 詳細のシートの操作。デザインの並びに、終わったタスクをもう一度動かす操作（今の画面にあった）を足してある。
export function sheetActions(status: TaskStatus): SheetActionSpec[] {
  const spec = (action: SheetAction, primary = false): SheetActionSpec => ({ action, primary });
  switch (status) {
    case 'inbox': return [spec('approve', true), spec('cancel')];
    case 'ready': return [spec('runNow', true), spec('done'), spec('cancel')];
    case 'scheduled': return [spec('runNow', true), spec('cancel')];
    case 'running': return [spec('done'), spec('cancel')];
    case 'waiting': return [spec('done'), spec('cancel')];
    case 'failed':
    case 'done':
    case 'cancelled': return [spec('retry', status === 'failed')];
  }
}

export const ROW_ACTION_API = { approve: 'approve', skip: 'cancel', run: 'run-now', runNow: 'run-now', retry: 'run-now', done: 'done', cancel: 'cancel' } as const;
