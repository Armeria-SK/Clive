import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { App } from '../src/app.ts';
import type { ModelConfig } from '../src/config/schema.ts';
import type { SendChoice } from '../src/engine/chat.ts';
import { contextAvailable } from '../src/engine/context-budget.ts';
import { estimateMessageTokens, IMAGE_TOKENS } from '../src/engine/tokens.ts';
import type { ChatMessage, ImageRef, RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { transcriptOf } from '../src/memory/review.ts';
import { resolvePaths } from '../src/paths.ts';
import { ProviderError } from '../src/providers/types.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../src/tools/types.ts';
import { CONVERSATION, fakeModel, startApp } from './app-setup.ts';
import { fail, FakeAdapter, reply, tempDir, type Script, testConfig } from './helpers.ts';

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
    assert.ok(text.length < 9100, `16k のモデルでは、1 つの結果は、道具の仕様と今のやり取りを引いた残りの一部（約 8,700 文字より小さい）: ${text.length}`);
    assert.match(text, /文字中 \d,\d{3} 文字だけを返しました/u);
  }
  assert.ok(results[0]!.length > results[1]!.length && results[1]!.length > results[2]!.length, '結果が積まれるほど、次の結果に許す量は小さくなる');
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

// 道具の数が 24 → 31 に増えて、固定の分（system と道具の仕様）が 16k の約 4 割になっても、結果が入りきらなくならない。
// 結果の量を「モデルの境目の 2 割」と決めていたころは、英数字の一覧で 3 つ目、日本語の本文だと 1 つ目で、入りきらなくなった
test('道具の結果: 固定の分が大きい 16k のモデルでも、結果を何度受け取っても入りきる（英数字も日本語も）', async t => {
  const lines = Array.from({ length: 600 }, (_, i) => `remotion-app/node_modules/@remotion/renderer/dist/esm/file${i}.js`).join('\n');
  const minutes = Array.from({ length: 900 }, (_, i) => `第${i}回議事録: 予算の見直しと来期の採用計画について話し合い、各部門の担当者が持ち帰って検討することになった。`).join('\n');
  for (const [name, text, count] of [['英数字', lines, 5], ['日本語', minutes, 5]] as const) {
    const s = await setup(t, { contextLength: 16384, minContext: 4096, maxOutputTokens: 1024 });
    writeFileSync(join(s.paths.workspace, 'listing.txt'), text);
    s.adapter().scripts.push(...Array.from({ length: count }, () => toolCall('file_read', { path: 'listing.txt' })), reply('読みました'));
    const result = await (await s.send('一覧を読んで')).done;
    assert.ok(result.ok, `${name}: ${JSON.stringify(result)}`);
    assert.equal(s.app.conversations.messages('c1').filter(m => m.role === 'tool').length, count);
    assert.equal(s.events.some(e => e.type === 'warning' && e.code === 'context_trimmed'), false, `${name}: 古い発言を削らずに収まる`);
    const available = contextAvailable(16384, s.app.config().models[0]!);
    const run = s.app.runs.get(result.runId)!;
    const estimate = run.est_prompt_tokens ?? 0;
    assert.ok(estimate > 0 && estimate <= available, `${name}: 最後の呼び出しの見積もり ${estimate} が使える量 ${available} に収まる`);
  }
});

