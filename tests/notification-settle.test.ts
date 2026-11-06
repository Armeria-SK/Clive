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
import { fail, FakeAdapter, tempDir, type Script, testConfig } from './helpers.ts';

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
      const notice = () => s.app.db.prepare('SELECT id, read_at FROM notifications WHERE dedup_key = ?').get(`approval:${id}`) as { id: number; read_at: number | null };
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

// ── 起動 ──

test('起動の時点で、答えようのない大事な未読は既読にする（承認の札は再起動で無くなる／タスクがもうその状態ではない）。まだ答えられるものは残す', async t => {
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
  };
  first.app.close();

  // 一時フォルダを消す前に DB を閉じる（Windows では開いたままだと消せない）
  const second = open(paths, databasePath);
  try {
    const readAt = (id: number) => (second.app.db.prepare('SELECT read_at FROM notifications WHERE id = ?').get(id) as { read_at: number | null }).read_at;
    assert.notEqual(readAt(ids.approval), null, '承認の札は起動で全部無くなっている');
    assert.notEqual(readAt(ids.answered), null, 'もう返事待ちではないタスクの通知');
    assert.notEqual(readAt(ids.retried), null, 'もう失敗ではないタスクの通知');
    assert.equal(readAt(ids.waiting), null, '今も返事待ちのタスクの通知は残す');
    assert.equal(readAt(ids.failed), null, '今も失敗のタスクの通知は残す');
    assert.deepEqual(second.app.notifications.list().filter(n => n.read_at === null).map(n => n.id), [ids.failed, ids.waiting], '先頭に残るのも、その 2 件だけ');
  } finally { second.app.close(); }
});
