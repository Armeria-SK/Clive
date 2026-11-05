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

// security-self-api.md の V1: 報告された筋道そのもの。Clive が put.js を書いて動かし、API・設定ファイルに手を出そうとする
test('V1: スクリプトを書いて node で動かす筋道は、中身つきの今回だけの確かめで止まる。拒否すれば何も起きない', async t => {
  const s = await setup(t);
  const configBefore = readFileSync(s.paths.config, 'utf8');
  const marker = join(s.paths.workspace, 'ran.txt');
  const attack = [
    "const fs = require('node:fs');",
    "fs.writeFileSync('ran.txt', 'ran');",
    `fs.writeFileSync(${JSON.stringify(s.paths.config)}, '{}');`,
    "fetch('http://127.0.0.1:1/api/settings', { method: 'PUT', headers: { Origin: 'http://127.0.0.1:1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => undefined);",
    '',
  ].join('\n');
  s.adapter().scripts.push(toolCall('file_write', { path: 'put.js', content: attack }), toolCall('shell_run', { command: 'node put.js' }), reply('動かしました'));
  const { done } = await s.send('設定を直して');
  for (let i = 0; i < 300 && !s.events.some(e => e.type === 'approval.requested'); i++) await new Promise(r => setTimeout(r, 10));
  const requests = s.events.filter(e => e.type === 'approval.requested') as Array<Extract<RunEvent, { type: 'approval.requested' }>>;
  assert.equal(requests.length, 1, 'put.js を書くのは作業フォルダの中なので確かめなし。確かめが出るのは動かす node だけ');
  const request = requests[0]!.approval;
  assert.equal(request.tool, 'shell_run');
  assert.equal(request.onceOnly, true);
  assert.equal(request.preview.length, 1);
  assert.match(request.preview[0]!.path, /put\.js$/u);
  assert.match(request.preview[0]!.text, /api\/settings/u, '動かすコードの中身が札に出る');
  assert.match(request.reasons[0]!, /Clive 自身の設定・人格・承認・記憶に触れる文字/u, '理由の先頭に目印');
  assert.match(request.reasons[0]!, /config\.json/u);
  assert.ok(request.reasons.some(r => /ファイルに書かれたコードを動かします/u.test(r)));
  assert.equal(existsSync(marker), false, '承認の前には動いていない');

  s.app.approvals.decide(request.id, 'deny');
  const result = await done;
  assert.ok(result.ok);
  assert.equal(existsSync(marker), false, '拒否したのに動いた');
  assert.equal(readFileSync(s.paths.config, 'utf8'), configBefore, '設定ファイルが書き換わった');
  assert.match(s.app.conversations.messages('c1').find(m => m.role === 'tool' && /拒否/u.test(m.text))?.text ?? '', /ユーザーが実行を拒否しました/u);

  // 同じ文字のコマンドを、中身を変えてもう一度出しても、また確かめになる（拒否のあとも、許可のあとも）
  writeFileSync(join(s.paths.workspace, 'put.js'), "require('node:fs').writeFileSync('ran.txt', 'harmless');\n");
  s.adapter().scripts.push(toolCall('shell_run', { command: 'node put.js' }), reply('動かしました'));
  const again = await s.send('もう一度');
  for (let i = 0; i < 300 && s.events.filter(e => e.type === 'approval.requested').length < 2; i++) await new Promise(r => setTimeout(r, 10));
  const second = (s.events.filter(e => e.type === 'approval.requested') as Array<Extract<RunEvent, { type: 'approval.requested' }>>)[1]!;
  assert.ok(second, '2 回目も確かめが出る');
  assert.doesNotMatch(second.approval.reasons[0]!, /Clive 自身/u, '無害な中身には目印が付かない');
  s.app.approvals.decide(second.approval.id, 'conversation');
  assert.ok((await again.done).ok);
  assert.equal(readFileSync(marker, 'utf8'), 'harmless', '許可すれば動く（拒否の確認が空振りでないことの対照）');
  assert.equal(readFileSync(s.paths.config, 'utf8'), configBefore);

  s.adapter().scripts.push(toolCall('shell_run', { command: 'node put.js' }), reply('動かしました'));
  const third = await s.send('もう一度');
  for (let i = 0; i < 300 && s.events.filter(e => e.type === 'approval.requested').length < 3; i++) await new Promise(r => setTimeout(r, 10));
  const last = s.events.filter(e => e.type === 'approval.requested');
  assert.equal(last.length, 3, '「この会話では許可」を送っても、3 回目もまた確かめになる');
  s.app.approvals.decide((last[2] as Extract<RunEvent, { type: 'approval.requested' }>).approval.id, 'deny');
  await third.done;
});

