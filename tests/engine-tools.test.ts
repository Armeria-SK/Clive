import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { ModelConfig } from '../src/config/schema.ts';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { FakeAdapter, reply, tempDir, type Script, testConfig } from './helpers.ts';

function toolCall(name: string, args: unknown): Script {
  return async function* () {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

function textOnly(text: string): Script {
  return async function* () { yield { type: 'text', delta: text }; yield { type: 'done', stop: 'end_turn' as StopReason }; };
}

async function setup(t: { after: (fn: () => void) => void }, model: Partial<ModelConfig> = {}, maxIterations = 16) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false, ...model }];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  config.tools.maxIterations = maxIterations;
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  const events: RunEvent[] = [];
  app.bus.subscribe(e => events.push(e.event));
  t.after(() => app.close());
  const send = async (text: string) => {
    const outcome = app.engine.send('c1', text);
    assert.ok(outcome.ok, JSON.stringify(outcome));
    return { runId: outcome.runId, done: app.engine.wait(outcome.runId)! };
  };
  return { app, adapter: () => adapter, events, send, paths };
}

test('ツールを使ってから返事を書く（結果は履歴に残り、次の呼び出しに渡る）', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolCall('file_write', { path: 'hello.md', content: 'やあ' }), reply('書きました'));
  const { runId, done } = await s.send('hello.md を作って');
  const result = await done;
  assert.ok(result.ok);
  assert.equal(readFileSync(join(s.paths.workspace, 'hello.md'), 'utf8'), 'やあ');
  assert.deepEqual(s.app.conversations.messages('c1').map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
  const second = s.adapter().calls[1]!.messages;
  assert.equal(second.at(-1)?.role, 'tool');
  assert.ok(s.adapter().calls[0]!.tools.some(t => t.name === 'shell_run'));
  const run = s.app.runs.get(runId)!;
  assert.equal(run.tool_calls, 1); assert.equal(run.iterations, 2);
  assert.deepEqual(s.events.filter(e => e.type.startsWith('tool.')).map(e => e.type), ['tool.call', 'tool.result']);
});

test('承認を待ってから続ける', async t => {
  const s = await setup(t);
  const outside = join(s.paths.data, 'outside.txt');
  writeFileSync(outside, 'secret-ish');
  const command = process.platform === 'win32' ? `Get-Content "${outside}"` : `cat "${outside}"`;
  s.adapter().scripts.push(toolCall('shell_run', { command }), reply('読みました'));
  const { done } = await s.send('外のファイルを読んで');
  for (let i = 0; i < 300 && !s.events.some(e => e.type === 'approval.requested'); i++) await new Promise(r => setTimeout(r, 10));
  const requested = s.events.find(e => e.type === 'approval.requested') as Extract<RunEvent, { type: 'approval.requested' }>;
  assert.ok(requested);
  assert.match(requested.approval.body, /outside\.txt/u);
  s.app.approvals.decide(requested.approval.id, 'once');
  const result = await done;
  assert.ok(result.ok);
  assert.match(s.app.conversations.messages('c1').find(m => m.role === 'tool')!.text, /secret-ish/u);
});

test('本文に書かれたツール呼び出し（<tool_call>）も拾って実行する', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(
    textOnly('作ります <tool_call>{"name": "file_write", "arguments": {"path": "t.md", "content": "本文から"}}</tool_call>'),
    reply('できました'),
  );
  const { runId, done } = await s.send('t.md を作って');
  assert.ok((await done).ok);
  assert.equal(readFileSync(join(s.paths.workspace, 't.md'), 'utf8'), '本文から');
  assert.match(s.app.runs.get(runId)!.flags, /text_tool_calls/u);
  assert.equal(s.app.conversations.messages('c1')[1]!.text, '作ります');
});

test('json_fallback のモデルには API のツールを渡さず、使い方を system に書く', async t => {
  const s = await setup(t, { toolMode: 'json_fallback' });
  s.adapter().scripts.push(textOnly('<tool_call>{"name": "file_list", "arguments": {}}</tool_call>'), reply('一覧しました'));
  const { done } = await s.send('一覧して');
  assert.ok((await done).ok);
  const [first, second] = s.adapter().calls;
  assert.equal(first!.tools.length, 0);
  assert.match(first!.system.dynamic, /使える道具[\s\S]*file_list/u);
  assert.deepEqual(second!.messages.map(m => m.role), ['user', 'assistant', 'user'], 'role: tool を送らない');
});

test('maxTools で渡すツールを絞れる', async t => {
  const s = await setup(t, { maxTools: 2 });
  s.adapter().scripts.push(reply('ok'));
  await (await s.send('やあ')).done;
  assert.deepEqual(s.adapter().calls[0]!.tools.map(t => t.name), ['memory_save', 'history_search'], '記憶と履歴の検索を先に残す');
});

test('引数の形が3回続けて正しくなければ止める', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolCall('file_write', {}), toolCall('file_write', {}), toolCall('file_write', {}), reply('届かない'));
  const result = await (await s.send('書いて')).done;
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.errorMessage, /正しい形でツールを呼べませんでした/u);
  assert.equal(s.adapter().calls.length, 3);
});

test('呼び直しの上限に達したら止めて知らせる', async t => {
  const s = await setup(t, {}, 2);
  s.adapter().scripts.push(toolCall('file_list', {}), toolCall('file_list', {}), reply('届かない'));
  const { runId, done } = await s.send('一覧を続けて');
  assert.ok((await done).ok);
  assert.ok(s.events.some(e => e.type === 'warning' && e.code === 'max_iterations'));
  assert.match(s.app.runs.get(runId)!.flags, /max_iterations/u);
});

test('承認を待っている間に止めたら、実行せずに中止する', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolCall('shell_run', { command: 'git push origin main' }), reply('届かない'));
  const { runId, done } = await s.send('push して');
  for (let i = 0; i < 300 && !s.app.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(s.app.approvals.pending().length, 1);
  s.app.engine.stop(runId);
  const result = await done;
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorKind, 'cancelled');
  assert.equal(s.app.approvals.pending().length, 0);
  assert.equal(existsSync(join(s.paths.workspace, '.git')), false);
});
