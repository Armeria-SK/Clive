import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { OpenAiCompatibleAdapter } from '../src/providers/openai-compatible.ts';
import { ProviderError } from '../src/providers/types.ts';
import type { ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import { CONVERSATION, fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { fail, fakeServer, reply, sse, tempDir } from './helpers.ts';

test('マイグレーション 9: conversations に model_id と effort が足される。前からある会話は NULL（自動・モデルの既定）', t => {
  const path = join(tempDir(t), 'clive.db');
  const before = openDatabase(path, MIGRATIONS.slice(0, 8));
  new Conversations(before).create({ id: 'old', title: '前からある会話' });
  before.close();
  const db = openDatabase(path, MIGRATIONS);
  try {
    const row = new Conversations(db).get('old') as unknown as Record<string, unknown>;
    assert.equal(row.model_id, null);
    assert.equal(row.effort, null);
  } finally { db.close(); }
});

test('PATCH: モデルを選ぶと会話に覚え、一覧とメッセージの応答に model_id が出る。設定に無い ID は 400、null は自動に戻す', async t => {
  const s = await startApp(t);
  await s.json('/api/conversations', 'POST', { title: '選ぶ' });
  const id = (s.app.conversations.list()[0]!).id;
  const ok = await s.json(`/api/conversations/${id}`, 'PATCH', { modelId: 'm2' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.conversation.model_id, 'm2');
  assert.equal((await s.json('/api/conversations', 'GET')).body.conversations[0].model_id, 'm2');
  assert.equal((await s.json(`/api/conversations/${id}/messages`, 'GET')).body.conversation.model_id, 'm2');
  const bad = await s.json(`/api/conversations/${id}`, 'PATCH', { modelId: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'http.unknown_model');
  assert.equal(s.app.conversations.get(id)!.model_id, 'm2' as never, '拒否したら変えない');
  const auto = await s.json(`/api/conversations/${id}`, 'PATCH', { modelId: null });
  assert.equal(auto.body.conversation.model_id, null);
  assert.equal((await s.json(`/api/conversations/${id}`, 'PATCH', { modelId: 5 })).status, 400);
});

test('選んだモデルだけを使う: 最初の発言で選べて、あとの送信でも覚えている。自動なら今までの順番', async t => {
  const s = await startApp(t);
  s.adapter().scripts = [reply('一つ目'), reply('二つ目'), reply('三つ目')];
  const first = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'こんにちは', modelId: 'm2' });
  assert.equal(first.status, 202);
  await settled(s.app, first.body.runId);
  assert.equal(s.adapter().calls.at(-1)!.model.id, 'm2');
  assert.equal(s.app.conversations.get(CONVERSATION)!.model_id, 'm2' as never, '渡されたら会話に覚える');
  const second = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'もう一度' });
  await settled(s.app, second.body.runId);
  assert.equal(s.adapter().calls.at(-1)!.model.id, 'm2', 'modelId を省いた送信は覚えたモデルのまま');
  const third = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: '自動に戻す', modelId: null });
  await settled(s.app, third.body.runId);
  assert.equal(s.adapter().calls.at(-1)!.model.id, 'm1', '自動は設定の順番の先頭');
  assert.equal(s.app.conversations.get(CONVERSATION)!.model_id, null);
});

test('選んだモデルが使えないとき、ほかのモデルへ黙って切り替えず、409 で止めて発言も保存しない', async t => {
  const s = await startApp(t);
  await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'はじめ' }).then(r => settled(s.app, r.body.runId));
  s.adapter().calls.length = 0;
  await s.json(`/api/conversations/${CONVERSATION}`, 'PATCH', { modelId: 'm2' });
  s.app.status.disable('m2', '落ちています');
  const before = s.app.conversations.messages(CONVERSATION).length;
  const sent = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'これは送られない' });
  assert.equal(sent.status, 409);
  assert.equal(sent.body.errorCode, 'engine.no_usable');
  assert.deepEqual(sent.body.problems.map((p: { modelId: string }) => p.modelId), ['m2'], '問題の一覧はそのモデルの 1 行だけ');
  assert.equal(s.adapter().calls.length, 0, 'm1 へ回さない');
  assert.equal(s.app.conversations.messages(CONVERSATION).length, before);
  const retry = await s.json(`/api/conversations/${CONVERSATION}/retry`, 'POST', {});
  assert.equal(retry.status, 409, 'やり直しも同じ');
  assert.equal(s.adapter().calls.length, 0);
});

