import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import { defaultConfig } from '../src/config/store.ts';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { DEDUP_MS } from '../src/notify/notifications.ts';
import { resolvePaths } from '../src/paths.ts';
import { ProviderError } from '../src/providers/types.ts';
import { inQuietHours, taskPrompt } from '../src/tasks/worker.ts';
import { createWebServer } from '../src/web/server.ts';
import { fail, FakeAdapter, reply, tempDir, type Script } from './helpers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

function toolCall(name: string, args: unknown): Script {
  return async function* () {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

function hang(): Script {
  return async function* (req) {
    yield { type: 'text', delta: '調べています…' };
    await new Promise((_, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    });
  };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`待ちきれませんでした: ${label}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

async function setup(t: { after: (fn: () => void) => void }, edit: (c: AppConfig) => void = () => undefined) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = defaultConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  // 振り返りは tests/review.test.ts で確かめる（ここではタスクの実行回数を数えたいので止める）
  config.memory.review = false;
  edit(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') }; // 日本時間 11/5 05:00
  let adapter!: FakeAdapter;
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false,
    adapterOverride: p => (adapter = new FakeAdapter(p)),
  });
  await app.status.probeAll(app.config());
  const events: RunEvent[] = [];
  app.bus.subscribe(e => events.push(e.event));
  t.after(() => app.close());
  const userTask = (title: string, extra: Partial<Parameters<typeof app.tasks.create>[0]> = {}) =>
    app.tasks.create({ title, origin: 'user', actor: 'user', ...extra });
  return { app, adapter: () => adapter, clock, events, userTask };
}

// ── 予定と precheck ──

test('偽の時計で 24 時間進めても、やることが無ければモデルを 1 回も呼ばない', async t => {
  const s = await setup(t, c => { c.worker.autonomy = true; });
  const results = new Set<string>();
  for (let i = 0; i < 24 * 12; i++) {
    results.add(await s.app.worker.tick());
    s.clock.now += 5 * MIN;
  }
  assert.deepEqual([...results], ['idle']);
  assert.equal(s.adapter().calls.length, 0);
});

test('Asia/Tokyo の毎日 9 時の予定が、UTC の 0 時に 1 回だけ動く', async t => {
  const s = await setup(t);
  const template = s.userTask('朝のまとめ', { cron: '0 9 * * *', timezone: 'Asia/Tokyo' });
  assert.equal(template.status, 'scheduled');
  assert.equal(template.run_at, Date.parse('2026-11-05T00:00:00Z'));
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'まとめました', notify: false }));
  const ranAt: number[] = [];
  for (let i = 0; i < 24 * 12; i++) {
    if (await s.app.worker.tick() === 'ran') ranAt.push(s.clock.now);
    s.clock.now += 5 * MIN;
  }
  assert.deepEqual(ranAt.map(ms => new Date(ms).toISOString()), ['2026-11-05T00:00:00.000Z']);
  assert.equal(s.adapter().calls.length, 1, '完了の道具を呼んだら、モデルを呼び直さずに終える');
  const child = s.app.tasks.recentlyFinished()[0]!;
  assert.equal(child.parent_id, template.id);
  assert.equal(child.status, 'done');
  assert.equal(s.app.tasks.get(template.id)!.run_at, Date.parse('2026-11-06T00:00:00Z'), '次回は翌日');
  assert.equal(s.app.notifications.list().length, 0, 'notify=false なら知らせない');
});

test('前回分が終わっていなければ、予定から重ねて作らない', async t => {
  const s = await setup(t);
  const template = s.userTask('毎時の確認', { cron: '0 * * * *', timezone: 'UTC' });
  s.clock.now = template.run_at!;
  assert.equal(s.app.tasks.spawnDueSchedules().length, 1);
  s.clock.now += HOUR;
  assert.equal(s.app.tasks.spawnDueSchedules().length, 0);
  assert.ok(s.app.tasks.events(template.id).some(e => e.kind === 'skipped'));
});

test('自分で決めたタスクは、自発行動がオンで・操作が途切れて・静かな時間帯でないときだけ動く', async t => {
  const s = await setup(t, c => { c.worker.idleMinutes = 5; c.worker.quietStart = '23:00'; c.worker.quietEnd = '07:00'; });
  s.app.tasks.create({ title: '気になったことを調べる', origin: 'self', actor: 'clive' });
  assert.equal(await s.app.worker.tick(), 'idle', '自発行動がオフ');
  await s.app.applyConfig({ ...s.app.config(), worker: { ...s.app.config().worker, autonomy: true } });
  // 設定を保存するとプロバイダが作り直されるので、台本はその後に積む
  s.adapter().scripts.push(toolCall('task_complete', { summary: '調べました', notify: true }));
  assert.equal(await s.app.worker.tick(), 'idle', '日本時間 05:00 は静かな時間帯');
  s.clock.now = Date.parse('2026-11-05T00:00:00Z'); // 09:00
  s.app.engine.lastUserActivity = s.clock.now - 2 * MIN;
  assert.equal(await s.app.worker.tick(), 'idle', 'ユーザーが 2 分前に操作した');
  s.clock.now += 5 * MIN;
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.notifications.list()[0]?.kind, 'task_done');
});

test('「今すぐ実行」は自発行動がオフでも動く', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: '自分のメモ', origin: 'self', actor: 'clive' });
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'やりました' }));
  assert.equal(await s.app.worker.tick(), 'idle');
  s.app.worker.requestRun(task.id);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
});

test('一時停止中と、1 時間あたりの上限を超えたときは動かない', async t => {
  const s = await setup(t, c => { c.worker.maxRunsPerHour = 2; });
  for (let i = 0; i < 3; i++) s.userTask(`仕事${i}`);
  s.app.worker.setPaused(true);
  assert.equal(await s.app.worker.tick(), 'paused');
  s.app.worker.setPaused(false);
  s.adapter().scripts.push(toolCall('task_complete', { summary: '1' }), toolCall('task_complete', { summary: '2' }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(await s.app.worker.tick(), 'budget');
  assert.match(s.app.notifications.list()[0]?.title ?? '', /上限に達した/u, '上限で待たせていることを知らせる');
  // 「今すぐ実行」を頼まれたものは、上限に関係なく先に動く
  const urgent = s.userTask('急ぎ');
  s.app.worker.requestRun(urgent.id);
  s.adapter().scripts.push(toolCall('task_complete', { summary: '急ぎ' }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(urgent.id)!.status, 'done');
  assert.equal(await s.app.worker.tick(), 'budget');
  s.clock.now += HOUR + MIN;
  s.adapter().scripts.push(toolCall('task_complete', { summary: '3' }));
  assert.equal(await s.app.worker.tick(), 'ran');
});

test('静かな時間帯の判定（日付をまたぐ指定にも対応）', () => {
  const at = (iso: string) => Date.parse(iso);
  assert.equal(inQuietHours(at('2026-11-05T14:30:00Z'), 'Asia/Tokyo', '23:00', '07:00'), true); // 23:30
  assert.equal(inQuietHours(at('2026-11-04T21:59:00Z'), 'Asia/Tokyo', '23:00', '07:00'), true); // 06:59
  assert.equal(inQuietHours(at('2026-11-04T22:00:00Z'), 'Asia/Tokyo', '23:00', '07:00'), false); // 07:00
  assert.equal(inQuietHours(at('2026-11-05T04:00:00Z'), 'Asia/Tokyo', '12:00', '14:00'), true); // 13:00
  assert.equal(inQuietHours(at('2026-11-05T04:00:00Z'), 'Asia/Tokyo', '', ''), false);
});

// ── 実行の結果 ──

test('チャットが来るとタスクの実行を中断し、あとで続きから再開する（試行回数は数えない）', async t => {
  const s = await setup(t);
  const task = s.userTask('長い調べもの');
  s.adapter().scripts.push(hang(), reply('はい、どうぞ'));
  const ticking = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 1, 'タスクの実行が始まる');
  assert.equal(s.app.tasks.get(task.id)!.status, 'running');
  const chat = s.app.engine.send('c1', 'ちょっといい？');
  assert.ok(chat.ok);
  assert.equal(await ticking, 'ran');
  const after = s.app.tasks.get(task.id)!;
  assert.equal(after.status, 'ready');
  assert.equal(after.attempts, 0);
  assert.equal(after.run_at, s.clock.now + 2 * MIN);
  assert.match(s.app.tasks.events(task.id)[0]!.content ?? '', /優先/u);
  const chatResult = await s.app.engine.wait(chat.runId);
  assert.ok(!chatResult || chatResult.ok);

  s.clock.now += 3 * MIN;
  s.adapter().scripts.push(toolCall('task_complete', { summary: '調べ終えました' }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
  const resumed = s.adapter().calls[2]!.messages.filter(m => m.role === 'user');
  assert.equal(resumed.length, 2, '同じタスクの会話に続けて依頼文を足す（前の経過が見える）');
});

test('質問（ask_user）で返事待ちになり、通知が出る', async t => {
  const s = await setup(t);
  const task = s.userTask('資料を作る');
  s.adapter().scripts.push(toolCall('ask_user', { question: 'PDF と Markdown のどちらにしますか？' }));
  assert.equal(await s.app.worker.tick(), 'ran');
  const waiting = s.app.tasks.get(task.id)!;
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.waiting_text, 'PDF と Markdown のどちらにしますか？');
  assert.equal(s.app.notifications.list()[0]?.kind, 'task_waiting');
  assert.equal(await s.app.worker.tick(), 'idle', '返事が来るまで動かない');
  s.clock.now += 13 * HOUR;
  await s.app.worker.tick();
  assert.equal(s.app.notifications.list().filter(n => n.kind === 'task_waiting').length, 2, '長く待つとリマインドする');
  await s.app.worker.tick();
  assert.equal(s.app.notifications.list().filter(n => n.kind === 'task_waiting').length, 2, 'リマインドは重ねて出さない');
});

test('途中経過（task_checkpoint）を残すと、指定の時間まで休む', async t => {
  const s = await setup(t);
  const task = s.userTask('ビルドの確認');
  s.adapter().scripts.push(toolCall('task_checkpoint', { tried: 'ビルドした', result: '待ち', next_action: '結果を見る', resume_after_minutes: 30 }));
  assert.equal(await s.app.worker.tick(), 'ran');
  const rested = s.app.tasks.get(task.id)!;
  assert.equal(rested.status, 'ready');
  assert.equal(rested.next_action, '結果を見る');
  assert.equal(rested.run_at, s.clock.now + 30 * MIN);
  assert.match(rested.body, /試したこと: ビルドした/u);
  assert.equal(await s.app.worker.tick(), 'idle');
  s.clock.now += 31 * MIN;
  s.adapter().scripts.push(toolCall('task_complete', { summary: '成功' }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.match(taskPrompt(s.app.tasks.get(task.id)!, s.app.tasks.events(task.id), 'Asia/Tokyo'), /結果を見る/u);
});

test('失敗は時間をおいて再試行し、上限を超えたら失敗にして知らせる', async t => {
  const s = await setup(t);
  const task = s.userTask('壊れた仕事');
  const boom = () => fail(new ProviderError('provider_error', 'サーバーが落ちています', { retryable: false }));
  s.adapter().scripts.push(boom(), boom(), boom());
  assert.equal(await s.app.worker.tick(), 'ran');
  let now = s.app.tasks.get(task.id)!;
  assert.equal(now.attempts, 1); assert.equal(now.run_at, s.clock.now + MIN);
  s.clock.now += MIN;
  assert.equal(await s.app.worker.tick(), 'ran');
  now = s.app.tasks.get(task.id)!;
  assert.equal(now.attempts, 2); assert.equal(now.run_at, s.clock.now + 5 * MIN);
  s.clock.now += 5 * MIN;
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'failed');
  assert.equal(s.app.notifications.list()[0]?.kind, 'task_failed');
});

test('道具で終え方を決めないまま 3 回続いたら、ユーザーに相談する', async t => {
  const s = await setup(t);
  const task = s.userTask('ふわっとした仕事');
  for (let i = 0; i < 3; i++) s.adapter().scripts.push(reply(`考えました ${i}`));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.run_at, s.clock.now + 15 * MIN);
  s.clock.now += 15 * MIN;
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.run_at, s.clock.now + 30 * MIN, '休む時間を延ばす');
  s.clock.now += 30 * MIN;
  assert.equal(await s.app.worker.tick(), 'ran');
  const stuck = s.app.tasks.get(task.id)!;
  assert.equal(stuck.status, 'waiting');
  assert.match(stuck.waiting_text ?? '', /3 回/u);
  assert.match(stuck.body, /考えました 0/u, '返事はメモとして残す');
});

test('使えるモデルが無ければ実行せず、待ってから試す', async t => {
  const s = await setup(t);
  const task = s.userTask('仕事');
  s.adapter().probeResult = { status: 'unreachable', message: 'つながりません' };
  await s.app.status.probeAll(s.app.config());
  assert.equal(await s.app.worker.tick(), 'no_model');
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready');
  assert.equal(s.app.notifications.list()[0]?.kind, 'health_alert');
  assert.equal(s.adapter().calls.length, 0);
});

test('強制終了で running のまま残ったタスクは、起動時に ready に戻る', async t => {
  const s = await setup(t);
  const task = s.userTask('途中の仕事');
  const conv = s.app.conversations.create({ kind: 'task' });
  assert.ok(s.app.tasks.claim(task.id, 30 * MIN, conv.id));
  s.app.worker.start(); // リースが残っていても、前のプロセスの実行は続いていない
  s.app.worker.stop();
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready');
  assert.ok(s.app.tasks.events(task.id).some(e => e.kind === 'requeued'));
});

test('実行中に画面から取り消したら、その状態を尊重する', async t => {
  const s = await setup(t);
  const task = s.userTask('取り消される仕事');
  s.adapter().scripts.push(hang());
  const ticking = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 1, '実行が始まる');
  s.app.tasks.finish(task.id, 'cancelled', '取り消し', 'user');
  assert.ok(s.app.worker.stopTask(task.id));
  await ticking;
  assert.equal(s.app.tasks.get(task.id)!.status, 'cancelled');
});

// ── 道具・通知・画面 ──

test('会話の中で task_create を呼ぶと、メモ帳にタスクが増える（自発のものは承認制にできる）', async t => {
  const s = await setup(t, c => { c.worker.selfTasksNeedApproval = true; });
  s.adapter().scripts.push(
    toolCall('task_create', { title: '請求書をまとめる', requested_by_user: true, priority: 1 }),
    toolCall('task_create', { title: '気になった論文を読む' }),
    reply('メモしました'),
  );
  const outcome = s.app.engine.send('c1', '請求書をまとめておいて');
  assert.ok(outcome.ok);
  assert.ok((await s.app.engine.wait(outcome.runId))?.ok);
  const tasks = s.app.tasks.list();
  assert.deepEqual(tasks.map(t => [t.title, t.origin, t.status]), [['請求書をまとめる', 'user', 'ready'], ['気になった論文を読む', 'self', 'inbox']]);
  assert.ok(s.events.some(e => e.type === 'task.changed'));
  assert.ok(!s.adapter().calls[0]!.tools.some(t => t.name === 'task_complete'), '終え方の道具は会話では渡さない');
});

test('通知は同じ dedupKey なら 24 時間出さない', async t => {
  const s = await setup(t);
  assert.ok(s.app.notifications.notify({ kind: 'info', title: 'A', dedupKey: 'k' }));
  assert.equal(s.app.notifications.notify({ kind: 'info', title: 'A', dedupKey: 'k' }), undefined);
  s.clock.now += DEDUP_MS + 1;
  assert.ok(s.app.notifications.notify({ kind: 'info', title: 'A', dedupKey: 'k' }));
  assert.equal(s.app.notifications.unread(), 2);
  s.app.notifications.markRead();
  assert.equal(s.app.notifications.unread(), 0);
  assert.ok(s.events.some(e => e.type === 'notification'));
});

test('API: タスク・ワーカー・通知・プロフィール', async t => {
  const s = await setup(t);
  const web = createWebServer(s.app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(() => { web.server.closeAllConnections(); web.server.close(); });
  const api = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() as any };
  };

  const created = await api('/api/tasks', { title: '週報', repeat: { freq: 'weekly', values: { day: '金', time: '17:00' } } });
  assert.equal(created.status, 201);
  assert.equal(created.body.task.status, 'scheduled');
  assert.equal(created.body.task.cron_text, '毎週金曜 17:00');
  assert.equal((await api('/api/tasks', { title: '変な予定', repeat: { freq: 'weekly', values: { day: 'X' } } })).status, 400);

  const plain = await api('/api/tasks', { title: '本を返す', priority: 1, when: '2026-11-06T09:00:00+09:00' });
  assert.equal(plain.body.task.run_at, Date.parse('2026-11-06T00:00:00Z'));
  const id = plain.body.task.id as string;
  assert.equal((await api(`/api/tasks/${id}`, { nextAction: '図書館へ', when: null }, 'PATCH')).body.task.next_action, '図書館へ');
  const list = await api('/api/tasks');
  assert.equal(list.body.active.length, 2);
  assert.equal((await api(`/api/tasks/${id}/answer`, { text: 'はい' })).status, 409, '返事待ちではない');

  // 返事待ち → 回答 → 再開
  s.adapter().scripts.push(toolCall('ask_user', { question: 'いつ行く？' }));
  await s.app.worker.tick();
  assert.equal((await api(`/api/tasks/${id}`)).body.task.status, 'waiting');
  const answered = await api(`/api/tasks/${id}/answer`, { text: '明日の朝' });
  assert.equal(answered.body.task.status, 'ready');
  s.adapter().scripts.push(toolCall('task_complete', { summary: '返しました' }));
  assert.equal(await s.app.worker.tick(), 'ran');
  const detail = await api(`/api/tasks/${id}`);
  assert.equal(detail.body.task.status, 'done');
  assert.ok(detail.body.events.some((e: any) => e.kind === 'answer' && /明日の朝/u.test(e.content)));
  assert.match(JSON.stringify(s.adapter().calls.at(-1)!.messages), /明日の朝/u, '回答は次の依頼文に入る');

  // 予定の「今すぐ実行」は、実行用のタスクを作る
  const now = await api(`/api/tasks/${created.body.task.id}/run-now`, {});
  assert.equal(now.status, 202);
  assert.equal(now.body.task.origin, 'schedule');
  assert.equal((await api(`/api/tasks/${now.body.task.id}/cancel`, {})).body.task.status, 'cancelled');
  assert.equal((await api(`/api/tasks/${now.body.task.id}/cancel`, {})).status, 409);

  const worker = await api('/api/worker', { paused: true });
  assert.equal(worker.body.paused, true);
  assert.equal((await api('/api/worker', { autonomy: true })).body.autonomy, true);
  assert.equal(s.app.config().worker.autonomy, true, '設定ファイルにも保存する');

  const notes = await api('/api/notifications');
  assert.ok(notes.body.unread >= 1);
  assert.equal((await api('/api/notifications/read', {})).body.unread, 0);

  const profile = await api('/api/profile', { shape: 'droplet', color: '#112233', motion: 'sway', name: 'クライヴ' }, 'PATCH');
  assert.equal(profile.status, 200);
  assert.deepEqual([profile.body.name, profile.body.shape, profile.body.color, profile.body.motion], ['クライヴ', 'droplet', '#112233', 'sway']);
  assert.equal((await api('/api/profile', { shape: 'dragon' }, 'PATCH')).status, 400);
  assert.equal((await api('/api/profile', { color: 'red' }, 'PATCH')).status, 400);
  assert.equal(s.app.config().profile.shape, 'droplet');
});
