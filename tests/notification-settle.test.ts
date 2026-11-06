import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { ProviderError } from '../src/providers/types.ts';
import type { Task } from '../src/tasks/store.ts';
import { createWebServer } from '../src/web/server.ts';
import { fail, FakeAdapter, reply, tempDir, type Script, testConfig } from './helpers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

function toolCall(name: string, args: unknown): Script {
  return async function* () {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

function prepare(t: { after: (fn: () => void) => void }) {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  config.worker.maxRunsPerHour = 100;
  writeFileSync(paths.config, JSON.stringify(config));
  return { dir, paths };
}

function open(paths: ReturnType<typeof resolvePaths>, databasePath = ':memory:') {
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath, log: () => undefined, now: () => clock.now, workerTimers: false, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  const events: RunEvent[] = [];
  app.bus.subscribe(e => events.push(e.event));
  return { app, clock, events, adapter: () => adapter };
}

async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const { paths } = prepare(t);
  const s = open(paths);
  await s.app.status.probeAll(s.app.config());
  const web = createWebServer(s.app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); s.app.close(); });
  const json = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };
  const rows = (kind: string, task: Pick<Task, 'id'>) =>
    s.app.db.prepare('SELECT id, read_at FROM notifications WHERE kind = ? AND link = ? ORDER BY id').all(kind, `#/tasks/${task.id}`) as Array<{ id: number; read_at: number | null }>;
  const readEvents = () => s.events.filter((e): e is Extract<RunEvent, { type: 'notification.read' }> => e.type === 'notification.read');
  const flood = (count: number) => { for (let i = 0; i < count; i++) s.app.notifications.notify({ kind: 'info', title: `info ${i}` }); };
  return { ...s, json, rows, readEvents, flood };
}

type Setup = Awaited<ReturnType<typeof setup>>;

// ── 承認 ──

for (const outcome of ['approved', 'denied', 'expired', 'cancelled'] as const) {
  test(`承認が片づいたら（${outcome}）、その承認の通知だけが既読になり、先頭から外れる。同じタスクのほかの承認・ほかのタスクの承認はそのまま`, async t => {
    const s = await setup(t);
    const withConversation = (title: string) => {
      const task = s.app.tasks.create({ title, origin: 'user', actor: 'user' });
      const conversation = s.app.conversations.create({ kind: 'task' });
      assert.ok(s.app.tasks.claim(task.id, 30 * MIN, conversation.id));
      return conversation.id;
    };
    const ask = (conversationId: string, timeoutMs = 60_000) => {
      const controller = new AbortController();
      const known = new Set(s.app.approvals.pending().map(p => p.id));
      void s.app.approvals.request({ runId: 'r', conversationId, tool: 'file_write', input: { path: 'x' }, title: 'Write', body: 'body', reasons: [], details: [] }, timeoutMs, controller.signal);
      const id = s.app.approvals.pending().find(p => !known.has(p.id))!.id;
      const noticeId = (s.app.db.prepare('SELECT id FROM notifications WHERE dedup_key = ?').get(`approval:${id}`) as { id: number }).id;
      const notice = () => s.app.db.prepare('SELECT id, read_at FROM notifications WHERE id = ?').get(noticeId) as { id: number; read_at: number | null };
      return { id, controller, notice };
    };
    const first = withConversation('first');
    const target = ask(first, outcome === 'expired' ? 20 : 60_000);
    const sameTask = ask(first);
    const otherTask = ask(withConversation('other'));
    assert.equal(s.app.notifications.unread(), 3);
    assert.deepEqual(s.app.notifications.list().slice(0, 3).map(n => n.kind), ['approval_needed', 'approval_needed', 'approval_needed']);

    if (outcome === 'approved') assert.ok(s.app.approvals.decide(target.id, 'once'));
    else if (outcome === 'denied') assert.ok(s.app.approvals.decide(target.id, 'deny'));
    else if (outcome === 'cancelled') target.controller.abort();
    else await new Promise(r => setTimeout(r, 60));

    const targetNotice = target.notice();
    assert.notEqual(targetNotice.read_at, null, '片づいた承認の通知は既読');
    assert.equal(sameTask.notice().read_at, null, '同じタスクのまだ待っている承認の通知はそのまま');
    assert.equal(otherTask.notice().read_at, null, 'ほかのタスクの承認の通知はそのまま');
    assert.equal(s.app.notifications.unread(), 2);
    assert.deepEqual(s.readEvents(), [{ type: 'notification.read', ids: [targetNotice.id], unread: 2 }], '画面へは既読になった id と未読の数を流す');

    s.flood(60);
    const pinned = s.app.notifications.list().filter(n => n.kind === 'approval_needed').map(n => n.id);
    assert.deepEqual(pinned, [otherTask.notice().id, sameTask.notice().id].sort((a, b) => b - a), '残るのは待っている 2 件だけ。片づいた古い通知は一覧から消える');
  });
}

