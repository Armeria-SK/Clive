import type { NewTask } from './api.ts';
import { parseZonedInput } from './i18n/format.ts';
import { WEEKDAYS } from './weekdays.ts';

// 「新しいタスク」のダイアログの、画面を使わない部分（入力 → サーバーに送る形、「〜に実行します」の要約）。

export type When = 'now' | 'at' | 'repeat';
export type Freq = 'daily' | 'weekday' | 'weekly' | 'hourly' | 'interval';
export const FREQS: readonly Freq[] = ['daily', 'weekday', 'weekly', 'hourly', 'interval'];
export const PRIORITIES = [1, 2, 3] as const;

export interface TaskDraft {
  title: string;
  body: string;
  priority: 1 | 2 | 3;
  when: When;
  at: string;
  freq: Freq;
  time: string;
  day: string;
  minute: string;
  interval: string;
}

export const emptyDraft = (): TaskDraft => ({
  title: '', body: '', priority: 2, when: 'now', at: '', freq: 'weekday', time: '09:00', day: WEEKDAYS[0].value, minute: '0', interval: '30',
});

export type DraftError = 'title' | 'at' | 'time' | 'minute' | 'interval';
export type BuildResult = { ok: true; task: NewTask } | { ok: false; error: DraftError };

const inRange = (text: string, min: number, max: number): boolean => /^\d+$/u.test(text.trim()) && Number(text) >= min && Number(text) <= max;
const validTime = (text: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/u.test(text.trim());
const TIMED: readonly Freq[] = ['daily', 'weekday', 'weekly'];

function scheduleError(draft: TaskDraft): Exclude<DraftError, 'title'> | null {
  if (draft.when === 'at' && parseZonedInput(draft.at) === null) return 'at';
  if (draft.when === 'repeat') {
    if (TIMED.includes(draft.freq) && !validTime(draft.time)) return 'time';
    if (draft.freq === 'hourly' && !inRange(draft.minute, 0, 59)) return 'minute';
    if (draft.freq === 'interval' && !inRange(draft.interval, 1, 59)) return 'interval';
  }
  return null;
}

export const draftError = (draft: TaskDraft): DraftError | null => (draft.title.trim() ? scheduleError(draft) : 'title');

// 日時の指定は、サーバーのタイムゾーンの時刻として読んで送る（ブラウザのタイムゾーンではない）。
// 繰り返しの曜日は、サーバーの読み取りと対になっている値（月〜日）のまま送る。
export function buildNewTask(draft: TaskDraft): BuildResult {
  const error = draftError(draft);
  if (error) return { ok: false, error };
  const body = draft.body.trim();
  const task: NewTask = { title: draft.title.trim(), priority: draft.priority, ...(body ? { body } : {}) };
  if (draft.when === 'at') task.when = new Date(parseZonedInput(draft.at)!).toISOString();
  if (draft.when === 'repeat') task.repeat = { freq: draft.freq, values: { time: draft.time, day: draft.day, minute: draft.minute, interval: draft.interval } };
  return { ok: true, task };
}

export type DraftSummary =
  | { kind: 'daily' | 'weekday'; time: string }
  | { kind: 'weekly'; day: string; time: string }
  | { kind: 'hourly'; minute: number }
  | { kind: 'interval'; every: number }
  | { kind: 'at'; ms: number };

// 「いつ」で決めた実行の時刻の要約。入力が足りないあいだは null（出さない）。
export function draftSummary(draft: TaskDraft): DraftSummary | null {
  if (draft.when === 'at') {
    const ms = parseZonedInput(draft.at);
    return ms === null ? null : { kind: 'at', ms };
  }
  if (draft.when !== 'repeat' || scheduleError(draft)) return null;
  switch (draft.freq) {
    case 'daily': return { kind: 'daily', time: draft.time };
    case 'weekday': return { kind: 'weekday', time: draft.time };
    case 'weekly': return { kind: 'weekly', day: draft.day, time: draft.time };
    case 'hourly': return { kind: 'hourly', minute: Number(draft.minute) };
    case 'interval': return { kind: 'interval', every: Number(draft.interval) };
  }
}
