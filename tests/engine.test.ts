import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig, ModelConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Runs } from '../src/db/runs.ts';
import { RunBus } from '../src/engine/bus.ts';
import { candidateModelIds, ChatEngine } from '../src/engine/chat.ts';
import { ModelStatus } from '../src/engine/status.ts';
import { estimateTextTokens } from '../src/engine/tokens.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { EndpointLimiter } from '../src/providers/limiter.ts';
import { ProviderRegistry } from '../src/providers/registry.ts';
import { ProviderError } from '../src/providers/types.ts';
import { FakeAdapter, fail, reply, tempDir, type Script, testConfig } from './helpers.ts';

function localModel(id: string, over: Partial<ModelConfig> = {}): ModelConfig {
  return { id, provider: 'fake', model: id, contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false, ...over };
}

async function setup(t: { after: (fn: () => void) => void }, options: { models?: ModelConfig[]; scripts?: Script[] } = {}) {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(join(paths.workspace, 'SOUL.md'), '最初の SOUL');
  const base = testConfig();
  const config: AppConfig = parseConfig({
    ...base,
    providers: [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }],
    models: options.models ?? [localModel('a'), localModel('b')],
    routing: { chat: (options.models ?? [localModel('a'), localModel('b')]).map(m => m.id), background: [] },
  });
  const db = openDatabase(':memory:', MIGRATIONS);
  const conversations = new Conversations(db);
  const runs = new Runs(db);
  const kv = new KV(db);
  const adapter = new FakeAdapter(config.providers[0]!, options.scripts ?? []);
  const registry = new ProviderRegistry({ override: () => adapter });
  registry.reload(config);
  const status = new ModelStatus({ registry, kv, baseTokens: () => 500 });
  await status.probeAll(config);
  const bus = new RunBus();
  const events: RunEvent[] = [];
  bus.subscribe(e => events.push(e.event));
  const sleeps: number[] = [];
  const engine = new ChatEngine({
    config: () => config, conversations, runs, kv, registry, status, bus, limiter: new EndpointLimiter(), paths,
    sleep: async ms => { sleeps.push(ms); },
  });
  return { engine, adapter, conversations, runs, kv, status, events, sleeps, paths, config };
}

async function sendAndWait(engine: ChatEngine, conversationId: string, text: string) {
  const outcome = engine.send(conversationId, text);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  return engine.wait(outcome.runId)!;
}

test('返事を保存し、実行記録を残す', async t => {
  const s = await setup(t, { scripts: [reply('こんにちは！', { inputTokens: 300, outputTokens: 5 })] });
  const result = await sendAndWait(s.engine, 'c1', 'やあ');
  assert.ok(result.ok);
  assert.equal(result.text, 'こんにちは！');
  assert.deepEqual(s.conversations.messages('c1').map(m => [m.role, m.text]), [['user', 'やあ'], ['assistant', 'こんにちは！']]);
  const run = s.runs.get(result.runId)!;
  assert.equal(run.ok, 1); assert.equal(run.model_id, 'a'); assert.equal(run.attempts, 1); assert.equal(run.input_tokens, 300);
  assert.deepEqual(s.events.map(e => e.type).filter(t => t !== 'text.delta'), ['message.saved', 'run.start', 'message.saved', 'run.end']);
  assert.equal(s.conversations.get('c1')?.title, 'やあ');
});

test('使えるモデルが無ければ、発言を保存せず、モデルにも送らない', async t => {
  const s = await setup(t, { models: [localModel('a', { contextLength: 4096, minContext: 4096 })] });
  // 必要量（minContext と system＋履歴＋出力の合計の大きい方）に届かない
  assert.equal(s.status.get('a')?.status, 'too_small');
  const outcome = s.engine.send('c1', 'やあ');
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.httpStatus, 409);
  assert.equal(outcome.errorKind, 'context_overflow');
  assert.equal(outcome.detail?.reason, 'server_ctx_too_small');
  assert.match(outcome.errorMessage, /送信しませんでした/);
  assert.equal(s.conversations.messages('c1').length, 0);
  assert.equal(s.adapter.calls.length, 0);
});

test('再試行できる失敗は待ってから同じモデルでやり直す', async t => {
  const s = await setup(t, { scripts: [fail(new ProviderError('rate_limit', '混んでいます', { retryAfterMs: 1500 })), reply('ok')] });
  const result = await sendAndWait(s.engine, 'c1', 'やあ');
  assert.ok(result.ok);
  assert.equal(result.modelId, 'a');
  assert.deepEqual(s.sleeps, [1500]);
  assert.equal(s.runs.get(result.runId)!.attempts, 2);
  assert.ok(s.events.some(e => e.type === 'warning' && e.code === 'retrying'));
});

