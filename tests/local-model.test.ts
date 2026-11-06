import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ProviderConfig } from '../src/config/schema.ts';
import { externalModelIds, isLocalModel, isLocalPinned, isLocalProvider, localModelIds } from '../src/engine/local-model.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { readHistory, searchHistory } from '../src/memory/history.ts';
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

// ── 2: 選んだモデルが設定から消えた会話は、手元として扱う（外へ回さない側に倒す） ──
test('会話で選んだモデルの判定（isLocalPinned）: 選んでいて、外と分かっているモデルでなければ手元。消えた・名前を変えた・提供元が無いモデルも手元', () => {
  const config = testConfig();
  config.providers = [provider({ id: 'a', baseUrl: 'http://127.0.0.1:1/v1' }), provider({ id: 'b', baseUrl: 'https://x.example.test/v1' })];
  config.models = [fakeModel('m-a', { provider: 'a' }), fakeModel('m-b', { provider: 'b' }), fakeModel('m-c', { provider: 'gone' })];
  assert.deepEqual(externalModelIds(config), ['m-b'], '外と分かっているのは、提供元があって手元でないモデルだけ');
  assert.equal(isLocalPinned(config, 'm-a'), true);
  assert.equal(isLocalPinned(config, 'm-b'), false);
  assert.equal(isLocalPinned(config, 'm-c'), true, '提供元が設定に無いモデルは、外と分からないので手元');
  assert.equal(isLocalPinned(config, 'removed-model'), true, '設定に無い（消した・名前を変えた）モデルも手元');
  assert.equal(isLocalPinned(config, null), false, '選んでいない（自動）は対象外');
  assert.equal(isLocalPinned(config, undefined), false);
});

const gone = (s: Started) => {
  const config = JSON.parse(readFileSync(s.paths.config, 'utf8')) as ReturnType<typeof testConfig>;
  config.models = config.models.filter(m => m.id !== 'loc');
  config.routing.chat = config.routing.chat.filter(id => id !== 'loc');
  writeFileSync(s.paths.config, JSON.stringify(config));
  assert.ok(!s.app.config().models.some(m => m.id === 'loc'), '前提: 設定から消えた');
};

test('振り返り: 手元のモデルを選んだあと、そのモデルを設定から消した会話も、外のモデルに回さず飛ばす', async t => {
  const s = await startApp(t, twoProviders(['ext1', 'ext2']));
  const id = uuid(1);
  chatWith(s, id, 'loc', 'ローカルでだけ話した内容');
  gone(s);
  s.app.reviews.enqueue('manual', `manual:${id}`, { conversationId: id });
  await s.app.worker.tick();
  assert.equal(s.adapters.get('ext')!.calls.length, 0, '外のモデルは呼ばれない');
  assert.equal(s.adapter().calls.length, 0);
  const [job] = reviewJobs(s);
  assert.equal(job!.status, 'done');
  assert.match(job!.note ?? '', /飛ばしました/u);
  assert.deepEqual(reviewConversations(s), [], '振り返りの会話を作らない');
});

test('振り返り: 選んだモデルが設定から消えた会話は、裏方の順番のうち手元のモデルだけで振り返る', async t => {
  const s = await startApp(t, twoProviders(['ext1', 'loc2', 'ext2']));
  const id = uuid(1);
  chatWith(s, id, 'loc', 'ローカルでだけ話した内容');
  gone(s);
  s.adapter().scripts = [reply('変更なし')];
  s.app.reviews.enqueue('manual', `manual:${id}`, { conversationId: id });
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.adapters.get('ext')!.calls.length, 0, '外のモデルは呼ばれない');
  assert.deepEqual(s.adapter().calls.map(c => c.model.id), ['loc2']);
});

test('履歴の検索・読み出し: 選んだモデルが設定に無い会話も手元として扱い、外のモデルの実行には出さない（手元のモデルだけの実行・画面の検索は出す）', async t => {
  const s = await startApp(t, twoProviders([]));
  historyFixtures(s);
  chatWith(s, uuid(14), 'removed-model', `消えたモデルの会話 ${WORD} の話`);
  const text = await searchFrom(s, uuid(20), 'ext1', call('history_search', { query: WORD }), 'ext');
  assert.match(text, /外のモデルの会話/u);
  assert.match(text, /自動の会話/u);
  assert.doesNotMatch(text, /消えたモデルの会話/u, '設定に無いモデルを選んだ会話は、外のモデルに渡さない');
  assert.doesNotMatch(text, /手元の会話/u);
  const denied = await searchFrom(s, uuid(21), 'ext1', call('history_read', { conversation_id: uuid(14) }), 'ext');
  assert.doesNotMatch(denied, /消えたモデルの会話/u);
  assert.equal(denied, await searchFrom(s, uuid(22), 'ext1', call('history_read', { conversation_id: uuid(99) }), 'ext'), '存在しない会話と同じ文');
  const local = await searchFrom(s, uuid(23), 'loc', call('history_search', { query: WORD }), 'fake');
  assert.match(local, /消えたモデルの会話/u, '手元のモデルだけの実行には出る');
  const screen = await s.json(`/api/history?q=${WORD}`, 'GET');
  assert.ok(screen.body.hits.some((h: { conversationId: string }) => h.conversationId === uuid(14)), '画面の検索は今までどおり全部');
});

