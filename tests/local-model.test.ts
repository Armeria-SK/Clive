import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderConfig } from '../src/config/schema.ts';
import { isLocalModel, isLocalProvider, localModelIds } from '../src/engine/local-model.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, type Script, testConfig } from './helpers.ts';

type Started = Awaited<ReturnType<typeof startApp>>;

const provider = (over: Partial<ProviderConfig>): ProviderConfig => ({ id: 'p', kind: 'openai_compatible', maxParallel: 1, timeoutMs: 10_000, ...over });
const call = (name: string, args: unknown): Script => async function* () {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call: toolCall };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};
const WORD = 'xyzzyquux';

// 手元（ループバック）の提供元 fake と、外の提供元 ext。モデル: loc・loc2（手元）と ext1・ext2（外）
function twoProviders(background: string[]) {
  return {
    models: [fakeModel('loc'), fakeModel('loc2'), fakeModel('ext1', { provider: 'ext' }), fakeModel('ext2', { provider: 'ext' })],
    configure: (c: ReturnType<typeof testConfig>) => {
      c.providers.push({ id: 'ext', kind: 'openai_compatible', baseUrl: 'https://models.example.test/v1', maxParallel: 1, timeoutMs: 10_000 });
      c.routing = { chat: ['loc', 'loc2', 'ext1', 'ext2'], background, retriesPerModel: 0 };
    },
  };
}

function chatWith(s: Started, id: string, modelId: string | null, text: string): void {
  s.app.conversations.create({ id, title: `会話 ${id.slice(-2)}` });
  if (modelId) s.app.conversations.setChoice(id, { modelId });
  s.app.conversations.append(id, { role: 'user', content: text });
}

test('手元のモデルの判定: 提供元の baseUrl がループバックのホスト。Ollama の既定の接続先も手元。外のホスト・LAN・接続先なしは違う', () => {
  assert.equal(isLocalProvider(provider({ baseUrl: 'http://127.0.0.1:1234/v1' })), true);
  assert.equal(isLocalProvider(provider({ baseUrl: 'http://localhost:8080/v1' })), true);
  assert.equal(isLocalProvider(provider({ baseUrl: 'http://[::1]:8080/v1' })), true);
  assert.equal(isLocalProvider(provider({ kind: 'ollama' })), true, 'Ollama は baseUrl が無ければ既定の 127.0.0.1');
  assert.equal(isLocalProvider(provider({ kind: 'ollama', baseUrl: 'http://192.168.1.20:11434' })), false, 'LAN の別のマシンは手元ではない');
  assert.equal(isLocalProvider(provider({ baseUrl: 'https://api.example.test/v1' })), false);
  assert.equal(isLocalProvider(provider({ baseUrl: 'http://127.0.0.1.example.test/v1' })), false, '名前の前半が似ているだけ');
  assert.equal(isLocalProvider(provider({ kind: 'anthropic' })), false, 'Anthropic の既定の接続先は外');
  assert.equal(isLocalProvider(provider({ baseUrl: 'not a url' })), false);
  const config = testConfig();
  config.providers = [provider({ id: 'a', baseUrl: 'http://127.0.0.1:1/v1' }), provider({ id: 'b', baseUrl: 'https://x.example.test/v1' })];
  config.models = [fakeModel('m-a', { provider: 'a' }), fakeModel('m-b', { provider: 'b' }), fakeModel('m-c', { provider: 'gone' })];
  assert.deepEqual(localModelIds(config), ['m-a']);
  assert.equal(isLocalModel(config, 'm-a'), true);
  assert.equal(isLocalModel(config, 'm-b'), false);
  assert.equal(isLocalModel(config, 'm-c'), false, '提供元が設定に無いモデルは、手元と言えない');
  assert.equal(isLocalModel(config, 'unknown'), false);
  assert.equal(isLocalModel(config, null), false);
});

// ── 3a: 振り返り ──
const reviewJobs = (s: Started) => s.app.reviews.list();
const reviewConversations = (s: Started) => (s.app.db.prepare("SELECT id FROM conversations WHERE kind = 'task'").all() as Array<{ id: string }>);

test('振り返り: 手元のモデルで話した会話は、手元の裏方モデルだけで振り返る（外のモデルには渡さない）', async t => {
  const s = await startApp(t, twoProviders(['ext1', 'loc2', 'ext2']));
  const id = uuid(1);
  chatWith(s, id, 'loc', 'ローカルでだけ話した内容');
  s.adapter().scripts = [reply('変更なし')];
  s.app.reviews.enqueue('manual', `manual:${id}`, { conversationId: id });
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.adapters.get('ext')!.calls.length, 0, '外のモデルは呼ばれない');
  assert.deepEqual(s.adapter().calls.map(c => c.model.id), ['loc2'], '裏方の順番のうち手元のモデルだけ');
  assert.match(String(s.adapter().calls[0]!.messages.at(-1)?.content), /ローカルでだけ話した内容/u);
  assert.equal(reviewJobs(s)[0]!.status, 'done');
});

test('振り返り: 手元の裏方モデルが 1 つも使えないときは、その会話の振り返りを飛ばす（外のモデルに回さない・空の会話も作らない・不調の通知も出さない）', async t => {
  const s = await startApp(t, twoProviders(['ext1', 'ext2']));
  const id = uuid(1);
  chatWith(s, id, 'loc', 'ローカルでだけ話した内容');
  s.app.reviews.enqueue('manual', `manual:${id}`, { conversationId: id });
  await s.app.worker.tick();
  assert.equal(s.adapters.get('ext')!.calls.length, 0);
  assert.equal(s.adapter().calls.length, 0);
  const [job] = reviewJobs(s);
  assert.equal(job!.status, 'done', '失敗でも待ちでもなく、飛ばして終わり');
  assert.match(job!.note ?? '', /飛ばしました/u);
  assert.deepEqual(reviewConversations(s), [], '振り返りの会話を作らない');
  assert.equal(s.app.notifications.list().filter(n => n.kind === 'health_alert').length, 0);
  assert.equal(await s.app.worker.tick(), 'idle', '次の回で繰り返さない');
});

