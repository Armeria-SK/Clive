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

test('upNextTasks: サーバーの選び方（出どころ → 優先度 → 日時）に合わせ、そのあとに先の予定。自発行動がオフなら Clive 自身のタスクは出さない', () => {
  const tasks = [
    task('low', { priority: 3, created_at: 1 }),
    task('high-late', { priority: 1, created_at: 9 }),
    task('high-early', { priority: 1, created_at: 2 }),
    task('schedule-origin', { origin: 'schedule', priority: 1, created_at: 3 }),
    task('self-high', { origin: 'self', priority: 1, created_at: 1 }),
    task('curiosity', { origin: 'curiosity', priority: 1, created_at: 1 }),
    task('later', { status: 'scheduled', origin: 'schedule', run_at: NOW + 7_200_000, cron_text: '毎日 09:00' }),
    task('soon', { status: 'scheduled', origin: 'schedule', run_at: NOW + 3_600_000 }),
    task('ready-in-future', { status: 'ready', run_at: NOW + 1_800_000 }),
    task('past-run-at', { status: 'ready', run_at: NOW - 5000, priority: 2, created_at: 5 }),
    task('exhausted', { priority: 1, attempts: 3, max_attempts: 3 }),
    task('running', { status: 'running' }),
    task('waiting', { status: 'waiting' }),
    task('inbox', { status: 'inbox' }),
    task('done', { status: 'done' }),
  ];
  const off = upNextTasks(tasks, NOW, { allowSelf: false }, 99).map(t => t.id);
  assert.deepEqual(off, ['high-early', 'high-late', 'past-run-at', 'low', 'schedule-origin', 'ready-in-future', 'soon', 'later']);
  const on = upNextTasks(tasks, NOW, { allowSelf: true }, 99).map(t => t.id);
  assert.ok(on.includes('self-high') && on.includes('curiosity'), '自発行動がオンなら Clive 自身のタスクも動く');
  assert.ok(!off.includes('self-high') && !off.includes('curiosity'), '自発行動がオフなら出さない');
  assert.ok(!off.includes('exhausted') && !on.includes('exhausted'), '試行の上限に達したものは動かない');
  assert.ok(!on.includes('running') && !on.includes('waiting') && !on.includes('inbox') && !on.includes('done'));
  assert.equal(upNextTasks(tasks, NOW, { allowSelf: false }).length, UP_NEXT_LIMIT, '既定は 4 件まで');
  assert.deepEqual(upNextTasks([], NOW, { allowSelf: false }), []);
  assert.equal(isReadyNow(task('a', { run_at: NOW + 1 }), NOW), false);
  assert.equal(isReadyNow(task('a', { run_at: NOW }), NOW), true, '日時ちょうどは動ける');
  assert.equal(isReadyNow(task('a', { status: 'scheduled' }), NOW), false);
});

test('upNextTasks: 今すぐ動ける順は 出どころ（あなた → 予定 → Clive → 好奇心）→ 優先度 → 日時（無ければ作った順）、先の予定は日時の早い順', () => {
  const ids = (tasks: Task[], allowSelf = true) => upNextTasks(tasks, NOW, { allowSelf }, 99).map(t => t.id);
  assert.deepEqual(ids([
    task('curiosity-p1', { origin: 'curiosity', priority: 1 }),
    task('self-p1', { origin: 'self', priority: 1 }),
    task('schedule-p3', { origin: 'schedule', priority: 3 }),
    task('user-p3', { origin: 'user', priority: 3 }),
    task('user-p1', { origin: 'user', priority: 1 }),
  ]), ['user-p1', 'user-p3', 'schedule-p3', 'self-p1', 'curiosity-p1'], '優先度より出どころが先');
  assert.deepEqual(ids([
    task('b-late-run-at', { priority: 2, run_at: NOW - 1000, created_at: 1 }),
    task('a-early-run-at', { priority: 2, run_at: NOW - 9000, created_at: 9 }),
    task('c-created-first', { priority: 2, run_at: null, created_at: NOW - 20_000 }),
  ]), ['c-created-first', 'a-early-run-at', 'b-late-run-at'], '同じ優先度なら、日時（無ければ作った日時）の早い順');
  assert.deepEqual(ids([
    task('later-b', { status: 'scheduled', origin: 'schedule', run_at: NOW + 9000 }),
    task('later-a', { status: 'ready', run_at: NOW + 5000 }),
    task('now', { priority: 3 }),
  ]), ['now', 'later-a', 'later-b'], '今動けるものが先、そのあと先の予定を日時順');
  assert.deepEqual(ids([task('self-future', { origin: 'self', run_at: NOW + 5000 })], false), [], '自発行動がオフのとき、先の予定でも Clive 自身のものは出さない');
  assert.deepEqual(ids([task('scheduled-self-off', { status: 'scheduled', origin: 'schedule', run_at: NOW + 5000 })], false), ['scheduled-self-off'], '予定（schedule の出どころ）は自発行動に関係なく動く');
});

test('taskWhen: すぐ動けるものは優先度、繰り返しは説明と次の日時、日時の予定は日時', () => {
  assert.deepEqual(taskWhen(task('a', { priority: 1 }), NOW), { kind: 'priority', priority: 1 });
  assert.deepEqual(taskWhen(task('a', { status: 'scheduled', cron_text: '毎週 月曜 09:00', run_at: NOW + 1000 }), NOW), { kind: 'cron', text: '毎週 月曜 09:00', at: NOW + 1000 });
  assert.deepEqual(taskWhen(task('a', { status: 'scheduled', cron_text: '毎日', run_at: null }), NOW), { kind: 'cron', text: '毎日', at: null });
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