test('履歴の検索・読み出しの visibleModelIds: 空の一覧を渡すと、モデルを選んでいない会話だけが見える。渡さなければ全部', async t => {
  const s = await startApp(t, twoProviders([]));
  historyFixtures(s);
  const ids = (options: { visibleModelIds?: string[] }) => searchHistory(s.app.db, WORD, options).map(h => h.conversationId).sort();
  assert.deepEqual(ids({}), [uuid(11), uuid(12), uuid(13)]);
  assert.deepEqual(ids({ visibleModelIds: [] }), [uuid(12)], '選んでいない会話だけ');
  assert.deepEqual(ids({ visibleModelIds: ['ext2'] }), [uuid(12), uuid(13)]);
  assert.equal(readHistory(s.app.db, uuid(13), { visibleModelIds: [] }).length, 0);
  assert.equal(readHistory(s.app.db, uuid(12), { visibleModelIds: [] }).length, 1);
  assert.equal(readHistory(s.app.db, uuid(13), {}).length, 1);
});

function taskConversation(s: Started, id: string, localOnly: boolean, text: string) {
  const task = s.app.tasks.create({ title: `タスク ${id.slice(-2)}`, origin: 'user', actor: 'user', localOnly });
  s.app.conversations.create({ id, kind: 'task', title: `タスクの会話 ${id.slice(-2)}` });
  s.app.conversations.append(id, { role: 'user', content: text });
  assert.ok(s.app.tasks.claim(task.id, 60_000, id), '前提: タスクの会話として結び付いた');
  return task;
}

test('履歴の検索・読み出し: 手元のモデルだけで動かすタスク（local_only）の会話も、外のモデルが入る実行には出さない。手元だけの実行・画面の検索には出る', async t => {
  const s = await startApp(t, twoProviders([]));
  historyFixtures(s);
  taskConversation(s, uuid(31), true, `手元だけのタスクの内容 ${WORD}`);
  taskConversation(s, uuid(32), false, `ふつうのタスクの内容 ${WORD}`);

  const external = await searchFrom(s, uuid(20), 'ext1', call('history_search', { query: WORD }), 'ext');
  assert.match(external, /ふつうのタスクの内容/u, '手元でないタスクの会話は出る');
  assert.doesNotMatch(external, /手元だけのタスクの内容/u, '手元のタスクの会話は、外のモデルに渡さない');
  const auto = await searchFrom(s, uuid(21), null, call('history_search', { query: WORD }), 'fake');
  assert.doesNotMatch(auto, /手元だけのタスクの内容/u, '自動の会話の鎖に外のモデルが含まれるときも出さない');

  const denied = await searchFrom(s, uuid(22), 'ext1', call('history_read', { conversation_id: uuid(31) }), 'ext');
  assert.doesNotMatch(denied, /手元だけのタスクの内容/u);
  assert.equal(denied, await searchFrom(s, uuid(23), 'ext1', call('history_read', { conversation_id: uuid(99) }), 'ext'), '存在しない会話と同じ文');
  assert.match(await searchFrom(s, uuid(24), 'ext1', call('history_read', { conversation_id: uuid(32) }), 'ext'), /ふつうのタスクの内容/u);

  const local = await searchFrom(s, uuid(25), 'loc', call('history_search', { query: WORD }), 'fake');
  assert.match(local, /手元だけのタスクの内容/u, '手元のモデルだけの実行には出る');
  assert.match(await searchFrom(s, uuid(26), 'loc', call('history_read', { conversation_id: uuid(31) }), 'fake'), /手元だけのタスクの内容/u);
  const screen = await s.json(`/api/history?q=${WORD}`, 'GET');
  assert.ok(screen.body.hits.some((h: { conversationId: string }) => h.conversationId === uuid(31)), '画面の検索は今までどおり全部');
});

