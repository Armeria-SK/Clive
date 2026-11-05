import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishedToday, isReadyNow, lastNoteOf, recentRuns, runOutcome, runsFraction, taskWhen, upNextTasks, UP_NEXT_LIMIT } from '../web/src/activity.ts';
import type { RunRow, Task, TaskEvent } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { ja } from '../web/src/i18n/ja.ts';

const NOW = Date.UTC(2026, 10, 5, 3, 0, 0);

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id, title: id, body: '', next_action: null, done_criteria: null, status: 'ready', origin: 'user', priority: 2, cron: null, cron_text: null,
    run_at: null, parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3,
    created_at: 1000, updated_at: 1000, completed_at: null, ...patch,
  };
}

function run(id: string, patch: Partial<RunRow> = {}): RunRow {
  return {
    id, kind: 'chat', conversation_id: null, model_id: 'm', attempts: 1, started_at: 1000, duration_ms: 2400, ok: 1, error_kind: null, error_message: null,
    input_tokens: null, output_tokens: null, cache_read_tokens: null, est_prompt_tokens: null, flags: [], ...patch,
  };
}

test('upNextTasks: 今すぐ動けるもの（優先度の高い順）→ 予定（日時の早い順）。動いているもの・返事待ち・提案・終わったものは出さない', () => {
  const tasks = [
    task('low', { priority: 3, created_at: 1 }),
    task('high-late', { priority: 1, created_at: 9 }),
    task('high-early', { priority: 1, created_at: 2 }),
    task('later', { status: 'scheduled', run_at: NOW + 7_200_000, cron_text: '毎日 09:00' }),
    task('soon', { status: 'scheduled', run_at: NOW + 3_600_000 }),
    task('ready-in-future', { status: 'ready', run_at: NOW + 1_800_000 }),
    task('past-run-at', { status: 'ready', run_at: NOW - 5000, priority: 2, created_at: 5 }),
    task('running', { status: 'running' }),
    task('waiting', { status: 'waiting' }),
    task('inbox', { status: 'inbox' }),
    task('done', { status: 'done' }),
  ];
  const all = upNextTasks(tasks, NOW, 99).map(t => t.id);
  assert.deepEqual(all, ['high-early', 'high-late', 'past-run-at', 'low', 'ready-in-future', 'soon', 'later']);
  assert.equal(upNextTasks(tasks, NOW).length, UP_NEXT_LIMIT, '既定は 4 件まで');
  assert.deepEqual(upNextTasks([], NOW), []);
  assert.equal(isReadyNow(task('a', { run_at: NOW + 1 }), NOW), false);
  assert.equal(isReadyNow(task('a', { run_at: NOW }), NOW), true, '日時ちょうどは動ける');
  assert.equal(isReadyNow(task('a', { status: 'scheduled' }), NOW), false);
});

test('taskWhen: すぐ動けるものは優先度、繰り返しはその説明、日時の予定は日時', () => {
  assert.deepEqual(taskWhen(task('a', { priority: 1 }), NOW), { kind: 'priority', priority: 1 });
  assert.deepEqual(taskWhen(task('a', { status: 'scheduled', cron_text: '毎週 月曜 09:00', run_at: NOW + 1000 }), NOW), { kind: 'cron', text: '毎週 月曜 09:00' });
  assert.deepEqual(taskWhen(task('a', { status: 'scheduled', run_at: NOW + 1000 }), NOW), { kind: 'at', at: NOW + 1000 });
  assert.deepEqual(taskWhen(task('a', { status: 'ready', run_at: NOW + 1000 }), NOW), { kind: 'at', at: NOW + 1000 }, '日時が先の実行待ちは日時');
  assert.deepEqual(taskWhen(task('a', { status: 'scheduled', priority: 3 }), NOW), { kind: 'priority', priority: 3 }, '日時も説明も無ければ優先度');
});

test('finishedToday: 今日（0 時から）に終わったものだけを、新しい順に', () => {
  const dayStart = Date.UTC(2026, 10, 4, 15, 0, 0);
  const finished = [
    task('yesterday', { status: 'done', completed_at: dayStart - 1 }),
    task('first', { status: 'done', completed_at: dayStart }),
    task('failed', { status: 'failed', completed_at: dayStart + 5000 }),
    task('no-time', { status: 'cancelled', completed_at: null }),
  ];
  assert.deepEqual(finishedToday(finished, dayStart).map(t => t.id), ['failed', 'first']);
  assert.deepEqual(finishedToday([], dayStart), []);
});

test('lastNoteOf: 実行中のタスクの最後のメモの最初の行（長ければ切る）', () => {
  const event = (id: number, kind: string, content: string | null): TaskEvent => ({ id, kind, actor: 'clive', content, run_id: null, created_at: id });
  assert.equal(lastNoteOf([]), '');
  assert.equal(lastNoteOf([event(1, 'created', '作った'), event(2, 'note', '  下調べを終えた\n続きは明日 ')]), '下調べを終えた');
  assert.equal(lastNoteOf([event(1, 'note', '古いメモ'), event(2, 'run', '実行した'), event(3, 'note', '')]), '古いメモ', '空のメモと、メモ以外の経過は飛ばす');
  assert.equal(lastNoteOf([event(1, 'question', '質問')]), '');
  assert.equal(lastNoteOf([event(1, 'note', 'あ'.repeat(130))]), `${'あ'.repeat(120)}…`);
  assert.equal(lastNoteOf([event(1, 'note', null)]), '');
});

test('recentRuns / runOutcome / runsFraction: 最近の実行 5 件、結果、1 時間の実行数の線', () => {
  const runs = Array.from({ length: 8 }, (_, i) => run(`r${i}`, { started_at: i * 1000 }));
  assert.deepEqual(recentRuns(runs).map(r => r.id), ['r7', 'r6', 'r5', 'r4', 'r3'], '新しい順に 5 件');
  assert.deepEqual(recentRuns(runs, 2).map(r => r.id), ['r7', 'r6']);
  assert.deepEqual(runOutcome(run('a', { ok: 1, duration_ms: 2449 })), { kind: 'ok', seconds: 2.4 });
  assert.deepEqual(runOutcome(run('a', { ok: 1, duration_ms: null })), { kind: 'ok', seconds: 0 });
  assert.deepEqual(runOutcome(run('a', { ok: 0, error_kind: 'cancelled' })), { kind: 'cancelled' });
  assert.deepEqual(runOutcome(run('a', { ok: 0, error_kind: 'provider_error' })), { kind: 'failed' });
  assert.deepEqual(runOutcome(run('a', { ok: null })), { kind: 'running' });
  assert.equal(runsFraction(3, 6), 50);
  assert.equal(runsFraction(9, 6), 100, '上限を超えても 100 まで');
  assert.equal(runsFraction(0, 0), 0, '上限が 0 のときは 0');
  assert.equal(runsFraction(-1, 6), 0);
});

test('辞書: 「いまの動き」の文字は ja と en の両方にあり、en は ja の写しではない', () => {
  const keys = Object.keys(ja).filter(k => /^(activity|run\.kind)\./u.test(k));
  assert.ok(keys.length >= 25, `${keys.length} 件しか読めていない`);
  for (const key of keys) {
    const jaEntry = (ja as Record<string, unknown>)[key];
    const enEntry = (en as Record<string, unknown>)[key];
    assert.equal(typeof enEntry, typeof jaEntry, key);
    if (typeof jaEntry === 'string') assert.notEqual(enEntry, jaEntry, `${key}: 訳し忘れ`);
  }
});