// ── 返事待ち ──

test('返事待ちが片づいたら（答えた・取り消した）、そのタスクの質問と知らせ直しの通知が既読になる。ほかのタスクの通知と、同じタスクの別の種類の通知はそのまま', async t => {
  const s = await setup(t);
  const ask = async (title: string) => {
    const task = s.app.tasks.create({ title, origin: 'user', actor: 'user' });
    s.adapter().scripts.push(toolCall('ask_user', { question: `${title}？` }));
    assert.equal(await s.app.worker.tick(), 'ran');
    assert.equal(s.app.tasks.get(task.id)!.status, 'waiting');
    return task;
  };
  const answered = await ask('answered');
  const unrelated = await ask('unrelated');
  const cancelled = await ask('cancelled');
  s.clock.now += 13 * HOUR;
  assert.equal(await s.app.worker.tick(), 'idle');
  for (const task of [answered, unrelated, cancelled]) {
    assert.equal(s.rows('task_waiting', task).length, 2, '質問の通知と 12 時間後の知らせ直し');
    assert.ok(s.rows('task_waiting', task).every(n => n.read_at === null));
  }
  const done = s.app.notifications.notify({ kind: 'task_done', title: '別の種類', link: `#/tasks/${answered.id}`, dedupKey: 'done:answered' })!;
  assert.equal(s.readEvents().length, 0);

  assert.equal((await s.json(`/api/tasks/${answered.id}/answer`, 'POST', { text: 'はい' })).status, 200);
  const answeredIds = s.rows('task_waiting', answered).map(n => n.id);
  assert.ok(s.rows('task_waiting', answered).every(n => n.read_at !== null), '答えたら、質問も知らせ直しも既読');
  assert.ok(s.rows('task_waiting', unrelated).every(n => n.read_at === null), 'ほかのタスクはそのまま');
  assert.equal((s.app.db.prepare('SELECT read_at FROM notifications WHERE id = ?').get(done.id) as { read_at: number | null }).read_at, null, '同じタスクでも、返事待ち以外の通知は触らない');
  assert.deepEqual(s.readEvents(), [{ type: 'notification.read', ids: answeredIds, unread: 5 }]);

  assert.equal((await s.json(`/api/tasks/${cancelled.id}/cancel`, 'POST')).status, 200);
  assert.ok(s.rows('task_waiting', cancelled).every(n => n.read_at !== null), '取り消したら既読');
  assert.ok(s.rows('task_waiting', unrelated).every(n => n.read_at === null));

  s.flood(60);
  const pinned = s.app.notifications.list().filter(n => n.kind === 'task_waiting').map(n => n.id);
  assert.deepEqual(pinned, s.rows('task_waiting', unrelated).map(n => n.id).sort((a, b) => b - a), '一覧の先頭に残るのは、まだ答えていないタスクのものだけ');
});

// ── 失敗 ──

test('失敗したタスクをもう一度動かしたら、その失敗の通知が既読になる。ほかの失敗したタスクの通知はそのまま', async t => {
  const s = await setup(t);
  const failing = async (title: string) => {
    const task = s.app.tasks.create({ title, origin: 'user', actor: 'user' });
    for (let i = 0; i < 3; i++) {
      s.adapter().scripts.push(fail(new ProviderError('provider_error', 'boom', { retryable: false })));
      await s.app.worker.tick();
      s.clock.now += 10 * MIN;
    }
    assert.equal(s.app.tasks.get(task.id)!.status, 'failed');
    return task;
  };
  const retried = await failing('retried');
  const unrelated = await failing('unrelated');
  assert.equal(s.rows('task_failed', retried).length, 1);
  assert.equal(s.rows('task_failed', unrelated).length, 1);
  assert.equal(s.readEvents().length, 0);

  const unreadBefore = s.app.notifications.unread();
  assert.equal((await s.json(`/api/tasks/${retried.id}/run-now`, 'POST')).status, 202);
  assert.equal(s.app.tasks.get(retried.id)!.status, 'ready');
  assert.notEqual(s.rows('task_failed', retried)[0]!.read_at, null, 'もう一度動かしたら、失敗の通知は既読');
  assert.equal(s.rows('task_failed', unrelated)[0]!.read_at, null, 'ほかの失敗はそのまま');
  assert.deepEqual(s.readEvents(), [{ type: 'notification.read', ids: [s.rows('task_failed', retried)[0]!.id], unread: unreadBefore - 1 }]);

  s.flood(60);
  assert.deepEqual(s.app.notifications.list().filter(n => n.kind === 'task_failed').map(n => n.id), [s.rows('task_failed', unrelated)[0]!.id]);
});