test('振り返り: 裏方の順番が空なら、手元の会話でもチャットの順番や外のモデルに回さず飛ばす', async t => {
  const s = await startApp(t, twoProviders([]));
  const id = uuid(1);
  chatWith(s, id, 'loc', 'ローカルでだけ話した内容');
  s.app.reviews.enqueue('manual', `manual:${id}`, { conversationId: id });
  await s.app.worker.tick();
  assert.equal(s.adapter().calls.length + s.adapters.get('ext')!.calls.length, 0, 'チャットの順番（手元のモデルを含む）にも回さない');
  assert.equal(reviewJobs(s)[0]!.status, 'done');
});

test('振り返り: 手元でない（自動・外のモデル）の会話は、今までどおり裏方の順番で振り返る', async t => {
  const s = await startApp(t, twoProviders(['ext1', 'loc2']));
  const auto = uuid(1);
  const pinnedExternal = uuid(2);
  chatWith(s, auto, null, '自動の会話');
  chatWith(s, pinnedExternal, 'ext1', '外のモデルの会話');
  s.adapters.get('ext')!.scripts = [reply('変更なし'), reply('変更なし')];
  s.app.reviews.enqueue('manual', `manual:${auto}`, { conversationId: auto });
  s.app.reviews.enqueue('manual', `manual:${pinnedExternal}`, { conversationId: pinnedExternal });
  await s.app.worker.tick();
  await s.app.worker.tick();
  assert.deepEqual(s.adapters.get('ext')!.calls.map(c => c.model.id), ['ext1', 'ext1']);
  assert.equal(s.adapter().calls.length, 0);
});

// ── 3b: 履歴の検索 ──
const toolResult = (s: Started, conversationId: string) => (s.app.conversations.messages(conversationId).find(m => m.role === 'tool')?.text ?? '');

async function searchFrom(s: Started, conversationId: string, modelId: string | null, script: Script, adapterId: 'fake' | 'ext'): Promise<string> {
  s.app.conversations.create({ id: conversationId, title: '検索する会話' });
  if (modelId) s.app.conversations.setChoice(conversationId, { modelId });
  s.adapters.get(adapterId)!.scripts = [script, reply('おわり')];
  const sent = await s.json(`/api/conversations/${conversationId}/messages`, 'POST', { text: '前の話を探して' });
  assert.equal(sent.status, 202);
  await settled(s.app, sent.body.runId);
  return toolResult(s, conversationId);
}

function historyFixtures(s: Started) {
  chatWith(s, uuid(11), 'loc2', `手元の会話 ${WORD} の話`);
  chatWith(s, uuid(12), null, `自動の会話 ${WORD} の話`);
  chatWith(s, uuid(13), 'ext2', `外のモデルの会話 ${WORD} の話`);
}

test('履歴の検索: 外のモデルの実行からは、手元のモデルを選んだ会話の発言を出さない（自動・外のモデルの会話は出る）', async t => {
  const s = await startApp(t, twoProviders([]));
  historyFixtures(s);
  const text = await searchFrom(s, uuid(20), 'ext1', call('history_search', { query: WORD }), 'ext');
  assert.match(text, /自動の会話/u);
  assert.match(text, /外のモデルの会話/u);
  assert.doesNotMatch(text, /手元の会話/u, '手元のモデルの会話の内容は、外のモデルに渡さない');
});

test('履歴の検索: 自動の会話で、鎖に外のモデルが含まれるときも、手元の会話は出さない（途中で外のモデルに替わりうる）', async t => {
  const s = await startApp(t, twoProviders([]));
  historyFixtures(s);
  const text = await searchFrom(s, uuid(20), null, call('history_search', { query: WORD }), 'fake');
  assert.match(text, /自動の会話/u);
  assert.doesNotMatch(text, /手元の会話/u);
});

test('履歴の検索: 手元のモデルだけの実行からは、手元の会話も検索できる', async t => {
  const s = await startApp(t, twoProviders([]));
  historyFixtures(s);
  const text = await searchFrom(s, uuid(20), 'loc', call('history_search', { query: WORD }), 'fake');
  assert.match(text, /手元の会話/u);
  assert.match(text, /外のモデルの会話/u);
});

test('履歴の読み出し: 外のモデルの実行は、手元の会話の ID を知っていても読めない（無いときと同じ答え）。手元の実行は読める', async t => {
  const s = await startApp(t, twoProviders([]));
  historyFixtures(s);
  const denied = await searchFrom(s, uuid(20), 'ext1', call('history_read', { conversation_id: uuid(11) }), 'ext');
  assert.doesNotMatch(denied, /手元の会話/u);
  assert.equal(denied, await searchFrom(s, uuid(21), 'ext1', call('history_read', { conversation_id: uuid(99) }), 'ext'), '存在しない会話と同じ文');
  const allowed = await searchFrom(s, uuid(22), 'loc', call('history_read', { conversation_id: uuid(11) }), 'fake');
  assert.match(allowed, /手元の会話/u);
});

test('画面の履歴検索（GET /api/history）は今までどおり、手元の会話も出す', async t => {
  const s = await startApp(t, twoProviders([]));
  historyFixtures(s);
  const res = await s.json(`/api/history?q=${WORD}`, 'GET');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.hits.map((h: { conversationId: string }) => h.conversationId).sort(), [uuid(11), uuid(12), uuid(13)]);
});