test('道具の結果は、モデルのコンテキストに合わせて切る（小さなコンテキストで、大きな一覧 1 つが入りきらなくならない）', async t => {
  const small = await setup(t, { contextLength: 16384, minContext: 4096, maxOutputTokens: 1024 });
  const lines = Array.from({ length: 600 }, (_, i) => `remotion-app/node_modules/@remotion/renderer/dist/esm/file${i}.js`).join('\n');
  writeFileSync(join(small.paths.workspace, 'listing.txt'), lines);
  small.adapter().scripts.push(...[1, 2, 3].map(() => toolCall('file_read', { path: 'listing.txt' })), reply('読みました'));
  const run = await small.send('一覧を読んで');
  const result = await run.done;
  assert.ok(result.ok, JSON.stringify(result));
  const results = small.app.conversations.messages('c1').filter(m => m.role === 'tool').map(m => m.text);
  assert.equal(results.length, 3);
  for (const text of results) {
    assert.ok(text.length < 9100, `16k のモデルでは、1 つの結果を約 8,700 文字までにする: ${text.length}`);
    assert.match(text, /文字中 8,\d{3} 文字だけを返しました/u);
  }
  const last = small.adapter().calls.at(-1)!;
  assert.ok(last.messages.length >= 7, '3 回分の結果が入っている');
  assert.equal(small.events.some(e => e.type === 'warning' && e.code === 'context_trimmed'), false, '古い発言を削らずに収まる');

  const large = await setup(t, { contextLength: 200_000, minContext: 4096, maxOutputTokens: 4096 });
  writeFileSync(join(large.paths.workspace, 'listing.txt'), lines.repeat(2));
  large.adapter().scripts.push(toolCall('file_read', { path: 'listing.txt' }), reply('読みました'));
  assert.ok((await (await large.send('一覧を読んで')).done).ok);
  const big = large.app.conversations.messages('c1').find(m => m.role === 'tool')!.text;
  assert.match(big, /文字中 16,000 文字だけを返しました/u, '大きなコンテキストでは、今までどおり 16,000 文字');
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

test('使用量: 道具の仕様と道具の往復も数に入り、次の送信の見積もり（est_prompt_tokens）と合う。道具を渡さないモデルでは小さくなる', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolCall('file_write', { path: 'hello.md', content: 'やあ' }), reply('書きました'), reply('二つ目の返事'));
  assert.ok((await (await s.send('hello.md を作って')).done).ok);
  const next = s.app.engine.send('c1', '次の質問');
  assert.ok(next.ok);
  const usage = s.app.engine.contextUsage('c1');
  assert.ok(usage.ok);
  await s.app.engine.wait(next.runId);
  assert.equal(usage.tokens, s.app.runs.get(next.runId)!.est_prompt_tokens, '道具の往復（assistant の呼び出しと tool の結果）と道具の仕様まで同じ組み立て');
  const calls = s.adapter().calls;
  assert.ok(calls.at(-1)!.tools.length > 0 && calls.at(-1)!.messages.some(m => m.role === 'tool'));

  const bare = await setup(t, { maxTools: 0 });
  const withoutTools = bare.app.engine.contextUsage('fresh');
  const withTools = s.app.engine.contextUsage('fresh');
  assert.ok(withoutTools.ok && withTools.ok);
  assert.ok(withTools.tokens - withoutTools.tokens > 500, `道具の仕様の分が増える（${withTools.tokens} と ${withoutTools.tokens}）`);
});

// ── 6d: 道具を使う回数の上限なし（tools.maxIterations = 0） ──

function endlessTools(onCall: (calls: number) => void): Script {
  let calls = 0;
  return async function* (req) {
    calls++;
    onCall(calls);
    // 道具を渡さない呼び出し（上限のまとめ）が来たら、まとめを返す
    if (req.tools.length === 0) { yield { type: 'text', delta: 'まとめです' }; yield { type: 'done', stop: 'end_turn' as StopReason }; return; }
    const call: ToolCall = { id: `call_${calls}`, name: 'file_list', arguments: {} };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

async function runEndless(t: { after: (fn: () => void) => void }, maxIterations: number, stopAt: number) {
  const s = await setup(t, {}, maxIterations);
  let runId = '';
  const script = endlessTools(calls => { if (calls === stopAt) s.app.engine.stop(runId); });
  const adapter = s.adapter();
  adapter.scripts = new Proxy([] as Script[], { get: (target, key) => (key === 'shift' ? () => script : Reflect.get(target, key)) });
  const sent = await s.send('どんどん調べて');
  runId = sent.runId;
  const result = await sent.done;
  return { s, result, calls: adapter.calls };
}

test('0 は制限なし: 100 回を超えて道具を使い続け、止めるボタン（取り消し）で止まる。まとめも上限のお知らせも出さない', async t => {
  const { s, result, calls } = await runEndless(t, 0, 130);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorKind, 'cancelled');
  assert.ok(calls.length >= 130, `100 回で止まらない（${calls.length} 回）`);
  assert.ok(calls.every(c => c.tools.length > 0), '道具なしのまとめの呼び出しは一度も無い');
  assert.equal(s.events.some(e => e.type === 'warning' && e.code === 'max_iterations'), false);
  const run = s.app.runs.get(result.runId)!;
  assert.deepEqual(JSON.parse(run.flags), []);
  assert.ok(run.iterations! >= 130);
  assert.equal(s.app.conversations.messages('c1').some(m => m.role === 'assistant' && m.text === 'まとめです'), false);
});

test('上限 100 は今までどおり: 100 回目の呼び出しのあとで止まり、まとめを 1 回呼ぶ', async t => {
  const { s, result, calls } = await runEndless(t, 100, 100_000);
  assert.ok(result.ok);
  assert.equal(calls.length, 101, '道具の呼び出し 100 回 + まとめ 1 回');
  assert.equal(calls.at(-1)!.tools.length, 0);
  assert.equal(result.text, 'まとめです');
  assert.ok(s.events.some(e => e.type === 'warning' && e.code === 'max_iterations'));
});