test('履歴の検索・読み出しの visibleModelIds: タスクがあとから local_only になれば、その会話も見えなくなる。会話に結び付かないタスクは何も隠さない', async t => {
  const s = await startApp(t, twoProviders([]));
  const task = taskConversation(s, uuid(32), false, `ふつうのタスクの内容 ${WORD}`);
  s.app.tasks.create({ title: '会話がまだ無いタスク', origin: 'user', actor: 'user', localOnly: true });
  const ids = (options: { visibleModelIds?: string[] }) => searchHistory(s.app.db, WORD, options).map(h => h.conversationId);
  assert.deepEqual(ids({ visibleModelIds: ['ext2'] }), [uuid(32)]);
  assert.equal(readHistory(s.app.db, uuid(32), { visibleModelIds: ['ext2'] }).length, 1);
  s.app.tasks.markLocalOnly(task.id);
  assert.deepEqual(ids({ visibleModelIds: ['ext2'] }), []);
  assert.deepEqual(ids({}), [uuid(32)], '一覧を渡さなければ（画面の検索）全部');
  assert.equal(readHistory(s.app.db, uuid(32), { visibleModelIds: ['ext2'] }).length, 0);
  assert.equal(readHistory(s.app.db, uuid(32), {}).length, 1);
});

// ── 3:手元のモデルを選んだ会話から作ったタスクは、手元のモデルだけで動かす ──
const taskRows = (s: Started) => s.app.tasks.list({ statuses: ['inbox', 'ready', 'running', 'waiting', 'scheduled', 'done', 'failed', 'cancelled'] });

async function runIn(s: Started, id: string, modelId: string | null, scripts: Script[], adapterId: 'fake' | 'ext' = 'fake'): Promise<void> {
  if (!s.app.conversations.get(id)) s.app.conversations.create({ id, title: '会話' });
  if (modelId) s.app.conversations.setChoice(id, { modelId });
  s.adapters.get(adapterId)!.scripts = scripts;
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'タスクにして' });
  assert.equal(sent.status, 202);
  await settled(s.app, sent.body.runId);
  await s.app.engine.wait(sent.body.runId);
}
const complete = call('task_complete', { summary: 'できた', notify: false });

test('タスク: 手元のモデルを選んだ会話の task_create で作ったタスクは local_only。自動・外のモデルの会話のものは違う', async t => {
  const s = await startApp(t, twoProviders([]));
  await runIn(s, uuid(1), 'loc', [call('task_create', { title: '手元の会話のタスク', requested_by_user: true }), reply('作りました')], 'fake');
  await runIn(s, uuid(2), 'ext1', [call('task_create', { title: '外のモデルの会話のタスク', requested_by_user: true }), reply('作りました')], 'ext');
  await runIn(s, uuid(3), null, [call('task_create', { title: '自動の会話のタスク', requested_by_user: true }), reply('作りました')], 'fake');
  const byTitle = Object.fromEntries(taskRows(s).map(task => [task.title, task.local_only]));
  assert.deepEqual(byTitle, { 手元の会話のタスク: 1, 外のモデルの会話のタスク: 0, 自動の会話のタスク: 0 });
});

test('タスク: 手元のモデルを選んだ会話の繰り返しのタスクから作られる実行も local_only を引き継ぐ', async t => {
  const s = await startApp(t, twoProviders([]));
  await runIn(s, uuid(1), 'loc', [call('task_create', { title: '毎朝', repeat: '0 9 * * *', requested_by_user: true }), reply('作りました')], 'fake');
  const template = taskRows(s).find(task => task.title === '毎朝')!;
  assert.equal(template.local_only, 1);
  assert.equal(s.app.tasks.spawnNow(template.id)!.local_only, 1, '予定から作る実行');
});

test('タスク: 手元のモデルを選んだ会話で task_update したタスクも local_only になる（会話の文がメモとして入るため）。外のモデルの会話では変わらない', async t => {
  const s = await startApp(t, twoProviders([]));
  const mine = s.app.tasks.create({ title: '前からあるタスク', origin: 'user', actor: 'user' });
  const other = s.app.tasks.create({ title: '別のタスク', origin: 'user', actor: 'user' });
  await runIn(s, uuid(1), 'loc', [call('task_update', { id: mine.id.slice(0, 8), note: '手元の会話で決めたこと' }), reply('書きました')], 'fake');
  await runIn(s, uuid(2), 'ext1', [call('task_update', { id: other.id.slice(0, 8), note: '外のモデルの会話で決めたこと' }), reply('書きました')], 'ext');
  assert.equal(s.app.tasks.get(mine.id)!.local_only, 1);
  assert.equal(s.app.tasks.get(other.id)!.local_only, 0);
});