test('失敗のタスクを直しても（題を変えるだけ）、まだ失敗のままなので通知は既読にならない', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'broken', origin: 'user', actor: 'user' });
  for (let i = 0; i < 3; i++) {
    s.adapter().scripts.push(fail(new ProviderError('provider_error', 'boom', { retryable: false })));
    await s.app.worker.tick();
    s.clock.now += 10 * MIN;
  }
  s.app.tasks.update(task.id, { title: 'broken 2' }, 'user');
  assert.equal(s.rows('task_failed', task)[0]!.read_at, null);
  assert.equal(s.readEvents().length, 0);
});

// ── 片づけたあとの同じ知らせ（24 時間の重ね止めに引っかからない）──

async function failThrough(s: Setup, task: Pick<Task, 'id'>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    s.adapter().scripts.push(fail(new ProviderError('provider_error', 'boom', { retryable: false })));
    await s.app.worker.tick();
    s.clock.now += 10 * MIN;
  }
  assert.equal(s.app.tasks.get(task.id)!.status, 'failed');
}

async function getStuck(s: Setup, task: Pick<Task, 'id'>): Promise<void> {
  for (const wait of [15 * MIN, 30 * MIN, 0]) {
    s.adapter().scripts.push(reply('考えました'));
    assert.equal(await s.app.worker.tick(), 'ran');
    s.clock.now += wait;
  }
  assert.equal(s.app.tasks.get(task.id)!.status, 'waiting');
}

const noticeEvents = (s: Setup) => s.events.filter(e => e.type === 'notification');

test('失敗の知らせが片づいたあと、24 時間以内にまた失敗したら、新しい知らせが未読で出て画面へも流れる', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'flaky', origin: 'user', actor: 'user' });
  const started = s.clock.now;
  await failThrough(s, task);
  assert.equal(s.rows('task_failed', task).length, 1);

  assert.equal((await s.json(`/api/tasks/${task.id}/run-now`, 'POST')).status, 202);
  assert.notEqual(s.rows('task_failed', task)[0]!.read_at, null);
  const sent = noticeEvents(s).length;

  await failThrough(s, task);
  const after = s.rows('task_failed', task);
  assert.equal(after.length, 2, '2 回目の失敗にも知らせが出る');
  assert.equal(after[1]!.read_at, null, '新しい知らせは未読');
  assert.equal(noticeEvents(s).length, sent + 1, '画面へも流れる');
  assert.equal(s.app.notifications.list()[0]!.id, after[1]!.id, '一覧の先頭に出る');
  assert.ok(s.clock.now - started < 24 * HOUR, '24 時間以内の出来事');
});

test('相談の知らせが片づいたあと、24 時間以内にまた行き詰まったら、新しい相談の知らせが未読で出て画面へも流れる', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'vague', origin: 'user', actor: 'user' });
  const started = s.clock.now;
  await getStuck(s, task);
  assert.equal(s.rows('task_waiting', task).length, 1);

  assert.equal((await s.json(`/api/tasks/${task.id}/answer`, 'POST', { text: 'こうして' })).status, 200);
  assert.notEqual(s.rows('task_waiting', task)[0]!.read_at, null);
  const sent = noticeEvents(s).length;

  await getStuck(s, task);
  const after = s.rows('task_waiting', task);
  assert.equal(after.length, 2, '2 回目の相談にも知らせが出る');
  assert.equal(after[1]!.read_at, null, '新しい知らせは未読');
  assert.equal(noticeEvents(s).length, sent + 1, '画面へも流れる');
  assert.ok(s.clock.now - started < 24 * HOUR, '24 時間以内の出来事');
});

