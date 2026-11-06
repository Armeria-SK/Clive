import type { ReviewJob, RunRow, ToolCallRow } from './api.ts';
import type { IconName } from './icon-paths.ts';
import { formatList, formatNumber, t, type PlainKey } from './i18n/index.ts';

export type LogView = 'runs' | 'tools' | 'reviews';
export const LOG_VIEWS: readonly LogView[] = ['runs', 'tools', 'reviews'];

// 表の件数の上限（API に渡している limit と同じ）。これだけ出ているときは、古い分が隠れていると知らせる。
export const LOG_LIMIT = 200;

export type Tone = 'ok' | 'bad' | 'wait' | 'plain';
export interface Status { icon: IconName; tone: Tone; label: string }

const RUN_KIND: Record<string, PlainKey> = { chat: 'runs.kind.chat', task: 'runs.kind.task', review: 'runs.kind.review' };
const ERROR_KIND: Record<string, PlainKey> = {
  timeout: 'runs.error.timeout', rate_limit: 'runs.error.rate_limit', auth: 'runs.error.auth', context_overflow: 'runs.error.context_overflow',
  provider_error: 'runs.error.provider_error', cancelled: 'runs.error.cancelled', internal: 'runs.error.internal',
};
const DECISION: Record<ToolCallRow['decision'], PlainKey> = { allow: 'runs.decision.allow', ask: 'runs.decision.ask', deny: 'runs.decision.deny' };
const DECIDED_BY: Record<string, PlainKey> = {
  builtin: 'runs.by.builtin', registry: 'runs.by.registry', validation: 'runs.by.validation', user: 'runs.by.user', 'conversation-grant': 'runs.by.grant', recheck: 'runs.by.recheck', policy: 'runs.by.policy', 'auto-mode': 'runs.by.auto', mode: 'runs.by.mode', 'folder-grant': 'runs.by.folder',
};
const JOB_STATUS: Record<ReviewJob['status'], PlainKey> = {
  pending: 'runs.reviews.status.pending', running: 'runs.reviews.status.running', done: 'runs.reviews.status.done', failed: 'runs.reviews.status.failed',
};
const TRIGGER: Record<string, PlainKey> = {
  task: 'runs.reviews.trigger.task', idle: 'runs.reviews.trigger.idle', heavy_run: 'runs.reviews.trigger.heavy_run',
  book_full: 'runs.reviews.trigger.book_full', manual: 'runs.reviews.trigger.manual',
};
const CHANGE: Record<string, PlainKey> = {
  create: 'runs.reviews.change.create', update: 'runs.reviews.change.update', forget: 'runs.reviews.change.forget', restore: 'runs.reviews.change.restore',
};

// 知らない値（あとから増えた種類など）は、コードをそのまま出す。
export const runKindLabel = (kind: string): string => (RUN_KIND[kind] ? t(RUN_KIND[kind]) : kind);

export function runStatus(run: Pick<RunRow, 'ok' | 'error_kind'>): Status {
  if (run.ok === 1) return { icon: 'check', tone: 'plain', label: t('runs.result.ok') };
  if (run.ok === 0) return { icon: 'x', tone: 'bad', label: run.error_kind && ERROR_KIND[run.error_kind] ? t(ERROR_KIND[run.error_kind]!) : run.error_kind ?? t('runs.result.error') };
  return { icon: 'loader', tone: 'wait', label: t('runs.result.running') };
}

// 1000 以上は 3.2k のように短くする。
export const formatTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : formatNumber(n));

export function runSeconds(durationMs: number | null): string {
  return durationMs === null ? '—' : t('runs.secs', formatNumber(durationMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
}

// 成功は「入 3.2k · 出 412 · キャッシュ 1.1k」、失敗は理由のあとに試行の回数。見積もりと付いた印は、どちらにも付ける。
export function runDetail(run: RunRow): string {
  const parts: string[] = [];
  if (run.ok === 0) {
    parts.push(run.error_message ?? '');
    if (run.attempts > 0) parts.push(t('runs.detail.attempts', run.attempts));
  } else {
    if (run.input_tokens !== null) parts.push(t('runs.detail.in', formatTokens(run.input_tokens)));
    if (run.output_tokens !== null) parts.push(t('runs.detail.out', formatTokens(run.output_tokens)));
    if (run.cache_read_tokens) parts.push(t('runs.detail.cache', formatTokens(run.cache_read_tokens)));
    if (run.attempts > 1) parts.push(t('runs.detail.attempts', run.attempts));
  }
  if (run.est_prompt_tokens !== null) parts.push(t('runs.detail.est', formatTokens(run.est_prompt_tokens)));
  if (run.flags.length) parts.push(formatList(run.flags));
  return parts.filter(Boolean).join(' · ');
}

export const decisionLabel = (decision: ToolCallRow['decision']): string => (DECISION[decision] ? t(DECISION[decision]) : decision);

// 見た目の種類: 拒否は枠だけ、承認を求めたものは色付き、許可は目立たせない（デザインどおり）。
export const decisionTag = (decision: ToolCallRow['decision']): string =>
  (decision === 'deny' ? 'tag-outline' : decision === 'ask' ? 'tag-accent' : 'tag-neutral');

export function decidedByLabel(by: string): string {
  if (DECIDED_BY[by]) return t(DECIDED_BY[by]!);
  if (by.startsWith('hook:')) return t('runs.by.hook', by.slice('hook:'.length));
  return by;
}

export function toolStatus(ok: number | null): Status {
  if (ok === null) return { icon: 'clock', tone: 'wait', label: t('runs.toolResult.pending') };
  return ok === 1 ? { icon: 'check', tone: 'plain', label: t('runs.toolResult.ok') } : { icon: 'x', tone: 'bad', label: t('runs.toolResult.failed') };
}

export const jobStatusLabel = (status: ReviewJob['status']): string => t(JOB_STATUS[status]);
export const jobTriggerLabel = (trigger: string): string => (TRIGGER[trigger] ? t(TRIGGER[trigger]!) : trigger);
export const changeLabel = (action: string): string => (CHANGE[action] ? t(CHANGE[action]!) : action);

export const jobTag = (status: ReviewJob['status']): string =>
  (status === 'failed' ? 'tag-outline' : status === 'running' ? 'tag-accent' : 'tag-neutral');

export const logHash = (view: LogView): string => (view === 'runs' ? '#/runs' : `#/runs/${view}`);
