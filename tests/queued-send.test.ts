import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import type { ModelRequest } from '../src/providers/types.ts';
import { CONVERSATION, fakeModel, settled, startApp, uuid, waitFor } from './app-setup.ts';
import type { Script } from './helpers.ts';

type Started = Awaited<ReturnType<typeof startApp>>;

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

// ゲートが開くまで待ってから、台本どおりに答える
const after = (g: { promise: Promise<void> }, script: Script): Script => async function* (req) {
  await Promise.race([g.promise, new Promise<never>((_, reject) => { req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }); })]);
  yield* script(req);
};
const say = (text: string): Script => async function* () { yield { type: 'text', delta: text }; yield { type: 'done', stop: 'end_turn' as StopReason }; };
const call = (name: string, args: unknown): Script => async function* () {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call: toolCall };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};
// 呼ばれた要求を覚える台本
function spy(script: Script, seen: ModelRequest[]): Script { return async function* (req) { seen.push(req); yield* script(req); }; }

const roles = (s: Started, id = CONVERSATION) => s.app.conversations.messages(id).map(m => `${m.role}:${m.text.slice(0, 12)}`);
const runsOf = (s: Started, id = CONVERSATION) => (s.app.db.prepare('SELECT id, ok, error_kind FROM engine_runs WHERE conversation_id = ? ORDER BY started_at, rowid').all(id) as Array<{ id: string; ok: number | null; error_kind: string | null }>);
const post = (s: Started, text: string, extra: Record<string, unknown> = {}, id = CONVERSATION) => s.json(`/api/conversations/${id}/messages`, 'POST', { text, ...extra });

async function withFile(s: Started, name = 'a.txt', text = 'こんにちは'): Promise<void> {
  mkdirSync(s.paths.workspace, { recursive: true });
  writeFileSync(join(s.paths.workspace, name), text);
}

test('実行中に送った発言は、次の区切り（道具の結果のあと、次にモデルを呼ぶ前）で履歴に入り、モデルが読める。新しい実行は始まらない', async t => {
  const s = await startApp(t);
  await withFile(s);
  const g = gate();
  const seen: ModelRequest[] = [];
  s.adapter().scripts = [after(g, call('file_read', { path: 'a.txt' })), spy(say('方針を変えました'), seen)];
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  const first = await post(s, 'a.txt を読んで');
  const queued = await post(s, 'やっぱり要約して');
  assert.equal(queued.status, 202);
  assert.equal(queued.body.queued, true);
  assert.equal(queued.body.runId, first.body.runId, '今の実行に差し込む');
  assert.ok(queued.body.pendingId);
  assert.deepEqual(roles(s), ['user:a.txt を読んで'], 'まだ履歴には入っていない');
  const view = (await s.json(`/api/conversations/${CONVERSATION}/messages`, 'GET')).body;
  assert.deepEqual(view.pending.map((p: { id: string; text: string }) => [p.id, p.text]), [[queued.body.pendingId, 'やっぱり要約して']], '待ちとして返る');
  g.open();
  await settled(s.app, first.body.runId);
  assert.deepEqual(roles(s), ['user:a.txt を読んで', 'assistant:', 'tool:[file_read] ', 'user:やっぱり要約して', 'assistant:方針を変えました']);
  const last = seen[0]!.messages;
  assert.deepEqual(last.slice(-2).map(m => m.role), ['tool', 'user'], '道具の結果のあとに差し込む');
  assert.equal((last.at(-1) as { content: string }).content, 'やっぱり要約して');
  assert.equal(runsOf(s).length, 1, '新しい実行は始まらない');
  assert.deepEqual((await s.json(`/api/conversations/${CONVERSATION}/messages`, 'GET')).body.pending, []);
  assert.ok(events.some(e => e.type === 'pending.changed'));
});

test('2 つ続けて送ったら、送った順に入る', async t => {
  const s = await startApp(t);
  await withFile(s);
  const g = gate();
  const seen: ModelRequest[] = [];
  s.adapter().scripts = [after(g, call('file_read', { path: 'a.txt' })), spy(say('はい'), seen)];
  const first = await post(s, '読んで');
  await post(s, 'ひとつめ');
  await post(s, 'ふたつめ');
  g.open();
  await settled(s.app, first.body.runId);
  assert.deepEqual(roles(s), ['user:読んで', 'assistant:', 'tool:[file_read] ', 'user:ひとつめ', 'user:ふたつめ', 'assistant:はい']);
  assert.equal(runsOf(s).length, 1);
});