test('再試行しきったら次のモデルに切り替える', async t => {
  const busy = () => fail(new ProviderError('provider_error', '503', { retryable: true }));
  const s = await setup(t, { scripts: [busy(), busy(), busy(), reply('予備です')] });
  const result = await sendAndWait(s.engine, 'c1', 'やあ');
  assert.ok(result.ok);
  assert.equal(result.modelId, 'b');
  assert.equal(s.runs.get(result.runId)!.attempts, 4);
  assert.ok(s.events.some(e => e.type === 'model.switch' && e.from === 'a' && e.to === 'b'));
});

test('再試行できない失敗（認証など）はすぐ次のモデルへ', async t => {
  const s = await setup(t, { scripts: [fail(new ProviderError('auth', 'bad key', { retryable: false })), reply('予備')] });
  const result = await sendAndWait(s.engine, 'c1', 'やあ');
  assert.ok(result.ok);
  assert.equal(result.modelId, 'b');
  assert.deepEqual(s.sleeps, []);
});

test('すべて失敗したら text は空で、エラー文を返事として保存しない', async t => {
  const authFail = () => fail(new ProviderError('auth', 'bad key', { retryable: false }));
  const s = await setup(t, { scripts: [authFail(), authFail()] });
  const result = await sendAndWait(s.engine, 'c1', 'やあ');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.text, '');
  assert.equal(result.errorKind, 'auth');
  assert.deepEqual(s.conversations.messages('c1').map(m => m.role), ['user']);
  assert.equal(s.runs.get(result.runId)!.ok, 0);
  const end = s.events.at(-1);
  assert.equal(end?.type, 'run.end');
  // 失敗した発言はもう一度送り直せる
  s.adapter.scripts.push(reply('今度は成功'));
  const again = s.engine.retry('c1');
  assert.ok(again.ok);
  const retried = await s.engine.wait(again.runId)!;
  assert.ok(retried.ok);
  assert.deepEqual(s.conversations.messages('c1').map(m => m.role), ['user', 'assistant']);
});

test('返事の途中で失敗したら、途中までの内容を保存せず、二重に出さないよう再試行もしない', async t => {
  const s = await setup(t, { scripts: [fail(new ProviderError('provider_error', 'reset', { retryable: true }), '途中まで'), reply('予備')] });
  const result = await sendAndWait(s.engine, 'c1', 'やあ');
  assert.ok(result.ok);
  assert.equal(result.modelId, 'b');
  assert.deepEqual(s.conversations.messages('c1').map(m => m.text), ['やあ', '予備']);
  assert.ok(s.events.some(e => e.type === 'warning' && e.code === 'partial_discarded'));
});

test('利用者が止めたら、途中までの返事を「止めた」と分かる形で残す', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow: Script = async function* (req) {
    yield { type: 'text', delta: '書きかけ' };
    await gate;
    req.signal.throwIfAborted();
    yield { type: 'done', stop: 'end_turn' };
  };
  const s = await setup(t, { scripts: [slow] });
  const outcome = s.engine.send('c1', 'やあ');
  assert.ok(outcome.ok);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(s.engine.retry('c1').ok, false); // 実行中のやり直しは受け付けない（送信は待たせる: tests/queued-send.test.ts）
  assert.ok(s.engine.stop(outcome.runId));
  release();
  const result = await s.engine.wait(outcome.runId)!;
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorKind, 'cancelled');
  assert.match(s.conversations.messages('c1').at(-1)!.text, /書きかけ[\s\S]*途中で止めました/);
  assert.equal(s.runs.get(outcome.runId)!.error_kind, 'cancelled');
});

test('古い発言を外しても入らなければ、送らずに context_overflow にする', async t => {
  const s = await setup(t, { models: [localModel('a', { contextLength: 6000, minContext: 1024, maxOutputTokens: 1024 })] });
  assert.equal(s.status.get('a')?.status, 'too_small'); // 必要量 = 500 + 8192 + 1024
  // 必要量を満たすよう、確認結果を上書きして実行時の判定だけを試す
  s.adapter.probeResult = { status: 'ok' };
  await s.status.probeAll(s.config);
  const huge = 'あ'.repeat(8000);
  const result = await sendAndWait(s.engine, 'c1', huge);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorKind, 'context_overflow');
  assert.equal(result.detail?.reason, 'prompt_exceeds');
  assert.equal(s.adapter.calls.length, 0);
});

