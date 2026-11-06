import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { ProviderError } from '../src/providers/types.ts';
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

async function setup(t: { after: (fn: () => void) => void }, edit: (c: ReturnType<typeof testConfig>) => void = () => undefined) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  edit(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  const linkOf = (kind: string) => app.notifications.list().find(n => n.kind === kind)?.link;
  return { app, adapter: () => adapter, clock, linkOf };
}

for (const language of ['ja', 'en'] as const) {
  test(`通知のリンクは、今ある画面だけを指す（${language}）`, async t => {
    const s = await setup(t, c => { c.language = language; c.worker.maxRunsPerHour = 100; });
    const all = () => s.app.notifications.list().map(n => n.link);

    // 終わった・質問・相談・失敗
    const done = s.app.tasks.create({ title: 'Done', origin: 'user', actor: 'user' });
    s.adapter().scripts.push(toolCall('task_complete', { summary: 'ok', notify: true }));
    await s.app.worker.tick();
    assert.equal(s.linkOf('task_done'), `#/tasks/${done.id}`);

    const asked = s.app.tasks.create({ title: 'Ask', origin: 'user', actor: 'user' });
    s.adapter().scripts.push(toolCall('ask_user', { question: 'q' }));
    await s.app.worker.tick();
    assert.equal(s.app.notifications.list().find(n => n.kind === 'task_waiting')?.link, `#/tasks/${asked.id}`);

    const failing = s.app.tasks.create({ title: 'Fail', origin: 'user', actor: 'user' });
    for (let i = 0; i < 3; i++) {
      s.adapter().scripts.push(fail(new ProviderError('provider_error', 'boom', { retryable: false })));
      await s.app.worker.tick();
      s.clock.now += 10 * MIN;
    }
    assert.equal(s.linkOf('task_failed'), `#/tasks/${failing.id}`);

    // 返事待ちの知らせ直し
    s.clock.now += 13 * HOUR;
    await s.app.worker.tick();
    const reminder = s.app.notifications.list().filter(n => n.kind === 'task_waiting');
    assert.ok(reminder.length >= 2 && reminder.every(n => n.link === `#/tasks/${asked.id}` || n.link?.startsWith('#/tasks/')), JSON.stringify(reminder.map(n => n.link)));

    // 承認が必要（タスクの実行中）
    const running = s.app.tasks.create({ title: 'Needs approval', origin: 'user', actor: 'user' });
    const conversation = s.app.conversations.create({ kind: 'task' });
    assert.ok(s.app.tasks.claim(running.id, 30 * MIN, conversation.id));
    const controller = new AbortController();
    void s.app.approvals.request({ runId: 'r', conversationId: conversation.id, tool: 'file_write', input: { path: 'x' }, title: 'Write', body: 'body', reasons: [], details: [] }, 60_000, controller.signal);
    assert.equal(s.linkOf('approval_needed'), `#/tasks/${running.id}`);
    controller.abort();

    // スキルの下書き
    s.app.skills.draft({ name: 'weekly-report', description: 'd', body: 'b', reason: 'r' });
    assert.equal(s.linkOf('info'), '#/skills/draft/weekly-report');
    s.app.skills.onDraft!({ id: 99, name: 'a b/é', description: 'd', body: 'b', reason: null, status: 'pending', conversation_id: null, run_id: null, created_at: 0, decided_at: null });
    const newest = s.app.notifications.list().reduce((a, b) => (b.id > a.id ? b : a));
    assert.equal(newest.link, `#/skills/draft/${encodeURIComponent('a b/é')}`, '名前は URL 用に符号化する');

    // モデルの不調
    for (let i = 0; i < 3; i++) s.app.bus.publish({ type: 'model.switch', runId: 'r', conversationId: 'c', from: 'm', to: 'n', reason: 'timeout' });
    assert.equal(s.linkOf('health_alert'), '#/settings');

    // 1 時間の上限・使えるモデルが無い（別の環境で起こす）
    const limited = await setup(t, c => { c.language = language; c.worker.maxRunsPerHour = 1; });
    limited.app.tasks.create({ title: 'First', origin: 'user', actor: 'user' });
    limited.adapter().scripts.push(toolCall('task_complete', { summary: 'ok', notify: false }));
    assert.equal(await limited.app.worker.tick(), 'ran');
    limited.app.tasks.create({ title: 'Waits', origin: 'user', actor: 'user' });
    assert.equal(await limited.app.worker.tick(), 'budget');
    assert.equal(limited.linkOf('info'), '#/tasks');

    const noModel = await setup(t, c => { c.language = language; });
    noModel.app.tasks.create({ title: 'Needs a model', origin: 'user', actor: 'user' });
    noModel.adapter().probeResult = { status: 'unreachable', message: 'x' };
    await noModel.app.status.probeAll(noModel.app.config());
    assert.equal(await noModel.app.worker.tick(), 'no_model');
    assert.equal(noModel.linkOf('health_alert'), '#/settings');

    const links = [...all(), ...limited.app.notifications.list().map(n => n.link), ...noModel.app.notifications.list().map(n => n.link)];

    // 最終的に出てくるリンクは、今ある画面だけ（#/review・#/today・#/curiosity・#/notifications は使わない。#/memory は整理の案の通知だけで、tests/memory-budget.test.ts で見る）
    const allowed = /^#\/(tasks(\/[0-9a-f-]{36})?|settings|skills\/draft\/[^/]+)$/u;
    for (const link of links) assert.match(link ?? '', allowed);
    assert.ok(!links.some(link => /#\/(review|today|curiosity|notifications)/u.test(link ?? '')));
    assert.deepEqual([...new Set(links.map(link => link!.replace(/[0-9a-f-]{36}/u, '<id>').replace(/skills\/draft\/.*/u, 'skills/draft/<name>')))].sort(), ['#/settings', '#/skills/draft/<name>', '#/tasks', '#/tasks/<id>']);
  });

  test(`持ち主への知らせはタスクを指し、同じ題は重ねない（${language}）`, async t => {
    const s = await setup(t, c => { c.language = language; c.worker.maxRunsPerHour = 100; });
    const task = s.app.tasks.create({ title: 'Notify', origin: 'user', actor: 'user' });
    s.adapter().scripts.push(toolCall('notify_owner', { title: '途中の知らせ' }));
    assert.equal(await s.app.worker.tick(), 'ran');
    const prefix = language === 'ja' ? 'Clive より: ' : 'From Clive: ';
    const first = s.app.notifications.list().find(n => n.kind === 'info');
    assert.equal(first?.link, `#/tasks/${task.id}`);
    assert.ok(first?.title.startsWith(prefix), first?.title);

    // 同じタスクで同じ題をもう一度出させても、行は増えない（24 時間に 1 回だけ）。タスクは進み方を決めずに終わったので 15 分後まで休む
    const before = s.app.notifications.list().filter(n => n.kind === 'info').length;
    s.clock.now += 16 * MIN;
    s.adapter().scripts.push(toolCall('notify_owner', { title: '途中の知らせ' }));
    assert.equal(await s.app.worker.tick(), 'ran');
    assert.equal(s.app.notifications.list().filter(n => n.kind === 'info').length, before);
  });
}