test('実行が先に終わったら、待っていた発言で新しい実行を始める（実行は同時に 2 つにならず、途切れもしない）', async t => {
  const s = await startApp(t);
  const g = gate();
  const seen: ModelRequest[] = [];
  s.adapter().scripts = [after(g, say('一つ目の返事')), spy(say('二つ目の返事'), seen)];
  const first = await post(s, 'こんにちは');
  const queued = await post(s, 'ついでに聞くけど');
  assert.equal(queued.body.queued, true);
  assert.equal(s.app.engine.activeRuns().length, 1, '2 つ目の実行は始まっていない');
  const retry = await s.json(`/api/conversations/${CONVERSATION}/retry`, 'POST', {});
  assert.equal(retry.status, 409, 'やり直しは、実行中なら今までどおり断る');
  g.open();
  await s.app.engine.wait(first.body.runId);
  const active = s.app.engine.activeRuns().filter(r => r.conversationId === CONVERSATION);
  assert.equal(active.length, 1, '実行が終わった瞬間に、次の実行がもう始まっている（会話の実行は途切れず、重ならない）');
  assert.notEqual(active[0]!.runId, first.body.runId);
  await settled(s.app, active[0]!.runId);
  assert.deepEqual(roles(s), ['user:こんにちは', 'assistant:一つ目の返事', 'user:ついでに聞くけど', 'assistant:二つ目の返事']);
  assert.equal(runsOf(s).length, 2);
  assert.equal((seen[0]!.messages.at(-1) as { content: string }).content, 'ついでに聞くけど');
});

test('待っている発言は、差し込まれる前なら取り消せる。取り消したものは履歴にも新しい実行にも出ない。もう一度取り消すと 404', async t => {
  const s = await startApp(t);
  const g = gate();
  s.adapter().scripts = [after(g, say('おわり'))];
  const first = await post(s, '最初');
  const queued = await post(s, 'やっぱりやめた発言');
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  const cancelled = await s.json(`/api/conversations/${CONVERSATION}/pending/${queued.body.pendingId}`, 'DELETE');
  assert.equal(cancelled.status, 200);
  assert.deepEqual((await s.json(`/api/conversations/${CONVERSATION}/messages`, 'GET')).body.pending, []);
  assert.ok(events.some(e => e.type === 'pending.changed'));
  assert.equal((await s.json(`/api/conversations/${CONVERSATION}/pending/${queued.body.pendingId}`, 'DELETE')).status, 404);
  g.open();
  await settled(s.app, first.body.runId);
  assert.deepEqual(roles(s), ['user:最初', 'assistant:おわり']);
  assert.equal(runsOf(s).length, 1, '新しい実行は始まらない');
});

test('承認の札が出ているあいだは差し込まない（承認の答えが先）。承認のあとの区切りで入る', async t => {
  const s = await startApp(t);
  const seen: ModelRequest[] = [];
  s.adapter().scripts = [call('shell_run', { command: 'git push origin main' }), spy(say('見ました'), seen)];
  const first = await post(s, '書いて');
  await waitFor(() => s.app.approvals.pending().length === 1, '承認の札');
  const queued = await post(s, '承認の最中に送る');
  assert.equal(queued.body.queued, true);
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(roles(s), ['user:書いて', 'assistant:'], '承認を待つあいだは履歴に入らない');
  assert.equal(s.adapter().calls.length, 1, 'モデルも呼ばれていない');
  assert.equal(s.app.engine.pending(CONVERSATION).length, 1);
  const decided = await s.json(`/api/approvals/${s.app.approvals.pending()[0]!.id}`, 'POST', { decision: 'deny' });
  assert.equal(decided.status, 200);
  await settled(s.app, first.body.runId);
  assert.deepEqual(roles(s), ['user:書いて', 'assistant:', 'tool:[shell_run] ', 'user:承認の最中に送る', 'assistant:見ました']);
  assert.deepEqual(seen[0]!.messages.slice(-2).map(m => m.role), ['tool', 'user']);
});

test('止めて送る（interrupt）: 今の実行を止めてから、待っていた発言と一緒に新しい実行を始める', async t => {
  const s = await startApp(t);
  const g = gate();
  const seen: ModelRequest[] = [];
  s.adapter().scripts = [after(g, say('届かない返事')), spy(say('止めたあとの返事'), seen)];
  const first = await post(s, '長い作業');
  await post(s, '先に待たせた発言');
  const stop = await post(s, '止めてこちらを先に', { interrupt: true });
  assert.equal(stop.status, 202);
  assert.equal(stop.body.queued, true);
  await waitFor(() => runsOf(s).length === 2 && runsOf(s)[1]!.ok !== undefined && s.app.runs.get(runsOf(s)[1]!.id)?.ended_at != null, '2 つ目の実行の終わり');
  const [a, b] = runsOf(s);
  assert.deepEqual({ id: a!.id, kind: a!.error_kind }, { id: first.body.runId, kind: 'cancelled' }, '1 つ目は止められた');
  assert.equal(b!.ok, 1);
  assert.deepEqual(roles(s), ['user:長い作業', 'user:先に待たせた発言', 'user:止めてこちらを先に', 'assistant:止めたあとの返事']);
  assert.deepEqual(seen[0]!.messages.slice(-2).map(m => (m as { content: string }).content), ['先に待たせた発言', '止めてこちらを先に']);
  g.open();
});