async function longConversation(t: { after: (fn: () => void) => void }) {
  const s = await setup(t, { models: [localModel('a', { contextLength: 20000, minContext: 1024, maxOutputTokens: 1024 })] });
  s.adapter.probeResult = { status: 'ok' };
  await s.status.probeAll(s.config);
  for (let i = 0; i < 6; i++) {
    s.conversations.append('c1', { role: 'user', content: `質問${i}` + 'い'.repeat(3000) });
    s.conversations.append('c1', { role: 'assistant', content: `答え${i}` });
  }
  return s;
}

test('入りきらない古いやり取りは要約してから送る（原文は DB に残る）', async t => {
  const s = await longConversation(t);
  s.adapter.scripts.push(reply('- 質問0〜3 は「い」についての相談だった'), reply('ok'));
  const result = await sendAndWait(s.engine, 'c1', '最新の質問');
  assert.ok(result.ok);
  const [summaryCall, answerCall] = s.adapter.calls;
  assert.match((summaryCall!.messages[0] as { content: string }).content, /会話の古い部分/u);
  assert.match(answerCall!.system.dynamic, /これまでの会話の要約[\s\S]*「い」についての相談/u);
  const sent = answerCall!.messages;
  assert.equal((sent.at(-1) as { content: string }).content, '最新の質問');
  assert.equal(sent[0]!.role, 'user', '組の途中から始まらない');
  assert.ok(s.events.some(e => e.type === 'compaction'));
  const conversation = s.conversations.get('c1')!;
  assert.ok(conversation.summary_upto! > 0);
  assert.equal(s.conversations.messages('c1').length, 14, '原文は消さない');
});

test('要約に失敗したら、古いやり取りを外すだけにして、そのことを知らせる', async t => {
  const s = await longConversation(t);
  s.adapter.scripts.push(fail(new ProviderError('provider_error', 'boom', { retryable: false })), reply('ok'));
  const result = await sendAndWait(s.engine, 'c1', '最新の質問');
  assert.ok(result.ok);
  const sent = s.adapter.calls[1]!.messages;
  assert.equal((sent.at(-1) as { content: string }).content, '最新の質問');
  assert.ok(sent.length < 13);
  assert.equal(sent[0]!.role, 'user');
  assert.ok(s.events.some(e => e.type === 'warning' && e.code === 'compaction_failed'));
  assert.ok(s.events.some(e => e.type === 'warning' && e.code === 'context_trimmed'));
});

test('サーバー側で切り捨てられた疑いが2回続いたら、そのモデルを使えない扱いにする', async t => {
  const s = await setup(t, { models: [localModel('a')] });
  const long = 'う'.repeat(4000);
  s.adapter.scripts.push(reply('1', { inputTokens: 100 }), reply('2', { inputTokens: 100 }));
  await sendAndWait(s.engine, 'c1', long);
  assert.ok(s.events.some(e => e.type === 'warning' && e.code === 'server_truncation_suspected'));
  assert.equal(s.status.usable('a'), true);
  await sendAndWait(s.engine, 'c1', long);
  assert.equal(s.status.usable('a'), false);
  assert.match(s.status.get('a')!.message, /切り捨て/);
});

test('見積もりの補正を学習する（切り捨てが起こりえない範囲だけ）', async t => {
  const s = await setup(t, { models: [localModel('a')] });
  s.adapter.scripts.push(reply('ok', { inputTokens: 2000 }));
  await sendAndWait(s.engine, 'c1', 'え'.repeat(1000));
  const factor = s.kv.getJson<number>('calibration:a');
  assert.ok(factor !== undefined && factor > 1, String(factor));
});

test('会話中は system の凍結スナップショットを変えない（SOUL.md を書き換えても次の会話から）', async t => {
  const s = await setup(t, { models: [localModel('a')], scripts: [reply('1'), reply('2'), reply('3')] });
  await sendAndWait(s.engine, 'c1', '一つ目');
  writeFileSync(join(s.paths.workspace, 'SOUL.md'), '書き換えた SOUL');
  await sendAndWait(s.engine, 'c1', '二つ目');
  assert.equal(s.adapter.calls[0]!.system.frozen, s.adapter.calls[1]!.system.frozen);
  assert.match(s.adapter.calls[0]!.system.frozen, /最初の SOUL/);
  await sendAndWait(s.engine, 'c2', '別の会話');
  assert.match(s.adapter.calls[2]!.system.frozen, /書き換えた SOUL/);
});

