import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { ProviderError } from '../src/providers/types.ts';
import { fail, FakeAdapter, reply, tempDir, type Script, testConfig } from './helpers.ts';

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

async function setup(t: { after: (fn: () => void) => void }, options: { maxIterations?: number; language?: 'ja' | 'en' } = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  config.tools.maxIterations = options.maxIterations ?? 16;
  if (options.language) config.language = options.language;
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  const events: RunEvent[] = [];
  app.bus.subscribe(e => events.push(e.event));
  t.after(() => app.close());
  const chat = async (text: string, conversationId = 'c1') => {
    const outcome = app.engine.send(conversationId, text);
    assert.ok(outcome.ok, JSON.stringify(outcome));
    const result = await app.engine.wait(outcome.runId)!;
    return { runId: outcome.runId, result };
  };
  return { app, adapter: () => adapter, events, chat, clock };
}

const WRAP = 'ここまでにやったこと:\n- a.md を 2 回書いた\n\n次の一手:\nb.md を確かめてから、c.md を書く';
const fallbackJa = (max: number) => `道具の上限（${max} 回）に達したので止めました。続けるなら「続けて」と送ってください`;

// ── 6b: 上限に達したら、まとめを返事として保存する ──

test('上限に達したら、道具なしで 1 回だけモデルを呼び、ここまで・次の一手のまとめを返事として保存する。お知らせと印も残る', async t => {
  const s = await setup(t, { maxIterations: 2 });
  s.adapter().scripts.push(toolCall('file_write', { path: 'a.md', content: '1' }), toolCall('file_write', { path: 'a.md', content: '2' }), reply(WRAP));
  const { runId, result } = await s.chat('続きをやって');
  assert.ok(result.ok);
  assert.equal(result.text, WRAP);
  assert.deepEqual(s.app.conversations.messages('c1').map(m => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
  assert.equal(s.app.conversations.messages('c1').at(-1)!.text, WRAP, 'まとめが会話の返事として記録に残る');
  const calls = s.adapter().calls;
  assert.equal(calls.length, 3, '道具の往復 2 回 + まとめの 1 回');
  assert.deepEqual(calls[2]!.tools, [], 'まとめの呼び出しに道具は渡さない');
  const prompt = calls[2]!.messages;
  assert.deepEqual(prompt.map(m => m.role), ['user'], '道具の呼び出しの履歴は文字の記録にして 1 通で渡す（道具の定義が要らない）');
  assert.match((prompt[0] as { content: string }).content, /続きをやって[\s\S]*a\.md/u, '直近のやり取りが入る');
  assert.match((prompt[0] as { content: string }).content, /ここまでにやったこと[\s\S]*次の一手/u, '何を書かせるかの指示が入る');
  assert.ok(s.events.some(e => e.type === 'warning' && e.code === 'max_iterations'), '画面のお知らせも残す');
  const run = s.app.runs.get(runId)!;
  assert.deepEqual([run.ok, JSON.parse(run.flags)], [1, ['max_iterations']]);
  assert.ok(s.events.some(e => e.type === 'message.saved' && e.runId === runId && e.role === 'assistant'));
});

test('まとめを書かせても空・失敗・取り消しなら、決まった文を返事として保存する（日本語・英語）', async t => {
  for (const [label, last] of [['空', reply('   ')], ['失敗', fail(new ProviderError('provider_error', 'boom', { retryable: false }))]] as const) {
    const s = await setup(t, { maxIterations: 1 });
    s.adapter().scripts.push(toolCall('file_write', { path: 'a.md', content: '1' }), last);
    const { result } = await s.chat('やって');
    assert.ok(result.ok, label);
    assert.equal(result.text, fallbackJa(1), label);
    assert.equal(s.app.conversations.messages('c1').at(-1)!.text, fallbackJa(1), `${label}: 決まった文が記録に残る`);
  }
  const en = await setup(t, { maxIterations: 1, language: 'en' });
  en.adapter().scripts.push(toolCall('file_write', { path: 'a.md', content: '1' }), reply(''));
  const { result } = await en.chat('do it');
  assert.equal(result.text, 'Stopped because the tool-call limit (1) was reached. Send "continue" if you want it to keep going');
  assert.doesNotMatch(result.text, /[぀-ヿ一-鿿]/u);
});

test('上限でない普通の終わりでは、まとめの呼び出しをしない。タスクの実行は上限でも今までどおり（まとめは会話だけ）', async t => {
  const s = await setup(t, { maxIterations: 2 });
  s.adapter().scripts.push(toolCall('file_write', { path: 'a.md', content: '1' }), reply('書きました'));
  const { runId, result } = await s.chat('書いて');
  assert.equal(result.text, '書きました');
  assert.equal(s.adapter().calls.length, 2, '余計な呼び出しは無い');
  assert.deepEqual(JSON.parse(s.app.runs.get(runId)!.flags), []);

  const task = s.app.tasks.create({ title: '上限まで道具を使う', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(toolCall('file_write', { path: 'b.md', content: '1' }), toolCall('file_write', { path: 'b.md', content: '2' }));
  const before = s.adapter().calls.length;
  await s.app.worker.tick();
  assert.equal(s.adapter().calls.length - before, 2, 'タスクは上限で、まとめの呼び出しを足さない');
  assert.ok(s.app.tasks.get(task.id));
});

// ── 6b: 会話で進んだ分を、タスクへ引き継ぐ ──

test('会話がタスクを止めて上限まで進んだら、まとめをタスクの経過（メモ）と次の一手に書く', async t => {
  const s = await setup(t, { maxIterations: 2 });
  const task = s.app.tasks.create({ title: '長い調べもの', origin: 'user', actor: 'user', nextAction: '最初の一手' });
  s.adapter().scripts.push(hang());
  const ticking = s.app.worker.tick();
  await waitFor(() => s.app.tasks.get(task.id)?.status === 'running', 'タスクが実行中になる');
  s.adapter().scripts.push(toolCall('file_write', { path: 'a.md', content: '1' }), toolCall('file_write', { path: 'a.md', content: '2' }), reply(WRAP));
  const { runId } = await s.chat('こっちを先に進めて');
  await ticking;
  const after = s.app.tasks.get(task.id)!;
  assert.match(after.body, /a\.md を 2 回書いた/u, 'まとめがメモとして残る');
  assert.equal(after.next_action, 'b.md を確かめてから、c.md を書く', '次の一手は、まとめの「次の一手」の部分');
  assert.equal(after.status, 'ready', 'タスクは止められて、あとで続きから再開する');
  const note = s.app.tasks.events(task.id).find(e => e.kind === 'note')!;
  assert.deepEqual([note.actor, note.run_id], ['clive', runId]);
  assert.match(note.content!, /a\.md を 2 回書いた/u);
});

test('会話がタスクを止めて普通に終わったときも、返事をメモに残す（次の一手は変えない）', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: '長い調べもの', origin: 'user', actor: 'user', nextAction: '最初の一手' });
  s.adapter().scripts.push(hang());
  const ticking = s.app.worker.tick();
  await waitFor(() => s.app.tasks.get(task.id)?.status === 'running', 'タスクが実行中になる');
  s.adapter().scripts.push(reply('調べて、答えは 42 でした'));
  await s.chat('先に答えだけ教えて');
  await ticking;
  const after = s.app.tasks.get(task.id)!;
  assert.match(after.body, /答えは 42 でした/u);
  assert.equal(after.next_action, '最初の一手', '上限のまとめが無いときは、次の一手を書き換えない');
});

test('会話で作った実行待ち・返事待ちのタスクにも、会話で進んだ分を書く。作っただけ・終わったタスク・別の会話のタスクには書かない', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolCall('task_create', { title: '報告書を書く', requested_by_user: true }), reply('タスクにしました'));
  await s.chat('あとで報告書を書いて');
  const created = s.app.tasks.list().find(task => task.title === '報告書を書く')!;
  assert.equal(created.body, '', '作っただけの実行では、確認の返事をメモにしない');

  s.adapter().scripts.push(toolCall('task_create', { title: '別の会話のタスク', requested_by_user: true }), reply('作りました'));
  await s.chat('別の依頼', 'c2');
  const other = s.app.tasks.list().find(task => task.title === '別の会話のタスク')!;
  const done = s.app.tasks.create({ title: '終わったタスク', origin: 'user', actor: 'user' });
  s.app.tasks.finish(done.id, 'done', '済み', 'clive');

  s.adapter().scripts.push(toolCall('file_write', { path: 'report.md', content: '下書き' }), reply('報告書の下書きを書きました'));
  await s.chat('先に下書きだけ書いて');
  assert.match(s.app.tasks.get(created.id)!.body, /報告書の下書きを書きました/u, '同じ会話で作った実行待ちのタスクに書く');
  assert.equal(s.app.tasks.get(other.id)!.body, '', '別の会話のタスクには書かない');
  assert.equal(s.app.tasks.get(done.id)!.body, '', '終わったタスクには書かない');

  s.app.tasks.setWaiting(created.id, 'question', 'どの形式？');
  s.adapter().scripts.push(toolCall('file_write', { path: 'report.md', content: '清書' }), reply('清書しました'));
  await s.chat('清書して');
  assert.match(s.app.tasks.get(created.id)!.body, /清書しました/u, '返事待ちのタスクにも書く');
  s.app.tasks.finish(created.id, 'cancelled', '取り消した', 'user');
  s.adapter().scripts.push(toolCall('file_write', { path: 'report.md', content: '最終' }), reply('最終版にしました'));
  await s.chat('最終版にして');
  assert.doesNotMatch(s.app.tasks.get(created.id)!.body, /最終版にしました/u, '取り消したタスクには書かない');
});

test('道具を使わなかった会話では、作ったタスクに何も書かない', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolCall('task_create', { title: '洗濯', requested_by_user: true }), reply('作りました'), reply('こんにちは'));
  await s.chat('洗濯をタスクにして');
  await s.chat('ありがとう');
  assert.equal(s.app.tasks.list().find(task => task.title === '洗濯')!.body, '');
});