test('「使えるモデルで送る」: 選んだモデルが使えないとき、使えるモデルを明示して送れば、そのモデルで返し、会話にも覚える（新しい会話の最初の発言でも同じ）', async t => {
  const s = await startApp(t);
  await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'はじめ', modelId: 'm2' }).then(r => settled(s.app, r.body.runId));
  s.app.status.disable('m2', '落ちています');
  s.adapter().calls.length = 0;
  const sent = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: '使えるほうで送る', modelId: 'm1' });
  assert.equal(sent.status, 202);
  await settled(s.app, sent.body.runId);
  assert.deepEqual(s.adapter().calls.map(c => c.model.id), ['m1']);
  assert.equal(s.app.conversations.get(CONVERSATION)!.model_id, 'm1');
  // 新しい会話: 最初の発言と一緒に、押したモデルだけを送る（画面で覚えていた古い選びや考える深さは送らない）
  const fresh = await s.json(`/api/conversations/${uuid(7)}/messages`, 'POST', { text: 'はじめて', modelId: 'm1' });
  assert.equal(fresh.status, 202);
  await settled(s.app, fresh.body.runId);
  assert.equal(s.app.conversations.get(uuid(7))!.model_id, 'm1');
});

test('選んだモデルが設定から消えたら not_in_config で止める。使える量の見積もり（A2）は選んだモデルで数える', async t => {
  const s = await startApp(t, { models: [fakeModel('m1', { contextLength: 65536 }), fakeModel('m2', { contextLength: 32768 })] });
  await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'はじめ', modelId: 'm2' }).then(r => settled(s.app, r.body.runId));
  const usage = await s.json(`/api/conversations/${CONVERSATION}/context`, 'GET');
  assert.equal(usage.status, 200);
  assert.equal(usage.body.modelId, 'm2', '輪の数は会話で選んだモデル');
  assert.equal(usage.body.capacity, 32768);
  assert.equal((await s.json(`/api/conversations/${CONVERSATION}/context?modelId=m1`, 'GET')).body.modelId, 'm1', '明示の modelId が先');
  const config = structuredClone(s.app.config());
  config.models = config.models.filter(m => m.id !== 'm2');
  config.routing.chat = ['m1'];
  await s.app.applyConfig(config);
  s.adapter().calls.length = 0;
  const sent = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: '消えたあと' });
  assert.equal(sent.status, 409);
  assert.equal(sent.body.problems[0].messageCode, 'engine.problem.not_in_config');
  assert.equal(s.adapter().calls.length, 0, '残っている m1 には回さない');
  assert.equal((await s.json(`/api/conversations/${CONVERSATION}/context`, 'GET')).status, 409, '見積もりも黙って別のモデルで数えない');
});

test('途中で失敗しても、選んだモデルなら別のモデルへ切り替えない（model.switch が出ない）', async t => {
  const s = await startApp(t);
  s.adapter().scripts = [fail(new ProviderError('provider_error', '503', { retryable: false }))];
  const events: string[] = [];
  s.app.bus.subscribe(e => events.push(e.event.type));
  const sent = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'やって', modelId: 'm2' });
  await settled(s.app, sent.body.runId);
  const result = { ok: s.app.runs.get(sent.body.runId)!.ok === 1 };
  assert.equal(result.ok, false);
  assert.deepEqual([...new Set(s.adapter().calls.map(c => c.model.id))], ['m2']);
  assert.ok(!events.includes('model.switch'));
});

test('画像の可否は選んだモデルで決める（選んだモデルが画像を読めなければ 409）', async t => {
  const s = await startApp(t, { models: [fakeModel('m1', { vision: true }), fakeModel('m2', { vision: false })] });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const up = await s.api('/api/uploads?name=a.png', { method: 'POST', body: png, headers: { 'Content-Type': 'image/png' } });
  const uploadId = ((await up.json()) as { upload: { id: string } }).upload.id;
  const pinned = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: '画像', attachments: [uploadId], modelId: 'm2' });
  assert.equal(pinned.status, 409);
  assert.equal(pinned.body.error, 'no_vision');
  s.adapter().scripts = [reply('見ました')];
  const auto = await s.json(`/api/conversations/${uuid(2)}/messages`, 'POST', { text: '画像', attachments: [uploadId] });
  assert.equal(auto.status, 202, '自動なら vision のモデルがある');
});

