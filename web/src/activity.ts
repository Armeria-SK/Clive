import type { RunRow, Task, TaskEvent } from './api.ts';

export const UP_NEXT_LIMIT = 4;
export const RECENT_RUNS_LIMIT = 5;
const NOTE_CHARS = 120;

// 今すぐ動ける実行待ち（日時の指定が無いか、もう過ぎている）
export const isReadyNow = (task: Task, now: number): boolean => task.status === 'ready' && (task.run_at === null || task.run_at <= now);

// 「次に動くタスク」: 今すぐ動けるもの（優先度の高い順）→ 予定（日時の早い順）。実行中・返事待ち・提案・終わったものは出さない。
export function upNextTasks(active: readonly Task[], now: number, limit = UP_NEXT_LIMIT): Task[] {
  const candidates = active.filter(t => t.status === 'ready' || t.status === 'scheduled');
  const when = (t: Task) => t.run_at ?? Number.MAX_SAFE_INTEGER;
  return [...candidates].sort((a, b) => {
    const aNow = isReadyNow(a, now);
    const bNow = isReadyNow(b, now);
    if (aNow !== bNow) return aNow ? -1 : 1;
    if (aNow) return a.priority - b.priority || a.created_at - b.created_at;
    return when(a) - when(b) || a.priority - b.priority;
  }).slice(0, limit);
}

export type TaskWhen = { kind: 'priority'; priority: number } | { kind: 'cron'; text: string } | { kind: 'at'; at: number };

export function taskWhen(task: Task, now: number): TaskWhen {
  if (isReadyNow(task, now)) return { kind: 'priority', priority: task.priority };
  if (task.cron_text) return { kind: 'cron', text: task.cron_text };
  return task.run_at ? { kind: 'at', at: task.run_at } : { kind: 'priority', priority: task.priority };
}

// 「今日終わったこと」: 今日（設定のタイムゾーンの 0 時から）に終わった・失敗した・取り消したタスク。新しい順。
export function finishedToday(finished: readonly Task[], dayStart: number): Task[] {
  return finished.filter(t => (t.completed_at ?? 0) >= dayStart).sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
}

// 実行中のタスクの「最後の経過」: 最後のメモ（task_checkpoint など）の最初の行。
export function lastNoteOf(events: readonly TaskEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    const text = event.kind === 'note' ? event.content?.trim().split(/\r?\n/u)[0]?.trim() : '';
    if (text) return [...text].length > NOTE_CHARS ? `${[...text].slice(0, NOTE_CHARS).join('')}…` : text;
  }
  return '';
}

export function recentRuns(runs: readonly RunRow[], limit = RECENT_RUNS_LIMIT): RunRow[] {
  return [...runs].sort((a, b) => b.started_at - a.started_at).slice(0, limit);
}

export type RunOutcome = { kind: 'running' } | { kind: 'ok'; seconds: number } | { kind: 'cancelled' } | { kind: 'failed' };

export function runOutcome(run: RunRow): RunOutcome {
  if (run.ok === 1) return { kind: 'ok', seconds: Math.round((run.duration_ms ?? 0) / 100) / 10 };
  if (run.ok === 0) return run.error_kind === 'cancelled' ? { kind: 'cancelled' } : { kind: 'failed' };
  return { kind: 'running' };
}

// この 1 時間の実行数の線の長さ（0〜100）
export function runsFraction(runs: number, max: number): number {
  return max > 0 ? Math.min(100, Math.max(0, (runs / max) * 100)) : 0;
}