test('トークンの見積もり: 日本語は1文字1トークン、英数字は3.5文字1トークン', () => {
  assert.equal(estimateTextTokens('あいうえお'), 5);
  assert.equal(estimateTextTokens('abcdefg'), 2);
});

test('モデルが 1 つも無いときの送信は 409 engine.no_usable（problems は空）で、発言を保存せず、モデルにも送らない', async t => {
  const s = await setup(t, { models: [] });
  s.conversations.append('c0', { role: 'user', content: '前の発言' });
  for (const outcome of [s.engine.send('c1', 'やあ'), s.engine.retry('c0')]) {
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.httpStatus, 409);
    assert.equal(outcome.errorCode, 'engine.no_usable');
    assert.deepEqual(outcome.problems, []);
    assert.match(outcome.errorMessage, /モデルがまだ設定されていません/u);
  }
  assert.equal(s.conversations.messages('c1').length, 0);
  assert.equal(s.adapter.calls.length, 0);
  assert.equal(s.runs.recent(10).length, 0);
});

test('会話で使う候補: 順番が空なら設定のモデル全部。裏方が空ならチャットと同じ。モデルが 0 個なら空', () => {
  const config = testConfig();
  assert.deepEqual(candidateModelIds(config, 'chat'), ['claude-sonnet']);
  assert.deepEqual(candidateModelIds(config, 'background'), ['claude-haiku']);
  config.routing.background = [];
  assert.deepEqual(candidateModelIds(config, 'background'), ['claude-sonnet'], '裏方が空ならチャットの順番');
  config.routing.chat = [];
  assert.deepEqual(candidateModelIds(config, 'chat'), ['claude-sonnet', 'claude-haiku', 'local'], 'チャットが空なら設定のモデル全部（今までの動き）');
  assert.deepEqual(candidateModelIds(config, 'background'), ['claude-sonnet', 'claude-haiku', 'local']);
  config.models = [];
  assert.deepEqual(candidateModelIds(config, 'chat'), []);
  assert.deepEqual(candidateModelIds(config, 'background'), []);
});

// ── コンテキストの使用量（A2） ──