test('実行が失敗・取り消しで終わったとき、待っていた発言は保存だけして新しい実行は始めない（お知らせを出す）', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  const g = gate();
  s.adapter().scripts = [after(g, async function* () { throw new Error('壊れた'); })];
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  const first = await post(s, '失敗する');
  await post(s, '待っていた発言');
  g.open();
  await settled(s.app, first.body.runId);
  await waitFor(() => roles(s).length === 2, '保存');
  assert.deepEqual(roles(s), ['user:失敗する', 'user:待っていた発言']);
  assert.equal(runsOf(s).length, 1, '失敗のあとに自動で実行しない');
  assert.deepEqual(s.app.engine.pending(CONVERSATION), []);
  assert.ok(events.some(e => e.type === 'warning' && e.code === 'queued_saved'));
});

test('6b のまとめ: 道具の上限で止まる実行でも、待っていた発言はまとめに混ざらず、まとめのあとの新しい実行で読まれる', async t => {
  const s = await startApp(t, { configure: c => { c.tools.maxIterations = 1; } });
  await withFile(s);
  const g = gate();
  const wrap: ModelRequest[] = [];
  const seen: ModelRequest[] = [];
  s.adapter().scripts = [after(g, call('file_read', { path: 'a.txt' })), spy(say('ここまで: 読んだ\n次の一手: 要約'), wrap), spy(say('新しい指示の返事'), seen)];
  const first = await post(s, '読んで');
  await post(s, '新しい指示です');
  g.open();
  await s.app.engine.wait(first.body.runId);
  const second = s.app.engine.activeRuns().find(r => r.conversationId === CONVERSATION)!;
  assert.ok(second && second.runId !== first.body.runId, 'まとめのあとに新しい実行が始まる');
  await settled(s.app, second.runId);
  assert.doesNotMatch((wrap[0]!.messages[0] as { content: string }).content, /新しい指示です/u, 'まとめの記録に待っていた発言は入らない');
  assert.deepEqual(roles(s), ['user:読んで', 'assistant:', 'tool:[file_read] ', 'assistant:ここまで: 読んだ\n次の', 'user:新しい指示です', 'assistant:新しい指示の返事']);
  assert.equal(runsOf(s).length, 2);
  assert.ok(JSON.parse(s.app.runs.get(first.body.runId)!.flags).includes('max_iterations'));
});

test('裏のタスクとの関係 1: 実行中に差し込むだけなら、動いている裏の実行を止めない', async t => {
  // 同時に 2 つ呼べる提供元にする（1 つだけだと、動いている裏の実行が会話の次の呼び出しを待たせる）
  const s = await startApp(t, { configure: c => { c.providers[0]!.maxParallel = 2; } });
  await withFile(s);
  const task = s.app.tasks.create({ title: '裏の作業', origin: 'user', actor: 'user' });
  const taskConversation = s.app.conversations.create({ kind: 'task', title: '裏' });
  const taskGate = gate();
  const g1 = gate();
  // 呼び出しの順: 会話の 1 回目 → 裏の実行 → 会話の 2 回目（道具のあと）
  s.adapter().scripts = [after(g1, call('file_read', { path: 'a.txt' })), after(taskGate, say('裏の返事')), say('差し込みへの返事')];
  const first = await post(s, '読んで');
  const started = s.app.engine.runTask(task, taskConversation.id, 'やって');
  assert.ok(started.ok);
  await post(s, '差し込む発言');
  g1.open();
  await s.app.engine.wait(first.body.runId);
  assert.deepEqual(roles(s), ['user:読んで', 'assistant:', 'tool:[file_read] ', 'user:差し込む発言', 'assistant:差し込みへの返事']);
  assert.equal(s.app.engine.wasPreempted(started.ok ? started.runId : ''), false, '差し込みでは止めない');
  assert.ok(s.app.engine.activeRuns().some(r => r.kind === 'task'), '裏の実行はまだ動いている');
  taskGate.open();
  if (started.ok) assert.equal((await started.done).ok, true);
});