// 古いやり取りは、次の呼び出しで外せる（fit.ts）ので、結果の量を決める「削れない分」には数えない。数えると、長い会話ほど結果が小さくなってしまう
test('道具の結果の量は、削れない分だけから決まる: 古いやり取りが長くても小さくならず、入りきらない分は古い発言を外して収める', async t => {
  const lines = Array.from({ length: 600 }, (_, i) => `remotion-app/node_modules/@remotion/renderer/dist/esm/file${i}.js`).join('\n');
  const model = { contextLength: 16384, minContext: 4096, maxOutputTokens: 1024 };
  const toolText = (s: Awaited<ReturnType<typeof setup>>) => s.app.conversations.messages('c1').find(m => m.role === 'tool')!.text;

  const fresh = await setup(t, model);
  writeFileSync(join(fresh.paths.workspace, 'listing.txt'), lines);
  fresh.adapter().scripts.push(toolCall('file_read', { path: 'listing.txt' }), reply('読みました'));
  assert.ok((await (await fresh.send('一覧を読んで')).done).ok);

  const long = await setup(t, model);
  writeFileSync(join(long.paths.workspace, 'listing.txt'), lines);
  for (const question of ['一つ目', '二つ目', '三つ目']) {
    long.adapter().scripts.push(reply('あ'.repeat(2300)));
    assert.ok((await (await long.send(question)).done).ok);
  }
  long.adapter().scripts.push(toolCall('file_read', { path: 'listing.txt' }), reply('読みました'));
  const result = await (await long.send('一覧を読んで')).done;
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(Math.abs(toolText(long).length - toolText(fresh).length) <= 60, `長い会話でも同じ量: ${toolText(long).length} と ${toolText(fresh).length}`);
  assert.equal(long.events.some(e => e.type === 'warning' && e.code === 'context_trimmed'), true, '入りきらない分は、結果を小さくするのでなく古い発言を外して収める');
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

// ── 段 4-4: 道具の結果の画像（X5 ToolOutput.images）のエンジンの側 ──

const MARK = 'SECRETIMAGEBASE64MARK';
const PNG: ImageRef = { mediaType: 'image/png', data: MARK };
const imageTool = (name: string, run: (ctx: ToolContext) => ToolOutput): ToolDef => ({
  name, description: name, effect: 'read', allowedIn: ['chat', 'task', 'review'],
  input: Type.Object({}, { additionalProperties: false }),
  async execute(_input, ctx) { return run(ctx); },
});
type ImageApp = Awaited<ReturnType<typeof startApp>>;

async function runImages(s: ImageApp, text: string, choice: SendChoice = {}) {
  const outcome = s.app.engine.send(CONVERSATION, text, [], [], choice);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  const result = await s.app.engine.wait(outcome.runId)!;
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

const storedTool = (s: ImageApp) => s.app.conversations.messages(CONVERSATION).filter(m => m.role === 'tool').map(m => m.message as Extract<ChatMessage, { role: 'tool' }>);

test('道具の結果の画像: 保存した道具の結果の発言に images が付き、次のモデル呼び出しの messages に渡る。長くて切られた結果でも残る', async t => {
  const long = 'あ'.repeat(30_000);
  const s = await startApp(t, { tools: [imageTool('img_ok', () => ({ content: long, images: [PNG] }))] });
  s.adapter().scripts.push(toolCall('img_ok', {}), reply('見ました'));
  await runImages(s, '画像を見て');
  const [saved] = storedTool(s);
  assert.deepEqual(saved!.images, [PNG], '保存された道具の結果の発言に画像がある');
  assert.ok(JSON.stringify(s.app.db.prepare("SELECT parts FROM messages WHERE role = 'tool'").all()).includes(MARK), 'messages.parts の JSON に base64 で入る（添付の画像と同じ置き場所）');
  assert.ok(saved!.content.length < long.length, '長い結果は切られている（切る処理が images を落とさない）');
  const second = s.adapter().calls[1]!.messages.at(-1)!;
  assert.equal(second.role, 'tool');
  assert.deepEqual(second.role === 'tool' ? second.images : undefined, [PNG], '次のモデル呼び出しの messages に画像が渡る');
});

test('道具の結果の画像: 画像の無い道具の結果の発言は今までと同じ形（images の項目が無い）', async t => {
  const s = await startApp(t, { tools: [imageTool('plain', () => ({ content: 'ok' })), imageTool('empty', () => ({ content: 'ok', images: [] }))] });
  s.adapter().scripts.push(toolCall('plain', {}), toolCall('empty', {}), reply('おわり'));
  await runImages(s, '呼んで');
  for (const message of storedTool(s)) assert.deepEqual(Object.keys(message).sort(), ['content', 'name', 'role', 'toolCallId'], message.name);
});

test('道具の結果の画像: 失敗（isError）の結果の画像は保存せず、モデルにも渡さない', async t => {
  const s = await startApp(t, { tools: [imageTool('img_fail', () => ({ content: '読めませんでした', isError: true, images: [PNG] }))] });
  s.adapter().scripts.push(toolCall('img_fail', {}), reply('失敗でした'));
  await runImages(s, '画像を見て');
  const [saved] = storedTool(s);
  assert.equal(saved!.isError, true);
  assert.equal('images' in saved!, false);
  assert.equal(JSON.stringify(s.adapter().calls[1]!.messages).includes(MARK), false);
  assert.equal(JSON.stringify(s.app.db.prepare('SELECT parts FROM messages').all()).includes(MARK), false);
});

test('道具の結果の画像: 出来事・道具の記録・画面の API には画像が出ない。検索・要約・振り返りが読む文字（text）にも入らない', async t => {
  const s = await startApp(t, { tools: [imageTool('img_ok', () => ({ content: '画像を見せます', images: [PNG] }))] });
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  s.adapter().scripts.push(toolCall('img_ok', {}), reply('見ました'));
  await runImages(s, '画像を見て');
  assert.ok(storedTool(s)[0]!.images, '画像は保存されている（これが無いと下の確かめは空振り）');
  assert.ok(events.some(e => e.type === 'tool.result'));
  assert.equal(JSON.stringify(events).includes(MARK), false, '出来事（SSE）に画像が出ない');
  assert.equal(JSON.stringify(s.app.db.prepare('SELECT * FROM tool_calls').all()).includes(MARK), false, 'tool_calls の行（output_preview など）に画像が出ない');
  const listing = await (await s.api(`/api/conversations/${CONVERSATION}/messages`)).text();
  assert.match(listing, /img_ok/u, '道具の結果の発言は一覧に出ている');
  assert.equal(listing.includes(MARK), false, 'GET /api/conversations/:id/messages の応答に画像（base64）が無い');
  const stored = s.app.conversations.messages(CONVERSATION);
  assert.equal(JSON.stringify(stored.map(m => m.text)).includes(MARK), false, 'text の列（検索の索引・要約・振り返りの材料）に画像が入らない');
  assert.equal(transcriptOf(stored).includes(MARK), false, '振り返りの記録に画像が入らない');
});

test('道具の結果の画像: 古い画像つきのやり取りを要約に回しても、要約の依頼に画像は入らない（原文は DB に残る）', async t => {
  const small = fakeModel('m1', { contextLength: 20_000, minContext: 1024, maxOutputTokens: 1024 });
  const s = await startApp(t, { models: [small], tools: [] });
  const conversations = s.app.conversations;
  conversations.append(CONVERSATION, { role: 'user', content: `質問0${'い'.repeat(3000)}` });
  conversations.append(CONVERSATION, { role: 'assistant', content: '', toolCalls: [{ id: 't0', name: 'img_ok', arguments: {} }] });
  conversations.append(CONVERSATION, { role: 'tool', toolCallId: 't0', name: 'img_ok', content: '画像を見せます', images: [PNG] });
  conversations.append(CONVERSATION, { role: 'assistant', content: '答え0' });
  for (let i = 1; i < 6; i++) {
    conversations.append(CONVERSATION, { role: 'user', content: `質問${i}${'い'.repeat(3000)}` });
    conversations.append(CONVERSATION, { role: 'assistant', content: `答え${i}` });
  }
  s.adapter().scripts.push(reply('- 画像を見せてもらった'), reply('ok'));
  await runImages(s, '最新の質問');
  assert.ok(s.adapter().calls.length >= 2);
  const summaryCall = s.adapter().calls[0]!;
  assert.match(JSON.stringify(summaryCall.messages), /会話の古い部分/u, '1 回目の呼び出しは要約の依頼');
  assert.match(JSON.stringify(summaryCall.messages), /img_ok/u, '要約に回った古い部分に、画像つきの道具の結果が入っている');
  assert.equal(JSON.stringify(s.adapter().calls).includes(MARK), false, '要約の依頼にも、そのあとの呼び出しにも画像は入らない');
  assert.ok(storedTool(s)[0]!.images, '原文の画像は DB に残る');
});

test('道具の結果の画像: ctx.model は、道具を呼ぶ直前のモデルの id と vision を映す（鎖の途中で替わったら替わる）', async t => {
  const seen: Array<ToolContext['model']> = [];
  const s = await startApp(t, {
    models: [fakeModel('m1', { vision: false }), fakeModel('m2', { vision: true })],
    tools: [imageTool('probe', ctx => { seen.push(ctx.model === undefined ? undefined : { ...ctx.model }); return { content: 'ok' }; })],
  });
  s.adapter().scripts.push(
    toolCall('probe', {}),
    fail(new ProviderError('provider_error', 'down', { retryable: false })),
    toolCall('probe', {}),
    reply('おわり'),
  );
  await runImages(s, '二回呼んで');
  assert.deepEqual(seen, [{ id: 'm1', vision: false }, { id: 'm2', vision: true }]);
});

test('道具の結果の画像: 手元のモデルを選んだ会話の道具の画像は、その会話のモデル（手元）にだけ届き、外のモデルには届かない', async t => {
  const s = await startApp(t, {
    models: [fakeModel('local', { vision: true }), fakeModel('remote', { vision: true, provider: 'remote' })],
    configure: config => { config.providers.push({ id: 'remote', kind: 'openai_compatible', baseUrl: 'https://api.example.com/v1', maxParallel: 1, timeoutMs: 10_000 }); },
    tools: [imageTool('img_ok', () => ({ content: '画像を見せます', images: [PNG] }))],
  });
  s.adapter().scripts.push(toolCall('img_ok', {}), reply('見ました'));
  await runImages(s, '画像を見て', { modelId: 'local' });
  assert.deepEqual(s.adapter().calls.length, 2);
  const second = s.adapter().calls[1]!.messages.at(-1)!;
  assert.deepEqual(second.role === 'tool' ? second.images : undefined, [PNG], '手元のモデルには届く');
  assert.equal(s.adapters.get('remote')?.calls.length ?? 0, 0, '外の提供元は一度も呼ばれない（画像はどこへも新しくは出ない）');
});

test('道具の結果の画像: 本文で道具を呼ぶモデル（json_fallback）には、道具の結果をまとめた利用者の発言の images として渡る', async t => {
  const s = await startApp(t, {
    models: [fakeModel('m1', { toolMode: 'json_fallback', vision: true })],
    tools: [imageTool('img_ok', () => ({ content: '画像を見せます', images: [PNG] }))],
  });
  s.adapter().scripts.push(textOnly('<tool_call>{"name": "img_ok", "arguments": {}}</tool_call>'), reply('見ました'));
  await runImages(s, '画像を見て');
  const second = s.adapter().calls[1]!.messages;
  assert.deepEqual(second.map(m => m.role), ['user', 'assistant', 'user'], 'role: tool は送らない');
  const last = second.at(-1)!;
  assert.deepEqual(last.role === 'user' ? last.images : undefined, [PNG], '道具の結果をまとめた利用者の発言に画像がある');
  assert.match(last.content, /img_ok」の結果/u);
});

test('見積もり: 道具の結果の画像は 1 枚ごとに IMAGE_TOKENS 増える（利用者の発言の画像と同じ数え方）。画像が無ければ今までどおり', () => {
  const plain: ChatMessage = { role: 'tool', toolCallId: 't', name: 'image_view', content: '画像を見せます' };
  assert.equal(estimateMessageTokens({ ...plain, images: [PNG] }) - estimateMessageTokens(plain), IMAGE_TOKENS);
  assert.equal(estimateMessageTokens({ ...plain, images: [PNG, PNG, PNG] }) - estimateMessageTokens(plain), 3 * IMAGE_TOKENS);
  assert.equal(estimateMessageTokens({ ...plain, images: [] }), estimateMessageTokens(plain));
  const user: ChatMessage = { role: 'user', content: '見て' };
  assert.equal(estimateMessageTokens({ ...user, images: [PNG] }) - estimateMessageTokens(user), IMAGE_TOKENS, '比べる基準: 利用者の発言の画像と同じ');
});
