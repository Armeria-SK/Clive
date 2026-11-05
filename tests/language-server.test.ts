import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig, Language } from '../src/config/schema.ts';
import { defaultConfig } from '../src/config/store.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { ProviderError } from '../src/providers/types.ts';
import { describeCron } from '../src/tasks/schedule.ts';
import { TaskError } from '../src/tasks/store.ts';
import { createWebServer } from '../src/web/server.ts';
import { fail, FakeAdapter, reply, tempDir, type Script } from './helpers.ts';

const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;
const MIN = 60_000;

function toolCall(name: string, args: unknown): Script {
  return async function* () {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

function hang(): Script {
  return async function* (req) {
    yield { type: 'text', delta: 'working…' };
    await new Promise((_, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    });
  };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out: ${label}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

async function startApp(t: { after: (fn: () => void | Promise<void>) => void }, options: { language?: Language; edit?: (c: AppConfig) => void } = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = defaultConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  if (options.language) config.language = options.language;
  options.edit?.(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
  let adapter!: FakeAdapter;
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false,
    adapterOverride: provider => (adapter = new FakeAdapter(provider)),
  });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  return { app, paths, adapter: () => adapter, clock };
}

const noJapanese = (label: string, text: string | null | undefined) => assert.doesNotMatch(text ?? '', CJK, `${label}: ${text}`);

// ── 繰り返しの説明 ──

test('describeCron: 英語では英語で説明し、日本語は今までのまま', () => {
  const cases: Array<[string, string, string]> = [
    ['0 9 * * *', '毎日 09:00', 'Every day at 09:00'],
    ['0 9 * * MON-FRI', '平日 09:00', 'Weekdays at 09:00'],
    ['15 10 * * TUE', '毎週火曜 10:15', 'Every Tuesday at 10:15'],
    ['15 10 * * SUN', '毎週日曜 10:15', 'Every Sunday at 10:15'],
    ['5 * * * *', '毎時 5 分', 'Hourly at minute 5'],
    ['*/30 * * * *', '30 分ごと', 'Every 30 min'],
    ['0 0 1 * *', '0 0 1 * *', '0 0 1 * *'],
  ];
  for (const [cron, ja, en] of cases) {
    assert.equal(describeCron(cron), ja, cron);
    assert.equal(describeCron(cron, 'ja'), ja, cron);
    assert.equal(describeCron(cron, 'en'), en, cron);
  }
});

// ── タスクの経過・理由・通知を、作るときの言語で書く ──

test('タスクの経過と通知: language が en なら英語で書き、ja は今までの文のまま', async t => {
  for (const language of ['ja', 'en'] as const) {
    const s = await startApp(t, { language });
    const pick = <T>(ja: T, en: T): T => (language === 'ja' ? ja : en);

    const stopped = s.app.tasks.create({ title: language === 'ja' ? '止める仕事' : 'Stop me', origin: 'user', actor: 'user' });
    s.adapter().scripts.push(hang());
    const ticking = s.app.worker.tick();
    await waitFor(() => s.adapter().calls.length === 1, 'run starts');
    assert.ok(s.app.engine.stop(s.app.worker.status().running!.runId));
    await ticking;
    const requeued = s.app.tasks.events(stopped.id).find(e => e.kind === 'requeued')!;
    assert.equal(requeued.content, pick('止められたので、少し休んでから再開します', 'It was stopped, so it will rest for a short while and then resume'));

    s.clock.now += 20_000;
    s.adapter().scripts.push(toolCall('task_complete', { summary: language === 'ja' ? '終わった' : 'Finished', notify: true }));
    await s.app.worker.tick();
    const done = s.app.notifications.list()[0]!;
    assert.equal(done.kind, 'task_done');
    assert.equal(done.title, pick('タスク完了: 止める仕事', 'Task finished: Stop me'));

    const asked = s.app.tasks.create({ title: 'Q', origin: 'user', actor: 'user' });
    s.adapter().scripts.push(toolCall('ask_user', { question: language === 'ja' ? 'どうしますか' : 'What now?' }));
    await s.app.worker.tick();
    assert.equal(s.app.notifications.list()[0]!.title, pick('質問があります: Q', 'I have a question: Q'));
    assert.equal(s.app.tasks.get(asked.id)!.status, 'waiting');

    const retried = s.app.tasks.create({ title: 'R', origin: 'user', actor: 'user' });
    s.adapter().scripts.push(fail(new ProviderError('provider_error', 'boom', { retryable: false })));
    await s.app.worker.tick();
    const retry = s.app.tasks.events(retried.id).find(e => e.kind === 'requeued')!;
    assert.equal(retry.content, pick('失敗しました（boom）。1 分後にもう一度試します', 'It failed (boom). Will try again in 1 min'));

    const checkpoint = s.app.tasks.create({ title: 'C', origin: 'user', actor: 'user' });
    s.clock.now += 2 * MIN;
    s.adapter().scripts.push(toolCall('task_checkpoint', { tried: 'a', result: 'b', next_action: 'c', resume_after_minutes: 7 }));
    await s.app.worker.tick();
    assert.equal(s.app.tasks.events(checkpoint.id).find(e => e.kind === 'requeued')!.content, pick('7 分後に再開します', 'Will resume in 7 min'));
    if (language === 'en') for (const n of s.app.notifications.list()) { noJapanese('notification title', n.title); noJapanese('notification body', n.body); }
  }
});

test('タスクの相談: 3 回続けて決められなければ相談する（英語）', async t => {
  const s = await startApp(t, { language: 'en' });
  const task = s.app.tasks.create({ title: 'Vague job', origin: 'user', actor: 'user' });
  for (let i = 0; i < 3; i++) {
    s.adapter().scripts.push(reply(`thought ${i}`));
    await s.app.worker.tick();
    s.clock.now += 40 * MIN;
  }
  const stuck = s.app.tasks.get(task.id)!;
  assert.equal(stuck.status, 'waiting');
  assert.equal(stuck.waiting_text, 'I tried to work on "Vague job" 3 times but could not decide how to proceed. Please tell me what to do (cancel it if you would rather drop it)');
  assert.equal(s.app.notifications.list()[0]!.title, 'I need your advice: Vague job');
  assert.match(stuck.body, /- Note: thought 0/u);
});

test('実行の上限・使えるモデルが無いときの通知（英語）', async t => {
  const s = await startApp(t, { language: 'en', edit: c => { c.worker.maxRunsPerHour = 1; } });
  s.app.tasks.create({ title: 'One', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'ok', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  s.app.tasks.create({ title: 'Two', origin: 'user', actor: 'user' });
  assert.equal(await s.app.worker.tick(), 'budget');
  const budget = s.app.notifications.list().find(n => n.kind === 'info')!;
  assert.equal(budget.title, 'The hourly run limit was reached, so tasks are being held back for a while');
  assert.equal(budget.body, 'The limit is 1 runs per hour (worker.maxRunsPerHour in the settings). Urgent tasks can be started with "Run now"');
});

test('ワーカーの題・理由（英語）: 振り返りの会話の題と、モデルが無いときの待ち', async t => {
  const s = await startApp(t, { language: 'en', edit: c => { c.memory.review = true; } });
  await s.app.worker.tick();
  s.adapter().scripts.push(reply('hello'));
  const sent = s.app.engine.send('c1', 'hello');
  assert.ok(sent.ok);
  await s.app.engine.wait(sent.runId);
  s.app.reviews.enqueue('manual', 'manual:c1', { conversationId: 'c1' });
  s.adapter().scripts.push(reply('No changes'));
  await s.app.worker.tick();
  const titles = (s.app.db.prepare("SELECT title FROM conversations WHERE kind = 'task'").all() as Array<{ title: string }>).map(r => r.title);
  assert.deepEqual(titles, ['Review: Manual']);
  assert.equal(s.app.reviews.list()[0]!.note, 'No changes');

  const idle = s.app.tasks.create({ title: 'Needs a model', origin: 'user', actor: 'user' });
  s.adapter().probeResult = { status: 'unreachable', message: 'no connection' };
  await s.app.status.probeAll(s.app.config());
  assert.equal(await s.app.worker.tick(), 'no_model');
  assert.equal(s.app.notifications.list().find(n => n.kind === 'health_alert')!.title, 'No model is available to run the task');
  assert.match(s.app.tasks.events(idle.id).find(e => e.kind === 'requeued')!.content ?? '', /^Waiting because no model is available: /u);
});

test('モデルの不調の通知（英語）と、タスクの保存済みの経過は元の言語のまま', async t => {
  const s = await startApp(t, { language: 'ja' });
  const task = s.app.tasks.create({ title: 'A', origin: 'user', actor: 'user', propose: true });
  assert.equal(s.app.tasks.events(task.id)[0]!.content, '提案として作成');
  await s.app.applyConfig({ ...s.app.config(), language: 'en' });
  const proposal = s.app.tasks.create({ title: 'B', origin: 'user', actor: 'user', propose: true });
  assert.equal(s.app.tasks.events(proposal.id)[0]!.content, 'Created as a proposal');
  assert.equal(s.app.tasks.events(task.id)[0]!.content, '提案として作成', '言語を変える前に作られた経過は書き換えない');

  s.app.bus.publish({ type: 'model.switch', runId: 'r', conversationId: 'c', from: 'm', to: 'n', reason: 'timeout' });
  for (let i = 0; i < 2; i++) s.app.bus.publish({ type: 'model.switch', runId: 'r', conversationId: 'c', from: 'm', to: 'n', reason: 'timeout' });
  const alert = s.app.notifications.list().find(n => n.kind === 'health_alert')!;
  assert.equal(alert.title, 'Model "m" keeps failing (3 times)');
  assert.equal(alert.body, 'timeout\nFallback models will be tried first for 5 minutes.');
});

test('タスクの予定・復旧・エラー（英語）と、コード', async t => {
  const s = await startApp(t, { language: 'en' });
  const template = s.app.tasks.create({ title: 'Daily', origin: 'user', actor: 'user', cron: '0 9 * * *', timezone: 'UTC' });
  assert.equal(s.app.tasks.events(template.id)[0]!.content, 'Repeat: 0 9 * * *');
  const child = s.app.tasks.spawnNow(template.id)!;
  assert.equal(s.app.tasks.events(child.id)[0]!.content, 'Created from the schedule "Daily"');
  assert.equal(s.app.tasks.spawnNow(template.id), undefined);
  assert.equal(s.app.tasks.events(template.id)[0]!.content, 'The previous run has not finished yet, so none was created this time');

  const claimed = s.app.tasks.create({ title: 'Mid', origin: 'user', actor: 'user' });
  const conv = s.app.conversations.create({ kind: 'task' });
  assert.ok(s.app.tasks.claim(claimed.id, MIN, conv.id));
  s.app.tasks.recoverExpiredLeases({ all: true });
  assert.equal(s.app.tasks.events(claimed.id)[0]!.content, 'The previous run stopped midway, so it will run again');

  for (const make of [() => s.app.tasks.create({ title: ' ', origin: 'user', actor: 'user' }), () => s.app.tasks.approve(claimed.id)]) {
    try { make(); assert.fail('should throw'); } catch (error) {
      assert.ok(error instanceof TaskError);
      noJapanese('en text', error.text('en'));
      assert.match(error.message, CJK, 'message stays the Japanese text');
    }
  }
  const empty = new TaskError('error.empty_title');
  assert.equal(empty.fullCode, 'task.error.empty_title');
  assert.equal(empty.text('en'), 'The title is empty');
  assert.equal(empty.message, 'タイトルが空です');
  const missing = new TaskError('error.not_found', { id: 'abc' });
  assert.deepEqual(missing.params, { id: 'abc' });
  assert.equal(missing.text('en'), 'Task abc was not found');
});

test('API: タスクの操作の失敗は、コードとパラメータを添え、文は language で書く', async t => {
  const s = await startApp(t, { language: 'en' });
  const web = createWebServer(s.app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); });
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  const api = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, { ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Origin: origin } });

  const task = s.app.tasks.create({ title: 'Ready one', origin: 'user', actor: 'user' });
  const res = await api(`/api/tasks/${task.id}/approve`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 409);
  const body = await res.json() as any;
  assert.equal(body.error, 'task', 'the existing error code is unchanged');
  assert.equal(body.code, 'task.error.not_proposal');
  assert.equal(body.message, 'This is not a proposal waiting for approval');

  await s.app.applyConfig({ ...s.app.config(), language: 'ja' });
  const ja = await (await api(`/api/tasks/${task.id}/approve`, { method: 'POST', body: '{}' })).json() as any;
  assert.equal(ja.message, '承認待ちの提案ではありません');
  assert.equal(ja.code, 'task.error.not_proposal');

  const listed = await (await api('/api/tasks')).json() as any;
  assert.equal(listed.active.length, 1);
  const scheduled = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Every day', repeat: { freq: 'daily', values: { time: '09:00' } } }) });
  assert.equal(((await scheduled.json()) as any).task.cron_text, '毎日 09:00');
  await s.app.applyConfig({ ...s.app.config(), language: 'en' });
  const again = await (await api('/api/tasks')).json() as any;
  assert.equal(again.active.find((x: any) => x.title === 'Every day').cron_text, 'Every day at 09:00');
});