test('裏のタスクとの関係 2: 実行が先に終わって新しい実行を始めるときは、同じ提供元の裏の実行を止める（普通の送信と同じ）', async t => {
  const s = await startApp(t);
  const task = s.app.tasks.create({ title: '裏の作業', origin: 'user', actor: 'user' });
  const taskConversation = s.app.conversations.create({ kind: 'task', title: '裏' });
  const g = gate();
  const taskGate = gate();
  // 呼び出しの順: 会話の 1 回目 → 裏の実行 → 新しい実行（止められた裏の実行は台本を使い切らない）
  s.adapter().scripts = [after(g, say('ふつうの返事')), after(taskGate, say('裏の返事')), say('新しい実行の返事')];
  const chat = await post(s, '普通の質問');
  const started = s.app.engine.runTask(task, taskConversation.id, 'もう一つ');
  assert.ok(started.ok);
  await post(s, '次の質問');
  assert.equal(s.app.engine.wasPreempted(started.ok ? started.runId : ''), false, '待たせているあいだは止めない');
  g.open();
  await s.app.engine.wait(chat.body.runId);
  if (!started.ok) return;
  assert.equal(s.app.engine.wasPreempted(started.runId), true, '新しい実行の始まりで、同じ提供元の裏の実行を止める');
  const result = await started.done;
  assert.equal(result.ok, false);
  const next = s.app.engine.activeRuns().find(r => r.conversationId === CONVERSATION)!;
  await settled(s.app, next.runId);
  assert.deepEqual(roles(s), ['user:普通の質問', 'assistant:ふつうの返事', 'user:次の質問', 'assistant:新しい実行の返事']);
});

test('裏のタスク・振り返りの会話は、実行中に送っても待たせない（エンジンは今までどおり 409 で断る）', async t => {
  const s = await startApp(t);
  const task = s.app.tasks.create({ title: '裏の作業', origin: 'user', actor: 'user' });
  const taskConversation = s.app.conversations.create({ kind: 'task', title: '裏' });
  const taskGate = gate();
  s.adapter().scripts = [after(taskGate, say('裏の返事'))];
  const started = s.app.engine.runTask(task, taskConversation.id, 'やって');
  assert.ok(started.ok);
  const refused = s.app.engine.send(taskConversation.id, '横から');
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.errorCode, 'engine.send.busy_chat');
  assert.deepEqual(s.app.engine.pending(taskConversation.id), []);
  taskGate.open();
  if (started.ok) await started.done;
});

test('並べ替え: 同時に何件送っても会話の実行は 1 つ。待ちの上限（10 件）を超えたら 409', async t => {
  const s = await startApp(t);
  const g = gate();
  s.adapter().scripts = [after(g, say('おわり')), say('次')];
  const first = await post(s, '最初');
  const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => post(s, `待ち ${i}`)));
  assert.ok(answers.every(a => a.status === 202 && a.body.queued === true));
  assert.equal(s.app.engine.activeRuns().length, 1);
  const over = await post(s, '11 件目');
  assert.equal(over.status, 409);
  assert.equal(over.body.errorCode, 'engine.send.queue_full');
  g.open();
  await settled(s.app, first.body.runId);
  await waitFor(() => runsOf(s).length === 2 && s.app.runs.get(runsOf(s)[1]!.id)?.ended_at != null, '新しい実行の終わり');
  assert.equal(roles(s).filter(r => r.startsWith('user:待ち')).length, 10, '10 件とも履歴に入る');
});

test('添付つきの発言を差し込んだら、その実行の残りは「外から読んだ」扱いになる（シェルの実行は確かめが出る）', async t => {
  const s = await startApp(t);
  await withFile(s);
  const g = gate();
  s.adapter().scripts = [after(g, call('file_read', { path: 'a.txt' })), call('shell_run', { command: 'node --version' }), say('おわり')];
  const upload = s.app.uploads.save({ name: 'memo.txt', mime: 'text/plain', body: Buffer.from('外から来た文章') });
  const first = await post(s, '読んで');
  const queued = await post(s, '添付を見て', { attachments: [upload.id] });
  assert.equal(queued.body.queued, true);
  g.open();
  await waitFor(() => s.app.approvals.pending().length === 1, '外から読んだあとの確かめ');
  assert.match(s.app.approvals.pending()[0]!.reasons.join(' '), /memo\.txt/u, '理由に添付の名前が出る');
  s.app.approvals.decide(s.app.approvals.pending()[0]!.id, 'deny');
  await settled(s.app, first.body.runId);
});

test('入力の検査: interrupt は true / false だけ。待ちの取り消しは、無い会話・無い待ちで 404', async t => {
  const s = await startApp(t);
  const bad = await post(s, 'こんにちは', { interrupt: 'yes' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'http.bad_bool');
  assert.equal((await s.json(`/api/conversations/${uuid(5)}/pending/x`, 'DELETE')).status, 404);
  s.app.conversations.create({ id: CONVERSATION, title: '空' });
  assert.equal((await s.json(`/api/conversations/${CONVERSATION}/pending/none`, 'DELETE')).body.code, 'http.pending_gone');
});