test('持ち主が自分で読んだ知らせと、まだ片づいていない知らせは、これまでどおり 24 時間は同じ知らせを重ねない。承認の知らせの片づけ方は変わらない', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'dup', origin: 'user', actor: 'user' });
  const input = { kind: 'task_failed', title: 'f', link: `#/tasks/${task.id}`, dedupKey: `failed:${task.id}` } as const;
  const first = s.app.notifications.notify(input)!;
  assert.equal(s.app.notifications.notify(input), undefined, '未読のあいだは重ねない');
  s.app.notifications.markRead([first.id]);
  assert.equal(s.app.notifications.notify(input), undefined, '持ち主が読んだだけなら、重ねない');
  assert.equal(s.rows('task_failed', task).length, 1);
  assert.equal(s.readEvents().length, 0);

  const approval = s.app.notifications.notify({ kind: 'approval_needed', title: 'a', link: `#/tasks/${task.id}`, dedupKey: 'approval:fixed' })!;
  s.app.notifications.settle('approval_needed', { dedupKey: 'approval:fixed' });
  assert.notEqual(s.rows('approval_needed', task)[0]!.read_at, null, '承認の知らせは、これまでどおり既読になる');
  assert.deepEqual(s.readEvents(), [{ type: 'notification.read', ids: [approval.id], unread: 0 }]);
});

// ── 起動 ──

test('起動の時点で（settleStaleNotifications）、答えようのない大事な未読は既読にする（承認の札は再起動で無くなる／タスクがもうその状態ではない・もう無い）。まだ答えられるものは残す。App を作っただけでは触らない', async t => {
  const { dir, paths } = prepare(t);
  const databasePath = join(dir, 'clive.db');
  const first = open(paths, databasePath);
  const make = (title: string) => first.app.tasks.create({ title, origin: 'user', actor: 'user' });
  const stillWaiting = make('still waiting');
  first.app.tasks.setWaiting(stillWaiting.id, 'question', '？');
  const stillFailed = make('still failed');
  first.app.tasks.finish(stillFailed.id, 'failed', 'boom', 'worker');
  const answeredEarlier = make('answered earlier');
  const retriedEarlier = make('retried earlier');
  const notify = (kind: 'approval_needed' | 'task_waiting' | 'task_failed', task: Task, key: string) =>
    first.app.notifications.notify({ kind, title: key, link: `#/tasks/${task.id}`, dedupKey: key })!.id;
  const ids = {
    approval: notify('approval_needed', stillWaiting, 'approval:gone'),
    waiting: notify('task_waiting', stillWaiting, 'waiting:1'),
    failed: notify('task_failed', stillFailed, 'failed:1'),
    answered: notify('task_waiting', answeredEarlier, 'waiting:2'),
    retried: notify('task_failed', retriedEarlier, 'failed:2'),
    ghost: first.app.notifications.notify({ kind: 'task_failed', title: 'ghost', link: '#/tasks/no-such-task', dedupKey: 'failed:ghost' })!.id,
    elsewhere: first.app.notifications.notify({ kind: 'task_waiting', title: 'elsewhere', link: '#/tasks', dedupKey: 'waiting:list' })!.id,
  };
  first.app.close();

  // 一時フォルダを消す前に DB を閉じる（Windows では開いたままだと消せない）
  const second = open(paths, databasePath);
  try {
    const readAt = (id: number) => (second.app.db.prepare('SELECT read_at FROM notifications WHERE id = ?').get(id) as { read_at: number | null }).read_at;
    for (const id of Object.values(ids)) assert.equal(readAt(id), null, 'App を作っただけでは、何も既読にしない（doctor が動いているサーバーの通知を触らないため）');

    second.app.settleStaleNotifications();
    assert.notEqual(readAt(ids.approval), null, '承認の札は起動で全部無くなっている');
    assert.notEqual(readAt(ids.answered), null, 'もう返事待ちではないタスクの通知');
    assert.notEqual(readAt(ids.retried), null, 'もう失敗ではないタスクの通知');
    assert.notEqual(readAt(ids.ghost), null, 'タスクがもう無い失敗の通知');
    assert.equal(readAt(ids.waiting), null, '今も返事待ちのタスクの通知は残す');
    assert.equal(readAt(ids.failed), null, '今も失敗のタスクの通知は残す');
    assert.equal(readAt(ids.elsewhere), null, 'タスク 1 件を指さない通知（一覧へのリンク）は触らない');
    assert.deepEqual(second.app.notifications.list().filter(n => n.read_at === null).map(n => n.id), [ids.elsewhere, ids.failed, ids.waiting], '先頭に残るのも、その 3 件だけ');
    assert.ok(second.app.notifications.notify({ kind: 'task_failed', title: 'again', link: `#/tasks/${retriedEarlier.id}`, dedupKey: 'failed:2' }), '掃除で既読にした分は、同じ dedupKey の次の通知を止めない');
  } finally { second.app.close(); }
});