test('タスク: 道具の上限のまとめ（会話の経過をタスクのメモへ書く）が手元のモデルの会話から書かれたら、書き先のタスクも local_only になる', async t => {
  const s = await startApp(t, { ...twoProviders([]), configure: c => { twoProviders([]).configure(c); c.tools.maxIterations = 1; } });
  const id = uuid(1);
  const created = s.app.tasks.create({ title: 'この会話で作ったタスク', origin: 'user', actor: 'user', createdInConversation: id });
  await runIn(s, id, 'loc', [call('task_list', {}), reply('ここまでやりました。次の一手: 続きを書く')]);
  const task = s.app.tasks.get(created.id)!;
  assert.match(task.body, /ここまでやりました/u, '前提: まとめがメモに書かれた');
  assert.equal(task.local_only, 1);
});

test('タスクの実行: local_only のタスクは、裏方の順番のうち手元のモデルだけで動かす。そうでないタスクは今までどおり順番どおり', async t => {
  const s = await startApp(t, twoProviders(['ext1', 'loc2', 'ext2']));
  s.app.tasks.create({ title: '手元だけで', origin: 'user', actor: 'user', localOnly: true });
  s.adapter().scripts = [complete];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.adapters.get('ext')!.calls.length, 0, '外のモデルは呼ばれない');
  assert.deepEqual(s.adapter().calls.map(c => c.model.id), ['loc2']);
  assert.equal(taskRows(s).find(task => task.title === '手元だけで')!.status, 'done');

  s.app.tasks.create({ title: '普通のタスク', origin: 'user', actor: 'user' });
  s.adapters.get('ext')!.scripts = [complete];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.deepEqual(s.adapters.get('ext')!.calls.map(c => c.model.id), ['ext1'], '手元でないタスクは裏方の順番の先頭');
});

test('タスクの実行: 使える手元の裏方モデルが無ければ、外のモデルに回さず待つ（回数も数えず、不調の通知も出さない）。順番が空でもチャットの順番には回さない', async t => {
  for (const background of [['ext1', 'ext2'], []]) {
    const s = await startApp(t, twoProviders(background));
    const task = s.app.tasks.create({ title: '手元だけで', origin: 'user', actor: 'user', localOnly: true });
    assert.equal(await s.app.worker.tick(), 'no_model');
    assert.equal(s.adapter().calls.length + s.adapters.get('ext')!.calls.length, 0, `どのモデルも呼ばれない（裏方の順番: ${JSON.stringify(background)}）`);
    const waiting = s.app.tasks.get(task.id)!;
    assert.equal(waiting.status, 'ready');
    assert.ok(waiting.run_at! > Date.now(), 'あとでもう一度');
    assert.equal(waiting.attempts, 0);
    assert.match(s.app.tasks.events(task.id).find(e => e.kind === 'requeued')!.content ?? '', /手元のモデル/u);
    assert.equal(s.app.notifications.list().filter(n => n.kind === 'health_alert').length, 0);
  }
});

test('タスクの実行: local_only のタスクが task_create で作る子のタスクも local_only（手元のタスクを経由して外へ出さない）', async t => {
  const s = await startApp(t, twoProviders(['loc2']));
  s.app.tasks.create({ title: '手元だけで', origin: 'user', actor: 'user', localOnly: true });
  s.adapter().scripts = [call('task_create', { title: '子のタスク', requested_by_user: true }), complete];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(taskRows(s).find(task => task.title === '子のタスク')!.local_only, 1);
});

test('タスクの実行: local_only のタスクが終わったあとの振り返り（記憶に残す振り返り）も、手元の裏方モデルだけで行う。外のモデルには回さない', async t => {
  const s = await startApp(t, twoProviders(['ext1', 'loc2', 'ext2']));
  const task = s.app.tasks.create({ title: '手元だけで', origin: 'user', actor: 'user', localOnly: true });
  s.app.tasks.finish(task.id, 'done', 'タスクの結果', 'clive');
  s.app.reviews.enqueue('task', `task:${task.id}`, { taskId: task.id });
  s.adapter().scripts = [reply('変更なし')];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.adapters.get('ext')!.calls.length, 0, '外のモデルは呼ばれない');
  assert.deepEqual(s.adapter().calls.map(c => c.model.id), ['loc2']);
  assert.match(String(s.adapter().calls[0]!.messages.at(-1)?.content), /タスクの結果/u);

  const normal = s.app.tasks.create({ title: '普通のタスク', origin: 'user', actor: 'user' });
  s.app.tasks.finish(normal.id, 'done', 'ふつうの結果', 'clive');
  s.app.reviews.enqueue('task', `task:${normal.id}`, { taskId: normal.id });
  s.adapters.get('ext')!.scripts = [reply('変更なし')];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.deepEqual(s.adapters.get('ext')!.calls.map(c => c.model.id), ['ext1'], '手元でないタスクは裏方の順番どおり');
});