const efforts = ['low', 'medium', 'xhigh'];

test('エフォート: そのモデルの efforts にある値だけ選べる。要求に届き、実行の印（flags）に effort:<値> が残る', async t => {
  const s = await startApp(t, { models: [fakeModel('m1', { efforts }), fakeModel('m2')] });
  const model = (await s.json('/api/models', 'GET')).body.models;
  assert.deepEqual(model.find((m: { id: string }) => m.id === 'm1').efforts, efforts);
  assert.deepEqual(model.find((m: { id: string }) => m.id === 'm2').efforts, []);
  await s.json('/api/conversations', 'POST', {});
  const id = s.app.conversations.list()[0]!.id;
  const bad = await s.json(`/api/conversations/${id}`, 'PATCH', { modelId: 'm1', effort: 'high' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'http.bad_effort');
  assert.equal(s.app.conversations.get(id)!.model_id, null as never, '400 なら何も変えない');
  const good = await s.json(`/api/conversations/${id}`, 'PATCH', { modelId: 'm1', effort: 'xhigh' });
  assert.equal(good.status, 200);
  assert.equal(good.body.conversation.effort, 'xhigh');
  assert.equal((await s.json(`/api/conversations/${id}`, 'PATCH', { modelId: 'm2', effort: 'low' })).status, 400, 'efforts の無いモデルには選べない');
  s.adapter().scripts = [reply('はい')];
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: '深く考えて' });
  await settled(s.app, sent.body.runId);
  assert.equal(s.adapter().calls.at(-1)!.effort, 'xhigh');
  assert.ok(JSON.parse(s.app.runs.get(sent.body.runId)!.flags).includes('effort:xhigh'));
  s.adapter().scripts = [reply('はい')];
  const plain = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: '既定で', effort: null });
  await settled(s.app, plain.body.runId);
  assert.equal(s.adapter().calls.at(-1)!.effort, undefined, 'null は何も送らない');
  assert.ok(!JSON.parse(s.app.runs.get(plain.body.runId)!.flags).some((f: string) => f.startsWith('effort:')));
});

test('エフォート: モデルを変えて今の値が新しいモデルに無ければ null に戻し、応答で知らせる', async t => {
  const s = await startApp(t, { models: [fakeModel('m1', { efforts }), fakeModel('m2', { efforts: ['low'] }), fakeModel('m3')] });
  await s.json('/api/conversations', 'POST', {});
  const id = s.app.conversations.list()[0]!.id;
  await s.json(`/api/conversations/${id}`, 'PATCH', { modelId: 'm1', effort: 'xhigh' });
  const same = await s.json(`/api/conversations/${id}`, 'PATCH', { modelId: 'm2' });
  assert.equal(same.body.conversation.effort, null, 'xhigh は m2 に無い');
  assert.equal(same.body.effortReset, true);
  await s.json(`/api/conversations/${id}`, 'PATCH', { modelId: 'm1', effort: 'low' });
  const kept = await s.json(`/api/conversations/${id}`, 'PATCH', { modelId: 'm2' });
  assert.equal(kept.body.conversation.effort, 'low', 'low は m2 にもあるので残す');
  assert.ok(!kept.body.effortReset);
});

test('エフォート: 送信でモデルを替えて今の値が新しいモデルに無いときも、送信の応答で effortReset を知らせる（実行中に待たせたときも同じ）', async t => {
  const s = await startApp(t, { models: [fakeModel('m1', { efforts }), fakeModel('m2', { efforts: ['low'] })] });
  const post = (body: Record<string, unknown>) => s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', body);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  s.adapter().scripts = [reply('はじめ'), async function* () { await gate; yield { type: 'text', delta: 'ゆっくり' }; yield { type: 'done', stop: 'end_turn' }; }, reply('おわり')];
  const first = await post({ text: 'はじめ', modelId: 'm1', effort: 'xhigh' });
  assert.equal(first.status, 202);
  assert.ok(!first.body.effortReset);
  await settled(s.app, first.body.runId);
  const changed = await post({ text: 'ゆっくり', modelId: 'm2' });
  assert.equal(changed.status, 202);
  assert.equal(changed.body.effortReset, true, 'xhigh は m2 に無いので、null に戻したことを知らせる');
  assert.equal(s.app.conversations.get(CONVERSATION)!.effort, null);
  // 実行中に、モデルを替える送信（待たせる）でも同じ
  await s.json(`/api/conversations/${CONVERSATION}`, 'PATCH', { modelId: 'm1', effort: 'xhigh' });
  const queued = await post({ text: '待たせる', modelId: 'm2' });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.queued, true);
  assert.equal(queued.body.effortReset, true);
  release();
  await settled(s.app, changed.body.runId);
});

