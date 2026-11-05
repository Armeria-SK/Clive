import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Task, TaskStatus } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { setLanguagePreference, setTimezone, t } from '../web/src/i18n/index.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { parseRoute } from '../web/src/routes.ts';
import { buildNewTask, draftError, draftSummary, emptyDraft, type TaskDraft } from '../web/src/task-form.ts';
import {
  CURIOSITY_STATUS_KEY, eventKey, groupTasks, ORIGIN_KEY, plainLine, priorityKey, quickOf, ROW_ACTION_API, rowSub, sectionOf, sheetActions, STATUS_KEY, summarize,
} from '../web/src/task-meta.ts';
import { toTab } from '../web/src/tabs.ts';

const NOW = Date.UTC(2026, 10, 5, 3, 0, 0);
const reset = () => { setLanguagePreference('ja'); setTimezone('Asia/Tokyo'); };

let seq = 0;
function task(status: TaskStatus, patch: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`, title: `task ${seq}`, body: '', next_action: null, done_criteria: null, status, origin: 'user', priority: 2, cron: null, cron_text: null,
    run_at: null, parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3,
    created_at: NOW - 10_000, updated_at: NOW - 5_000, completed_at: null, ...patch,
  };
}
const ids = (tasks: Task[]) => tasks.map(x => x.id);

test('sectionOf: 返事待ち・提案は対応が必要、完了・失敗・取り消しは完了、日時指定と繰り返しは予定', () => {
  assert.equal(sectionOf(task('waiting'), NOW), 'attn');
  assert.equal(sectionOf(task('inbox'), NOW), 'attn');
  assert.equal(sectionOf(task('running'), NOW), 'act');
  assert.equal(sectionOf(task('ready'), NOW), 'act');
  assert.equal(sectionOf(task('ready', { run_at: NOW - 1 }), NOW), 'act', '開始の時刻を過ぎた実行待ちは、実行待ちの節');
  assert.equal(sectionOf(task('scheduled', { cron: '0 9 * * *' }), NOW), 'sch');
  assert.equal(sectionOf(task('ready', { run_at: NOW + 60_000 }), NOW), 'sch', '日時指定のタスク');
  for (const status of ['done', 'failed', 'cancelled'] as const) assert.equal(sectionOf(task(status), NOW), 'done');
});

test('止めたタスク（実行待ちで 20 秒後に開始）は予定に置かれ、20 秒たつと実行待ちの節に戻る', () => {
  const stopped = task('ready', { run_at: NOW + 20_000 });
  assert.equal(sectionOf(stopped, NOW), 'sch');
  assert.equal(sectionOf(stopped, NOW + 19_999), 'sch');
  assert.equal(sectionOf(stopped, NOW + 20_001), 'act');
});

test('groupTasks: 節ごとの並び（返事待ちが先、実行中が先、予定は近い順、完了は新しい順）', () => {
  const inbox = task('inbox', { priority: 1 });
  const waitingLow = task('waiting', { priority: 3 });
  const waitingHigh = task('waiting', { priority: 1 });
  const ready = task('ready', { priority: 1 });
  const running = task('running', { priority: 3 });
  const later = task('scheduled', { run_at: NOW + 2 * 3_600_000 });
  const sooner = task('ready', { run_at: NOW + 3_600_000 });
  const doneOld = task('done', { completed_at: NOW - 100_000 });
  const doneNew = task('failed', { completed_at: NOW - 1_000 });
  const groups = groupTasks([inbox, waitingLow, ready, running, later, doneOld, sooner, waitingHigh, doneNew], NOW);
  assert.deepEqual(ids(groups.attn), [waitingHigh.id, waitingLow.id, inbox.id], '返事待ちが先、同じ種類では優先度の高い順');
  assert.deepEqual(ids(groups.act), [running.id, ready.id], '実行中が先');
  assert.deepEqual(ids(groups.sch), [sooner.id, later.id], '次に動く順');
  assert.deepEqual(ids(groups.done), [doneNew.id, doneOld.id], '新しく終わった順');
});

test('groupTasks: 検索は題・詳細・次の一手・質問を、全角半角と大文字小文字を区別せずに探す', () => {
  const a = task('ready', { title: 'Weekly Report' });
  const b = task('ready', { title: 'x', body: 'ＡＢＣ の整理' });
  const c = task('waiting', { title: 'y', waiting_text: 'どの住所にしますか' });
  const d = task('ready', { title: 'z', next_action: 'send invoice' });
  const all = [a, b, c, d];
  assert.deepEqual(ids(groupTasks(all, NOW, 'weekly').act), [a.id]);
  assert.deepEqual(ids(groupTasks(all, NOW, 'abc').act), [b.id], '全角の ＡＢＣ も abc で見つかる');
  assert.deepEqual(ids(groupTasks(all, NOW, 'ＷＥＥＫＬＹ').act), [a.id], '全角で打っても半角の題が見つかる');
  assert.deepEqual(ids(groupTasks(all, NOW, '住所').attn), [c.id]);
  assert.deepEqual(ids(groupTasks(all, NOW, 'INVOICE').act), [d.id]);
  assert.equal(groupTasks(all, NOW, '  ').act.length, 3, '空白だけなら絞り込まない');
  assert.equal(groupTasks(all, NOW, 'nothing here').act.length, 0);
});

test('summarize: 対応が必要・実行中・実行待ち・予定の件数（終わったものは数えない）', () => {
  const list = [
    task('waiting'), task('inbox'), task('running'), task('ready'), task('ready', { run_at: NOW + 1_000 }),
    task('scheduled'), task('done'), task('failed'), task('cancelled'),
  ];
  assert.deepEqual(summarize(list, NOW), { attention: 2, running: 1, ready: 1, scheduled: 2 });
  assert.deepEqual(summarize([], NOW), { attention: 0, running: 0, ready: 0, scheduled: 0 });
});

test('plainLine: Markdown と改行を 1 行に平らにし、長いものは切る', () => {
  assert.equal(plainLine('## 結果\n- **3 件** 見つけた\n- [記事](https://example.com/a) を読んだ'), '結果 3 件 見つけた 記事 を読んだ');
  assert.equal(plainLine('前\n```js\nconst x = 1;\n```\n後'), '前 後', 'コードブロックは落とす');
  assert.equal(plainLine(null), '');
  assert.equal(plainLine(undefined), '');
  assert.equal(plainLine('a'.repeat(300), 10), `${'a'.repeat(10)}…`);
  assert.equal(plainLine('あ'.repeat(5), 3), 'あああ…', '文字数で切る');
});

test('rowSub: 状態ごとに行の補足を選ぶ（質問・次の一手・結果・本文・次回）', () => {
  assert.deepEqual(rowSub(task('waiting', { waiting_text: 'どちらにしますか', body: 'x' })), { kind: 'question', text: 'どちらにしますか' });
  assert.deepEqual(rowSub(task('done', { result_summary: '## 要約\n終わった', body: 'x' })), { kind: 'text', text: '要約 終わった' });
  assert.deepEqual(rowSub(task('failed', { result_summary: null })), { kind: 'none' });
  assert.deepEqual(rowSub(task('inbox', { body: '理由はこれ', next_action: 'n' })), { kind: 'text', text: '理由はこれ' });
  assert.deepEqual(rowSub(task('ready', { next_action: '手順を考える', body: 'b' })), { kind: 'next', text: '手順を考える' });
  assert.deepEqual(rowSub(task('ready', { body: 'b' })), { kind: 'text', text: 'b' });
  assert.deepEqual(rowSub(task('scheduled', { run_at: NOW + 1 })), { kind: 'nextRun' });
  assert.deepEqual(rowSub(task('scheduled', { body: 'b' })), { kind: 'text', text: 'b' });
});

test('quickOf: 行の右のボタン。「止める」は、ワーカーがいま動かしているタスクにだけ出す', () => {
  assert.equal(quickOf(task('ready'), false, NOW), 'run');
  assert.equal(quickOf(task('ready', { run_at: NOW + 5_000 }), false, NOW), 'runNow');
  assert.equal(quickOf(task('scheduled'), false, NOW), 'runNow');
  assert.equal(quickOf(task('running'), true, NOW), 'stop');
  assert.equal(quickOf(task('running'), false, NOW), null, '実行中でもワーカーの実行でなければ止められない');
  assert.equal(quickOf(task('failed'), false, NOW), 'retry');
  for (const status of ['waiting', 'inbox', 'done', 'cancelled'] as const) assert.equal(quickOf(task(status), false, NOW), null);
});

test('sheetActions: 状態ごとの操作（デザインの並び + 終わったタスクをもう一度動かす）', () => {
  const names = (status: TaskStatus) => sheetActions(status).map(a => a.action);
  assert.deepEqual(names('inbox'), ['approve', 'cancel']);
  assert.deepEqual(names('ready'), ['runNow', 'done', 'cancel']);
  assert.deepEqual(names('scheduled'), ['runNow', 'cancel']);
  assert.deepEqual(names('running'), ['done', 'cancel']);
  assert.deepEqual(names('waiting'), ['done', 'cancel']);
  assert.deepEqual(names('failed'), ['retry']);
  assert.deepEqual(names('done'), ['retry']);
  assert.deepEqual(names('cancelled'), ['retry']);
  assert.equal(sheetActions('ready').filter(a => a.primary).length, 1, '主な操作は 1 つ');
  for (const status of ['inbox', 'ready', 'scheduled', 'running', 'waiting', 'failed', 'done', 'cancelled'] as const) {
    for (const { action } of sheetActions(status)) assert.ok(Object.hasOwn(ROW_ACTION_API, action), `${action} に対応する API の操作が無い`);
  }
});

test('操作と API: 見送りは取り消し、実行・今すぐ・もう一度は run-now に送る（取り消しを戻す操作は無い）', () => {
  assert.deepEqual(ROW_ACTION_API, { approve: 'approve', skip: 'cancel', run: 'run-now', runNow: 'run-now', retry: 'run-now', done: 'done', cancel: 'cancel' });
});

test('buildNewTask: 今すぐは題と優先度だけ（空の詳細は送らない）。題が空なら作れない', () => {
  const draft: TaskDraft = { ...emptyDraft(), title: '  来週の予定を整理する  ', body: '   ', priority: 1 };
  assert.deepEqual(buildNewTask(draft), { ok: true, task: { title: '来週の予定を整理する', priority: 1 } });
  assert.deepEqual(buildNewTask({ ...draft, body: ' 詳細 ' }), { ok: true, task: { title: '来週の予定を整理する', priority: 1, body: '詳細' } });
  assert.deepEqual(buildNewTask({ ...draft, title: '   ' }), { ok: false, error: 'title' });
});

test('buildNewTask: 日時の指定は、ブラウザではなくサーバーのタイムゾーンの時刻として読んで送る', () => {
  const draft: TaskDraft = { ...emptyDraft(), title: 'x', when: 'at', at: '2026-11-06T09:00' };
  reset();
  assert.deepEqual(buildNewTask(draft), { ok: true, task: { title: 'x', priority: 2, when: '2026-11-06T00:00:00.000Z' } }, '東京の 9 時は 0 時 UTC');
  setTimezone('America/New_York');
  assert.deepEqual(buildNewTask(draft), { ok: true, task: { title: 'x', priority: 2, when: '2026-11-06T14:00:00.000Z' } }, 'ニューヨークの 9 時は 14 時 UTC');
  assert.deepEqual(buildNewTask({ ...draft, at: '' }), { ok: false, error: 'at' });
  assert.deepEqual(buildNewTask({ ...draft, at: '2026-02-30T10:00' }), { ok: false, error: 'at' });
  reset();
});

test('buildNewTask: 繰り返しは頻度と値を送る。曜日の値はサーバーが読む日本語のまま（en の画面でも）', () => {
  const draft: TaskDraft = { ...emptyDraft(), title: 'weekly report', when: 'repeat', freq: 'weekly', time: '17:30', day: '金' };
  for (const lang of ['ja', 'en'] as const) {
    setLanguagePreference(lang);
    const built = buildNewTask(draft);
    assert.ok(built.ok);
    assert.deepEqual(built.task.repeat, { freq: 'weekly', values: { time: '17:30', day: '金', minute: '0', interval: '30' } }, `${lang} でも曜日は金のまま`);
  }
  reset();
});

test('draftError: 繰り返しの時刻・分・間隔の入力を確かめる', () => {
  const base: TaskDraft = { ...emptyDraft(), title: 'x', when: 'repeat' };
  assert.equal(draftError({ ...base, freq: 'daily', time: '' }), 'time');
  assert.equal(draftError({ ...base, freq: 'weekday', time: '24:00' }), 'time');
  assert.equal(draftError({ ...base, freq: 'weekly', time: '09:00' }), null);
  assert.equal(draftError({ ...base, freq: 'hourly', minute: '60' }), 'minute');
  assert.equal(draftError({ ...base, freq: 'hourly', minute: '-1' }), 'minute');
  assert.equal(draftError({ ...base, freq: 'hourly', minute: '0' }), null);
  assert.equal(draftError({ ...base, freq: 'interval', interval: '0' }), 'interval');
  assert.equal(draftError({ ...base, freq: 'interval', interval: '60' }), 'interval');
  assert.equal(draftError({ ...base, freq: 'interval', interval: '1' }), null, 'サーバーは 1 分から受け付ける');
  assert.equal(draftError({ ...base, freq: 'interval', interval: 'abc' }), 'interval');
  assert.equal(draftError({ ...base, freq: 'hourly', minute: '99', when: 'now' }), null, '繰り返しでなければ見ない');
});

test('draftSummary: 「〜に実行します」の要約の元になる値（入力が足りなければ null）', () => {
  const base: TaskDraft = { ...emptyDraft(), title: 'x', when: 'repeat' };
  assert.deepEqual(draftSummary({ ...base, freq: 'daily', time: '08:15' }), { kind: 'daily', time: '08:15' });
  assert.deepEqual(draftSummary({ ...base, freq: 'weekday', time: '09:00' }), { kind: 'weekday', time: '09:00' });
  assert.deepEqual(draftSummary({ ...base, freq: 'weekly', time: '09:00', day: '水' }), { kind: 'weekly', day: '水', time: '09:00' });
  assert.deepEqual(draftSummary({ ...base, freq: 'hourly', minute: '15' }), { kind: 'hourly', minute: 15 });
  assert.deepEqual(draftSummary({ ...base, freq: 'interval', interval: '30' }), { kind: 'interval', every: 30 });
  assert.equal(draftSummary({ ...base, freq: 'daily', time: '' }), null);
  assert.equal(draftSummary({ ...base, when: 'now' }), null);
  reset();
  assert.deepEqual(draftSummary({ ...base, when: 'at', at: '2026-11-06T09:00' }), { kind: 'at', ms: Date.UTC(2026, 10, 6, 0, 0) });
  assert.equal(draftSummary({ ...base, when: 'at', at: '' }), null);
});

test('#/curiosity は、タスクの「気になること」の節を開く経路（タブはタスクの 1 つ）', () => {
  assert.deepEqual(parseRoute('#/curiosity'), { page: 'tasks', taskId: null, section: 'curiosity' });
  assert.deepEqual(parseRoute('#/tasks'), { page: 'tasks', taskId: null }, '普通のタスクの経路には節の指定が付かない');
  assert.deepEqual(toTab('#/curiosity'), { key: 'tasks', hash: '#/tasks' });
});

test('辞書: 状態・出どころ・優先度・経過の種類・気になることの状態は、ja にも en にもある', () => {
  const keys = [
    ...Object.values(STATUS_KEY), ...Object.values(ORIGIN_KEY), ...Object.values(CURIOSITY_STATUS_KEY),
    priorityKey(1), priorityKey(2), priorityKey(3), priorityKey(9),
    ...['created', 'note', 'requeued', 'question', 'approval', 'answer', 'run', 'done', 'failed', 'cancelled', 'approved', 'reopened', 'skipped', 'edited', 'context'].map(kind => eventKey(kind)!),
  ];
  for (const key of keys) {
    assert.equal(typeof (ja as Record<string, unknown>)[key], 'string', `${key} が ja に無い`);
    assert.equal(typeof (en as Record<string, unknown>)[key], 'string', `${key} が en に無い`);
  }
  assert.equal(eventKey('something-new'), null, '知らない種類は辞書を引かない（そのまま出す）');
  assert.equal(priorityKey(9), priorityKey(2), '範囲外の優先度は「中」');
});

test('辞書: タスク画面（stage 7）の英語に日本語が混ざらない。ja と同じ文のままの訳し忘れも無い', () => {
  const mine = Object.keys(en).filter(key => /^(tasks|newtask|curiosity)\./u.test(key));
  assert.ok(mine.length > 100, `タスク画面の文字が ${mine.length} 件しか読めていない`);
  const japanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const same: string[] = [];
  for (const key of mine) {
    const enEntry = (en as Record<string, unknown>)[key];
    const jaEntry = (ja as Record<string, unknown>)[key];
    const enText = typeof enEntry === 'function' ? (enEntry as (...a: string[]) => string)('a', 'b') : String(enEntry);
    assert.ok(!japanese.test(enText), `${key}: 英語に日本語が混ざっている: ${enText}`);
    if (typeof jaEntry === 'string' && jaEntry === enEntry) same.push(key);
  }
  const allowedSame = ['newtask.priority.2', 'tasks.origin.self'];
  assert.deepEqual(same.filter(key => !allowedSame.includes(key)), [], '訳し忘れ（ja と同じ文字のまま）');
});

test('辞書: 止めたあとの案内は 20 秒ほどで再開すること、止め続ける方法（取り消す・一時停止）を伝える', () => {
  reset();
  assert.match(t('tasks.stopHint'), /20 秒.*再開/u);
  assert.match(t('tasks.stopHint'), /取り消す/u);
  assert.match(t('tasks.stopHint'), /一時停止/u);
  assert.match(t('tasks.toast.stoppedBody'), /20秒/u);
  setLanguagePreference('en');
  assert.match(t('tasks.stopHint'), /20 seconds/u);
  assert.match(t('tasks.stopHint'), /cancel/iu);
  assert.match(t('tasks.stopHint'), /pause the worker/iu);
  reset();
});
