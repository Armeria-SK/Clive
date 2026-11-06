import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { readHistory, searchHistory } from '../src/memory/history.ts';
import { fakeModel, settled, startApp, uuid, waitFor } from './app-setup.ts';
import { reply, type Script, testConfig } from './helpers.ts';

// 手元のモデルを選んだ会話の振り返りは、会話の中身（発言の全文）を渡す「振り返りの会話」を作る。
// その会話は model_id が無く、タスクにも結び付かないので、外のモデルの履歴の検索・読み出しに出てしまっていた。
// 振り返りのきっかけの会話（memory_jobs.conversation_id）が、手元のモデルを選んだ会話・手元のモデルだけで動かすタスクの会話なら、その振り返りの会話も外のモデルには見せない（visibleModelIds と同じ決まり）

type Started = Awaited<ReturnType<typeof startApp>>;

const WORD = 'zzyzxsecret';
const call = (name: string, args: unknown): Script => async function* () {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call: toolCall };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

function setup(background: string[]) {
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

// 実際に振り返りを走らせて、振り返りの会話を作らせる
async function reviewed(s: Started, source: string): Promise<string> {
  s.app.reviews.enqueue('manual', `manual:${source}`, { conversationId: source });
  assert.equal(await s.app.worker.tick(), 'ran');
  const job = s.app.reviews.list().find(j => j.conversation_id === source)!;
  assert.ok(job.review_conversation_id, '前提: 振り返りの会話が作られ、振り返りの記録から辿れる');
  return job.review_conversation_id;
}

const toolResult = (s: Started, conversationId: string) => (s.app.conversations.messages(conversationId).find(m => m.role === 'tool')?.text ?? '');
async function asRun(s: Started, conversationId: string, modelId: string | null, script: Script, adapterId: 'fake' | 'ext'): Promise<string> {
  s.app.conversations.create({ id: conversationId, title: '検索する会話' });
  if (modelId) s.app.conversations.setChoice(conversationId, { modelId });
  s.adapters.get(adapterId)!.scripts = [script, reply('おわり')];
  const sent = await s.json(`/api/conversations/${conversationId}/messages`, 'POST', { text: '前の話を探して' });
  assert.equal(sent.status, 202);
  await settled(s.app, sent.body.runId);
  return toolResult(s, conversationId);
}

test('手元の会話の振り返りの会話は、外のモデルの実行の履歴の検索・読み出しに出さない。手元の実行からは見える', async t => {
  const s = await startApp(t, setup(['loc2']));
  const source = uuid(1);
  chatWith(s, source, 'loc', `手元でだけ話した ${WORD} の内容`);
  s.adapter().scripts = [reply('変更なし')];
  const review = await reviewed(s, source);
  // 前提: 振り返りの会話の発言に、手元の会話の全文が入っている
  assert.match(s.app.conversations.messages(review).map(m => m.text).join('\n'), new RegExp(WORD, 'u'));
  assert.equal(s.app.conversations.get(review)!.kind, 'task');
  assert.equal(s.app.conversations.get(review)!.model_id, null);
  // 対照: 自動の会話は、外のモデルの実行から今までどおり出る
  chatWith(s, uuid(2), null, `自動の会話 ${WORD}`);
  const external = await asRun(s, uuid(20), 'ext1', call('history_search', { query: WORD }), 'ext');
  assert.match(external, /自動の会話/u, '前提: 検索は動いている');
  assert.doesNotMatch(external, /手元でだけ話した/u);
  assert.equal(external.includes(review), false, '振り返りの会話の ID が出ない');
  const read = await asRun(s, uuid(21), 'ext1', call('history_read', { conversation_id: review }), 'ext');
  assert.equal(read, await asRun(s, uuid(22), 'ext1', call('history_read', { conversation_id: uuid(99) }), 'ext'), '存在しない会話と同じ答え');
  assert.doesNotMatch(read, new RegExp(WORD, 'u'));
  // 手元のモデルだけの実行からは、見える
  const local = await asRun(s, uuid(23), 'loc', call('history_search', { query: WORD }), 'fake');
  assert.ok(local.includes(review) || /手元でだけ話した/u.test(local), '手元の実行は、手元の会話の振り返りも探せる');
  const localRead = await asRun(s, uuid(24), 'loc', call('history_read', { conversation_id: review }), 'fake');
  assert.match(localRead, new RegExp(WORD, 'u'));
});

test('外のモデルを選んだ会話・自動の会話の振り返りの会話は、今までどおり外のモデルの実行からも検索できる', async t => {
  const s = await startApp(t, setup(['ext1']));
  const pinned = uuid(1);
  const auto = uuid(2);
  chatWith(s, pinned, 'ext1', `外のモデルの会話 ${WORD}`);
  chatWith(s, auto, null, `自動の会話 ${WORD}`);
  s.adapters.get('ext')!.scripts = [reply('変更なし'), reply('変更なし')];
  const reviews = [await reviewed(s, pinned), await reviewed(s, auto)];
  for (const review of reviews) {
    assert.ok(searchHistory(s.app.db, WORD, { limit: 50, visibleModelIds: ['ext1', 'ext2'] }).some(h => h.conversationId === review), `${review} が出る`);
    assert.ok(readHistory(s.app.db, review, { visibleModelIds: ['ext1', 'ext2'] }).length > 0);
  }
});

test('DB の決まり: 振り返りのきっかけの会話・タスクが手元の約束の対象なら隠す（選んだモデルが設定から消えた会話・手元のタスクの会話・手元のタスクの振り返り）', async t => {
  const s = await startApp(t, setup([]));
  const visible = ['ext1', 'ext2'];
  const mkReview = (title: string, trigger: 'manual' | 'task', refs: { conversationId?: string; taskId?: string }, key: string) => {
    const conversation = s.app.conversations.create({ kind: 'task', title, source: refs });
    s.app.conversations.append(conversation.id, { role: 'user', content: `${title} ${WORD}` });
    const job = s.app.reviews.enqueue(trigger, key, refs)!;
    s.app.reviews.claim(job.id, `run-${key}`, conversation.id);
    return conversation.id;
  };
  // 1) 選んだモデルが設定に無い会話の振り返り
  chatWith(s, uuid(1), 'removed-model', 'x');
  const removed = mkReview('消えたモデル', 'manual', { conversationId: uuid(1) }, 'k1');
  // 2) 手元のモデルだけで動かすタスクの会話の振り返り（タスクの会話がきっかけの会話）
  const localTask = s.app.tasks.create({ title: '手元のタスク', origin: 'user', actor: 'user', localOnly: true });
  const taskConversation = s.app.conversations.create({ kind: 'task', title: 'タスクの会話' });
  s.app.db.prepare('UPDATE tasks SET conversation_id = ? WHERE id = ?').run(taskConversation.id, localTask.id);
  const taskReview = mkReview('手元のタスクの振り返り', 'task', { taskId: localTask.id, conversationId: taskConversation.id }, 'k2');
  // 3) きっかけの会話が無く、手元のタスクだけを指す振り返り
  const taskOnly = mkReview('手元のタスクだけを指す振り返り', 'task', { taskId: localTask.id }, 'k3');
  // 対照: 外のモデルの会話・自動の会話・ふつうのタスクの振り返り・きっかけが分からない振り返り
  chatWith(s, uuid(2), 'ext1', 'x');
  const ext = mkReview('外の会話の振り返り', 'manual', { conversationId: uuid(2) }, 'k4');
  chatWith(s, uuid(3), null, 'x');
  const auto = mkReview('自動の会話の振り返り', 'manual', { conversationId: uuid(3) }, 'k5');
  const plainTask = s.app.tasks.create({ title: 'ふつうのタスク', origin: 'user', actor: 'user' });
  const plain = mkReview('ふつうのタスクの振り返り', 'task', { taskId: plainTask.id }, 'k6');
  const unknown = s.app.conversations.create({ kind: 'task', title: 'きっかけが分からない' }).id;
  s.app.conversations.append(unknown, { role: 'user', content: `きっかけが分からない ${WORD}` });

  const hits = searchHistory(s.app.db, WORD, { limit: 50, visibleModelIds: visible }).map(h => h.conversationId);
  for (const hidden of [removed, taskReview, taskOnly]) {
    assert.equal(hits.includes(hidden), false, `${hidden} は外の実行に出さない`);
    assert.deepEqual(readHistory(s.app.db, hidden, { visibleModelIds: visible }), [], `${hidden} は読めない`);
  }
  for (const shown of [ext, auto, plain, unknown]) {
    assert.equal(hits.includes(shown), true, `${shown} は出る`);
    assert.ok(readHistory(s.app.db, shown, { visibleModelIds: visible }).length > 0, `${shown} は読める`);
  }
  // 全部が手元の実行（visibleModelIds なし）と、画面の検索は、すべて出る
  const all = searchHistory(s.app.db, WORD, { limit: 50 }).map(h => h.conversationId);
  for (const id of [removed, taskReview, taskOnly, ext, auto, plain, unknown]) assert.equal(all.includes(id), true, `${id} は手元の実行・画面には出る`);
  // 外のモデルが 1 つも無い設定でも同じ決まり（visibleModelIds が空）
  const none = searchHistory(s.app.db, WORD, { limit: 50, visibleModelIds: [] }).map(h => h.conversationId);
  assert.equal(none.includes(removed), false);
  assert.equal(none.includes(auto), true);
});

test('振り返りのきっかけの会話そのものも、今までどおり外の実行には出ない（選んだモデルが手元）', async t => {
  const s = await startApp(t, setup([]));
  chatWith(s, uuid(1), 'loc', `手元の会話 ${WORD}`);
  assert.deepEqual(searchHistory(s.app.db, WORD, { limit: 50, visibleModelIds: ['ext1', 'ext2'] }), []);
});

// ── 止められてやり直された振り返りと、振り返りの会話が材料の会話を自分で覚える決まり ──

function hang(): Script {
  return async function* (req) {
    yield { type: 'text', delta: '考えています…' };
    await new Promise((_, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    });
  };
}

test('止められてやり直された振り返りは、前の回の振り返りの会話に続きを書く。前の回の会話が記録から外れて、外のモデルの実行に見えることがない', async t => {
  const s = await startApp(t, setup(['loc2']));
  const source = uuid(1);
  chatWith(s, source, 'loc', `手元でだけ話した ${WORD} の内容`);
  s.app.reviews.enqueue('manual', `manual:${source}`, { conversationId: source });
  s.adapter().scripts = [hang()];
  const ticking = s.app.worker.tick();
  await waitFor(() => s.app.reviews.list().some(j => j.status === 'running'), '振り返りが動き出す');
  const first = s.app.reviews.list()[0]!.review_conversation_id!;
  // 会話が、同じ提供元を使う裏の実行（この振り返り）を止める
  s.app.conversations.create({ id: uuid(2), title: '割り込む会話' });
  s.adapter().scripts.push(reply('はい'));
  const sent = await s.json(`/api/conversations/${uuid(2)}/messages`, 'POST', { text: 'こんにちは' });
  assert.equal(sent.status, 202);
  assert.equal(await ticking, 'ran');
  await settled(s.app, sent.body.runId);
  assert.equal(s.app.reviews.list()[0]!.status, 'pending', '前提: 止められて、やり直しの待ちに戻った');
  // やり直し
  s.adapter().scripts = [reply('変更なし')];
  assert.equal(await s.app.worker.tick(), 'ran');
  const job = s.app.reviews.list()[0]!;
  assert.equal(job.status, 'done');
  assert.equal(job.review_conversation_id, first, '前の回の会話に続きを書く');
  assert.deepEqual(s.app.db.prepare("SELECT id FROM conversations WHERE kind = 'task'").all().map(r => r.id), [first], '振り返りの会話は 1 つだけ（記録から外れた会話ができない）');
  assert.equal(s.app.conversations.messages(first).filter(m => m.role === 'user').length, 2, '同じ会話に、やり直しの指示が続く');
  assert.match(s.app.conversations.messages(first).map(m => m.text).join('\n'), new RegExp(WORD, 'u'), '前提: この会話に、手元の会話の全文が入っている');
  const external = await asRun(s, uuid(30), 'ext1', call('history_search', { query: WORD }), 'ext');
  assert.doesNotMatch(external, /手元でだけ話した/u);
  assert.equal(external.includes(first), false);
  const read = await asRun(s, uuid(31), 'ext1', call('history_read', { conversation_id: first }), 'ext');
  assert.equal(read, await asRun(s, uuid(32), 'ext1', call('history_read', { conversation_id: uuid(99) }), 'ext'), '存在しない会話と同じ答え');
});

test('再起動で「動いていた」から「待ち」に戻った振り返りも、前の回の振り返りの会話に続きを書く', async t => {
  const s = await startApp(t, setup(['loc2']));
  const source = uuid(1);
  chatWith(s, source, 'loc', `手元でだけ話した ${WORD} の内容`);
  s.adapter().scripts = [reply('変更なし')];
  const first = await reviewed(s, source);
  const job = s.app.reviews.list()[0]!;
  s.app.db.prepare("UPDATE memory_jobs SET status = 'running' WHERE id = ?").run(job.id);
  s.app.db.prepare('DELETE FROM kv WHERE key = ?').run(`review:upto:${source}`);
  assert.equal(s.app.reviews.recoverRunning(), 1);
  s.adapter().scripts = [reply('変更なし')];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.reviews.get(job.id)!.review_conversation_id, first);
  assert.equal((s.app.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'task'").get() as { n: number }).n, 1);
});

test('振り返りの会話は、材料にした会話・タスクを自分で覚えていて、振り返りの記録の結び付きが無くても、外のモデルの実行には出ない', async t => {
  const s = await startApp(t, setup([]));
  chatWith(s, uuid(1), 'loc', `手元の会話 ${WORD}`);
  chatWith(s, uuid(2), 'ext1', `外の会話 ${WORD}`);
  const localTask = s.app.tasks.create({ title: '手元のタスク', origin: 'user', actor: 'user', localOnly: true });
  const make = (title: string, source: { conversationId?: string; taskId?: string } | undefined) => {
    const conversation = s.app.conversations.create({ kind: 'task', title, ...(source ? { source } : {}) });
    s.app.conversations.append(conversation.id, { role: 'user', content: `${title} ${WORD}` });
    return conversation.id;
  };
  const hiddenLocal = make('手元の会話の振り返り', { conversationId: uuid(1) });
  const hiddenTask = make('手元のタスクの振り返り', { taskId: localTask.id });
  const shownExternal = make('外の会話の振り返り', { conversationId: uuid(2) });
  const shownUnknown = make('材料が分からない振り返り', undefined);
  assert.equal((s.app.db.prepare('SELECT COUNT(*) AS n FROM memory_jobs').get() as { n: number }).n, 0, '前提: 振り返りの記録には何も結び付いていない');
  const visible = ['ext1', 'ext2'];
  const hits = searchHistory(s.app.db, WORD, { limit: 50, visibleModelIds: visible }).map(h => h.conversationId);
  for (const id of [hiddenLocal, hiddenTask]) {
    assert.equal(hits.includes(id), false, `${id} は外の実行に出さない`);
    assert.deepEqual(readHistory(s.app.db, id, { visibleModelIds: visible }), []);
  }
  for (const id of [shownExternal, shownUnknown]) {
    assert.equal(hits.includes(id), true, `${id} は出る`);
    assert.ok(readHistory(s.app.db, id, { visibleModelIds: visible }).length > 0);
  }
  assert.equal(searchHistory(s.app.db, WORD, { limit: 50 }).some(h => h.conversationId === hiddenLocal), true, '画面の検索には出る');
});

test('会話を消すと、その会話を材料にした振り返りの会話は、振り返りの記録から辿れなくなっていても一緒に消える', async t => {
  const s = await startApp(t, setup([]));
  const source = uuid(1);
  chatWith(s, source, null, `消す会話 ${WORD}`);
  const orphan = s.app.conversations.create({ kind: 'task', title: '辿れない振り返り', source: { conversationId: source } });
  s.app.conversations.append(orphan.id, { role: 'user', content: `全文 ${WORD}` });
  const other = s.app.conversations.create({ kind: 'task', title: 'ほかの会話の振り返り', source: { conversationId: uuid(5) } });
  const res = await s.json(`/api/conversations/${source}`, 'DELETE');
  assert.equal(res.status, 200);
  assert.equal(s.app.conversations.get(orphan.id), undefined);
  assert.deepEqual(s.app.conversations.messages(orphan.id), []);
  assert.ok(s.app.conversations.get(other.id), 'ほかの会話の振り返りは消さない');
});