test('エフォート: 設定の efforts は openai_compatible だけ。確認した結果（supported_reasoning_efforts）も使うが、設定が先', async t => {
  const s = await startApp(t, {
    models: [fakeModel('m1'), fakeModel('m2', { efforts: ['low'] }), fakeModel('o', { provider: 'ollama-like', efforts })],
    configure: config => { config.providers.push({ id: 'ollama-like', kind: 'ollama', baseUrl: 'http://127.0.0.1:2', maxParallel: 1, timeoutMs: 10_000 }); },
  });
  s.adapter().probeResult = { efforts: ['low', 'medium', 'xhigh'] } as never;
  await s.app.status.probeAll(s.app.config());
  const models = (await s.json('/api/models', 'GET')).body.models as Array<{ id: string; efforts: string[] }>;
  assert.deepEqual(models.find(m => m.id === 'm1')!.efforts, ['low', 'medium', 'xhigh'], '確認で分かった値');
  assert.deepEqual(models.find(m => m.id === 'm2')!.efforts, ['low'], '設定に書けばそれが先');
  assert.deepEqual(models.find(m => m.id === 'o')!.efforts, [], 'Ollama のモデルに書いても使わない');
});

function compat(baseUrl: string, server: ProviderConfig['server'] = 'generic'): ProviderConfig {
  return { id: 'p', kind: 'openai_compatible', baseUrl, server, maxParallel: 1, timeoutMs: 5000 };
}
const model = (over: Partial<ModelConfig> = {}): ModelConfig => fakeModel('m', { provider: 'p', model: 'qwen', ...over });

test('providers: /v1/models の supported_reasoning_efforts を、サーバーの種類を問わず確認の結果に入れる。無ければ入れない', async t => {
  const list = (entry: object) => async (req: import('node:http').IncomingMessage, _b: unknown, res: import('node:http').ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url?.includes('/api/v0/')) { res.end(JSON.stringify({ state: 'loaded', loaded_context_length: 70000, max_context_length: 70000 })); return; }
    res.end(JSON.stringify({ data: [{ id: 'qwen', ...entry }] }));
  };
  const withEfforts = await fakeServer(list({ context_length: 70000, supported_reasoning_efforts: ['low', 'medium', 'xhigh'] }));
  const without = await fakeServer(list({ context_length: 70000 }));
  t.after(async () => { await withEfforts.close(); await without.close(); });
  const generic = await new OpenAiCompatibleAdapter(compat(`${withEfforts.url}/v1`), {}).probe(model(), 4096);
  assert.deepEqual(generic.efforts, ['low', 'medium', 'xhigh']);
  const lm = await new OpenAiCompatibleAdapter(compat(`${withEfforts.url}/v1`, 'lmstudio'), {}).probe(model(), 4096);
  assert.equal(lm.status, 'ok');
  assert.deepEqual(lm.efforts, ['low', 'medium', 'xhigh'], 'LM Studio でも読む');
  assert.equal((await new OpenAiCompatibleAdapter(compat(`${without.url}/v1`), {}).probe(model(), 4096)).efforts, undefined);
});

test('providers: effort があれば要求に reasoning_effort を入れ、無ければ入れない', async t => {
  const server = await fakeServer((_req, _body, res) => sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
  t.after(() => server.close());
  const adapter = new OpenAiCompatibleAdapter(compat(`${server.url}/v1`), {});
  const base = { model: model(), system: { frozen: '', dynamic: '' }, messages: [{ role: 'user' as const, content: 'hi' }], tools: [], maxOutputTokens: 64, signal: new AbortController().signal };
  for await (const _ of adapter.stream({ ...base, effort: 'xhigh' })) void _;
  for await (const _ of adapter.stream(base)) void _;
  assert.equal(server.requests[0]!.body.reasoning_effort, 'xhigh');
  assert.ok(!('reasoning_effort' in server.requests[1]!.body));
});