const kvRows = (s: Awaited<ReturnType<typeof setup>>) => JSON.stringify(s.conversations.db.prepare('SELECT * FROM kv ORDER BY key').all());
const tableCount = (s: Awaited<ReturnType<typeof setup>>, table: string) => (s.conversations.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test('使用量: 数は、同じ会話を送ったときの実行の est_prompt_tokens と同じ（見積もりの補正・要約・道具なしの組み立ても同じ）', async t => {
  const s = await setup(t, { models: [localModel('a')], scripts: [reply('1'), reply('2'), reply('3'), reply('4')] });
  s.kv.setJson('calibration:a', 1.3);
  s.conversations.append('c1', { role: 'user', content: '前の質問' });
  s.conversations.append('c1', { role: 'assistant', content: '前の答え' });
  s.conversations.setSummary('c1', '- 前の話は決まった', s.conversations.messages('c1')[0]!.id);
  for (const text of ['一つ目の質問', '二つ目の質問は少し長くしてみます。'.repeat(20), 'three']) {
    const outcome = s.engine.send('c1', text);
    assert.ok(outcome.ok);
    // send が返った時点で、最初のモデル呼び出しの組み立ては終わっている。数はそれと同じでなければならない
    const usage = s.engine.contextUsage('c1');
    assert.ok(usage.ok, JSON.stringify(usage));
    await s.engine.wait(outcome.runId);
    assert.equal(usage.tokens, s.runs.get(outcome.runId)!.est_prompt_tokens, text.slice(0, 8));
    assert.equal(usage.modelId, 'a');
    assert.equal(usage.capacity, 65536);
    assert.equal(usage.available, Math.floor(65536 * 0.95) - 1024);
    assert.equal(usage.ratio, usage.tokens / usage.available);
  }
  const one = s.engine.contextUsage('c1');
  const noFactor = (s.kv.delete('calibration:a'), s.engine.contextUsage('c1'));
  assert.ok(one.ok && noFactor.ok && one.tokens > noFactor.tokens, '補正の係数が数に効く');
});

test('使用量: 数えても何も書かない（会話を作らない・system を固定しない・ファイルの版と kv を増やさない）', async t => {
  const s = await setup(t, { models: [localModel('a')] });
  s.conversations.create({ id: 'bare' });
  s.conversations.append('has', { role: 'user', content: 'こんにちは' });
  s.conversations.setSnapshotOnce('has', '固定ずみの system', 'h');
  const before = { conversations: tableCount(s, 'conversations'), messages: tableCount(s, 'messages'), versions: tableCount(s, 'file_versions'), runs: tableCount(s, 'engine_runs'), kv: kvRows(s) };
  for (const id of ['ghost', 'bare', 'has']) {
    const usage = s.engine.contextUsage(id);
    assert.ok(usage.ok, id);
    assert.ok(usage.tokens > 0, id);
  }
  assert.deepEqual({ conversations: tableCount(s, 'conversations'), messages: tableCount(s, 'messages'), versions: tableCount(s, 'file_versions'), runs: tableCount(s, 'engine_runs'), kv: kvRows(s) }, before);
  assert.equal(s.conversations.get('ghost'), undefined, 'まだ無い会話は作らない');
  assert.equal(s.conversations.get('bare')!.snapshot, null, 'system をまだ固定していない会話は、固定しない');
  assert.equal(s.kv.get('snapshot-language:bare'), undefined);
  assert.equal(s.conversations.get('has')!.snapshot, '固定ずみの system', '固定ずみの会話は、その固定した文で数える');
  assert.equal(tableCount(s, 'file_versions'), 0, 'SOUL.md があっても、ファイルの版は書かない');
});

test('使用量: まだ固定していない会話は、そのとき作るはずの system で数える（最初の発言を足した数と、実行の見積もりが合う）', async t => {
  const s = await setup(t, { models: [localModel('a')], scripts: [reply('はい')] });
  const empty = s.engine.contextUsage('fresh');
  assert.ok(empty.ok);
  const message = 'はじめまして、よろしく';
  const outcome = s.engine.send('fresh', message);
  assert.ok(outcome.ok);
  const withMessage = s.engine.contextUsage('fresh');
  assert.ok(withMessage.ok);
  await s.engine.wait(outcome.runId);
  assert.equal(withMessage.tokens, s.runs.get(outcome.runId)!.est_prompt_tokens);
  const added = withMessage.tokens - empty.tokens;
  const expected = Math.ceil((4 + estimateTextTokens(message)) * 1.15);
  assert.ok(Math.abs(added - expected) <= 1, `発言の分だけ増える（増えた ${added}、見込み ${expected}）。system の数え方が固定のときと違えば大きくずれる`);
});

test('使用量: 容量を超えていても数える（ratio は 1 を超える）。投げない', async t => {
  const s = await longConversation(t);
  const usage = s.engine.contextUsage('c1');
  assert.ok(usage.ok);
  assert.ok(usage.ratio > 1, String(usage.ratio));
  assert.equal(usage.ratio, usage.tokens / usage.available);
  assert.equal(usage.capacity, 20000);
});

test('使用量: モデルは指定 → 無ければ会話で使う順番の最初の使えるモデル。指定が設定に無ければ 404、使えるモデルが無ければ 409', async t => {
  const s = await setup(t, { models: [localModel('a', { contextLength: 4096, minContext: 4096 }), localModel('b', { contextLength: 32768 }), localModel('c', { contextLength: 131072 })] });
  assert.equal(s.status.get('a')?.status, 'too_small');
  const auto = s.engine.contextUsage('c1');
  assert.ok(auto.ok);
  assert.equal(auto.modelId, 'b', '使えない a は飛ばして、順番の最初の使えるモデル');
  assert.equal(auto.capacity, 32768);
  const picked = s.engine.contextUsage('c1', 'c');
  assert.ok(picked.ok);
  assert.deepEqual([picked.modelId, picked.capacity], ['c', 131072]);
  assert.ok(picked.available > auto.available);
  assert.equal(picked.tokens, auto.tokens, '同じ会話なら、モデルが違っても同じ組み立て（補正が無いかぎり数は同じ）');
  const unknown = s.engine.contextUsage('c1', 'zzz');
  assert.deepEqual(unknown.ok === false && [unknown.httpStatus, unknown.errorKind, unknown.errorCode], [404, 'not_found', 'engine.usage.model_missing']);

  const none = await setup(t, { models: [localModel('a', { contextLength: 4096, minContext: 4096 })] });
  const refused = none.engine.contextUsage('c1');
  assert.ok(!refused.ok);
  assert.deepEqual([refused.httpStatus, refused.errorCode], [409, 'engine.no_usable']);
  assert.equal(refused.problems?.length, 1);
  const empty = await setup(t, { models: [] });
  const noModels = empty.engine.contextUsage('c1');
  assert.ok(!noModels.ok);
  assert.deepEqual([noModels.httpStatus, noModels.errorCode, noModels.problems], [409, 'engine.no_usable', []]);
});
