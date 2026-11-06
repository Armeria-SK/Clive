import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import type { ModelRequest } from '../src/providers/types.ts';
import { CONVERSATION, fakeModel, settled, startApp, uuid, waitFor } from './app-setup.ts';
import { FakeAdapter, tempDir, testConfig, type Script } from './helpers.ts';

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

test('承認を待っているあいだは、実行が道具の呼び出しの中にいるので、発言は履歴に入らず、モデルも呼ばれない（承認の答えが先）。承認のあとの区切りで入る', async t => {
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

// 最終審査の低: 「この返事のあいだ、このフォルダ以下への書き込みを許可」は、持ち主がその札に答えた返事の間だけのもの。実行の途中で待たせた発言が差し込まれると、
// それは別の発言（別の返事）なので、許可はすべて終わる。残すと、持ち主が見ていない発言の後ろでも、同じフォルダへの書き込みが札なしで通ってしまう
test('フォルダの許可（この返事のあいだ）は、待たせた発言が差し込まれた時点で終わり、そのあとの同じフォルダへの書き込みはまた札から', async t => {
  const s = await startApp(t);
  const upload = s.app.uploads.save({ name: 'memo.txt', mime: 'text/plain', body: Buffer.from('添付の文') });
  const written = (name: string) => existsSync(join(s.paths.workspace, 'notes', name));
  s.adapter().scripts = [call('file_write', { path: 'notes/a.txt', content: 'A' }), call('file_write', { path: 'notes/b.txt', content: 'B' }), say('おわり')];
  const first = await post(s, '添付を読んで書いて', { attachments: [upload.id] });
  await waitFor(() => s.app.approvals.pending().length === 1, '最初の札');
  const firstCard = s.app.approvals.pending()[0]!;
  assert.ok((await s.json('/api/approvals', 'GET')).body.approvals[0].grantFolder.endsWith('notes'), '札にフォルダの許可が添えられる');
  const queued = await post(s, '待たせる発言');
  assert.equal(queued.body.queued, true);
  s.app.approvals.decide(firstCard.id, 'folder');
  await waitFor(() => s.app.approvals.pending().length === 1 && s.app.approvals.pending()[0]!.id !== firstCard.id, '2 つ目の札（許可は差し込みで終わっている）');
  assert.equal(written('a.txt'), true, '許可した札の書き込みは通った');
  assert.equal(written('b.txt'), false, '2 つ目はまだ書かれていない');
  assert.deepEqual(roles(s).slice(-3), ['tool:[file_write]', 'user:待たせる発言', 'assistant:'], '待たせた発言は、1 つ目の書き込みのあとの区切りで入った');
  s.app.approvals.decide(s.app.approvals.pending()[0]!.id, 'deny');
  await settled(s.app, first.body.runId);
  assert.equal(written('b.txt'), false);
  assert.equal(runsOf(s).length, 1, '同じ実行の中');
});

test('フォルダの許可は、待たせた発言が無ければ、その返事の残りの間つづく（差し込みで終わるのは、発言があったときだけ）', async t => {
  const s = await startApp(t);
  const upload = s.app.uploads.save({ name: 'memo.txt', mime: 'text/plain', body: Buffer.from('添付の文') });
  s.adapter().scripts = [call('file_write', { path: 'notes/a.txt', content: 'A' }), call('file_write', { path: 'notes/b.txt', content: 'B' }), say('おわり')];
  const first = await post(s, '添付を読んで書いて', { attachments: [upload.id] });
  await waitFor(() => s.app.approvals.pending().length === 1, '最初の札');
  s.app.approvals.decide(s.app.approvals.pending()[0]!.id, 'folder');
  await settled(s.app, first.body.runId);
  assert.equal(existsSync(join(s.paths.workspace, 'notes', 'b.txt')), true, '発言が無ければ、2 つ目は札なしで書かれた');
  assert.equal(s.app.approvals.pending().length, 0);
});

test('フォルダの許可は、差し込まれない発言（モデルを替えたあとに待たせた held）では終わらない。差し込まれたときだけ終わる', async t => {
  const s = await startApp(t);
  const upload = s.app.uploads.save({ name: 'memo.txt', mime: 'text/plain', body: Buffer.from('添付の文') });
  s.adapter().scripts = [call('file_write', { path: 'notes/a.txt', content: 'A' }), call('file_write', { path: 'notes/b.txt', content: 'B' }), say('m1 の返事'), say('m2 の返事')];
  const first = await post(s, '添付を読んで書いて', { attachments: [upload.id], modelId: 'm1' });
  await waitFor(() => s.app.approvals.pending().length === 1, '最初の札');
  assert.equal((await s.json(`/api/conversations/${CONVERSATION}`, 'PATCH', { modelId: 'm2' })).status, 200);
  assert.equal((await post(s, 'HELD')).body.queued, true);
  s.app.approvals.decide(s.app.approvals.pending()[0]!.id, 'folder');
  await waitFor(() => existsSync(join(s.paths.workspace, 'notes', 'b.txt')) || s.app.approvals.pending().length > 0, '2 つ目の書き込み');
  assert.equal(existsSync(join(s.paths.workspace, 'notes', 'b.txt')), true, '差し込まれない発言では許可は終わらず、2 つ目は札なしで書かれた');
  assert.equal(s.app.approvals.pending().length, 0);
  await s.app.engine.wait(first.body.runId);
  const second = s.app.engine.activeRuns().find(r => r.conversationId === CONVERSATION);
  if (second) await settled(s.app, second.runId);
  assert.equal(s.adapter().calls.map(c => c.model.id).join(), 'm1,m1,m1,m2', '古いモデルの実行が終わってから、新しいモデルが held を読む');
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

const sawText = (req: ModelRequest, text: string) => JSON.stringify(req.messages).includes(text);

test('実行中に会話のモデルを替えたら、そのあとに送った発言は今の実行（古いモデル）へ差し込まず、実行が終わってから新しいモデルの実行で読ませる。替える前に送った発言は今までどおり差し込む', async t => {
  const s = await startApp(t);
  await withFile(s);
  const g = gate();
  s.adapter().scripts = [after(g, call('file_read', { path: 'a.txt' })), say('m1 の返事'), say('m2 の返事')];
  const first = await post(s, 'a.txt を読んで', { modelId: 'm1' });
  assert.equal((await post(s, 'EARLIER')).body.queued, true);
  assert.equal((await s.json(`/api/conversations/${CONVERSATION}`, 'PATCH', { modelId: 'm2' })).status, 200);
  const secret = await post(s, 'SECRET');
  assert.equal(secret.body.queued, true);
  assert.equal(secret.body.runId, first.body.runId);
  g.open();
  await s.app.engine.wait(first.body.runId);
  const second = s.app.engine.activeRuns().find(r => r.conversationId === CONVERSATION);
  assert.ok(second && second.runId !== first.body.runId, '古い実行が終わったとき、新しい実行が始まっている');
  await settled(s.app, second.runId);
  const calls = s.adapter().calls;
  assert.deepEqual(calls.map(c => c.model.id), ['m1', 'm1', 'm2']);
  assert.ok(calls.filter(c => c.model.id === 'm1').every(c => !sawText(c, 'SECRET')), '古いモデルへの呼び出しに、替えたあとの発言が混ざらない');
  assert.ok(sawText(calls[1]!, 'EARLIER'), '替える前に待たせた発言は、今の実行に差し込む');
  assert.ok(sawText(calls[2]!, 'SECRET'), '新しいモデルの実行が、待たせていた発言を読む');
  assert.deepEqual(roles(s), ['user:a.txt を読んで', 'assistant:', 'tool:[file_read] ', 'user:EARLIER', 'assistant:m1 の返事', 'user:SECRET', 'assistant:m2 の返事']);
  assert.deepEqual(runsOf(s).length, 2);
  assert.equal(s.app.runs.get(second.runId)!.model_id, 'm2');
});

test('モデルを替えたあとの発言は、今の実行が失敗しても、新しいモデルの実行で読ませる（保存だけにしない）。送信の modelId で替えたときも同じ', async t => {
  const s = await startApp(t);
  const g = gate();
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  s.adapter().scripts = [after(g, async function* () { throw new Error('壊れた'); }), say('m2 の返事')];
  const first = await post(s, '最初', { modelId: 'm1' });
  const queued = await post(s, 'SECRET', { modelId: 'm2' });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.queued, true);
  g.open();
  await settled(s.app, first.body.runId);
  await waitFor(() => runsOf(s).length === 2 && s.app.runs.get(runsOf(s)[1]!.id)?.ended_at != null, '新しい実行の終わり');
  assert.equal(runsOf(s)[0]!.ok, 0, '1 つ目は失敗した');
  assert.deepEqual(s.adapter().calls.map(c => c.model.id), ['m1', 'm2']);
  assert.ok(!sawText(s.adapter().calls[0]!, 'SECRET'));
  assert.ok(sawText(s.adapter().calls[1]!, 'SECRET'));
  assert.deepEqual(roles(s), ['user:最初', 'user:SECRET', 'assistant:m2 の返事']);
  assert.ok(!events.some(e => e.type === 'warning' && e.code === 'queued_saved'), '保存だけにはしない');
});

// 添付つきの待っていた発言を、実行を止めて保存だけにしたあと、その履歴の上で始まる実行（もう一度・次の発言）も「外から読んだ」扱いになる
for (const how of ['retry', 'send'] as const) {
  test(`添付つきの待っていた発言が保存だけになったあとの実行（${how === 'retry' ? '「もう一度」' : '次の発言'}）も「外から読んだ」扱いになる（書き込みは確かめが出る）`, async t => {
    const s = await startApp(t);
    const g = gate();
    s.adapter().scripts = [after(g, say('届かない返事')), call('file_write', { path: 'out.txt', content: 'x' }), say('おわり')];
    const upload = s.app.uploads.save({ name: 'memo.txt', mime: 'text/plain', body: Buffer.from('外から来た文章') });
    const first = await post(s, '最初');
    const queued = await post(s, '添付を見て', { attachments: [upload.id] });
    assert.equal(queued.body.queued, true);
    assert.equal((await s.json(`/api/runs/${first.body.runId}/stop`, 'POST', {})).status, 200);
    await settled(s.app, first.body.runId);
    await waitFor(() => roles(s).length === 2, '保存');
    assert.equal(runsOf(s).length, 1, '止めたあとに自動で実行しない');
    assert.deepEqual(s.app.approvals.pending(), []);
    const next = how === 'retry' ? await s.json(`/api/conversations/${CONVERSATION}/retry`, 'POST', {}) : await post(s, 'これを書いて');
    assert.equal(next.status, 202);
    await waitFor(() => s.app.approvals.pending().length === 1, '外から読んだあとの書き込みの確かめ');
    assert.match(s.app.approvals.pending()[0]!.reasons.join(' '), /memo\.txt/u, '理由に添付の名前が出る');
    s.app.approvals.decide(s.app.approvals.pending()[0]!.id, 'deny');
    await settled(s.app, next.body.runId);
  });
}

test('添付の無い履歴の上で始まる実行（もう一度）は、今までどおり確かめなしで書ける。答えが付いたあとの古い添付も数えない', async t => {
  const s = await startApp(t);
  const upload = s.app.uploads.save({ name: 'old.txt', mime: 'text/plain', body: Buffer.from('古い添付') });
  s.adapter().scripts = [say('添付への返事'), call('file_write', { path: 'out.txt', content: 'x' }), say('書きました')];
  const first = await post(s, '添付を見て', { attachments: [upload.id] });
  await settled(s.app, first.body.runId);
  s.app.conversations.append(CONVERSATION, { role: 'user', content: '次はこれ' });
  const retry = await s.json(`/api/conversations/${CONVERSATION}/retry`, 'POST', {});
  assert.equal(retry.status, 202);
  await settled(s.app, retry.body.runId);
  assert.deepEqual(s.app.approvals.pending(), [], '返事が付いたあとの添付は、次の実行の確かめには持ち越さない');
  assert.equal(roles(s).at(-1), 'assistant:書きました');
});

test('終了するとき、待たせている発言は保存だけして残す（メモリの中だけの待ちが、再起動で消えない）。新しい実行は始めない', async t => {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FAKE_KEY', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [fakeModel('m1')];
  config.routing = { chat: ['m1'], background: [], retriesPerModel: 0 };
  writeFileSync(paths.config, JSON.stringify(config));
  const databasePath = join(dir, 'clive.db');
  const adapters: FakeAdapter[] = [];
  const open = () => new App({ paths, databasePath, log: () => undefined, workerTimers: false, adapterOverride: provider => { const made = new FakeAdapter(provider); adapters.push(made); return made; } });

  const first = open();
  const g = gate();
  adapters[0]!.scripts = [after(g, say('届かない返事'))];
  await first.status.probeAll(first.config());
  const sent = first.engine.send(CONVERSATION, '最初の発言');
  assert.ok(sent.ok);
  const done = first.engine.wait(sent.runId);
  done?.catch(() => undefined);
  assert.equal(first.engine.send(CONVERSATION, '待たせた発言 1').ok, true);
  assert.equal(first.engine.send(CONVERSATION, '待たせた発言 2').ok, true);
  assert.equal(first.engine.pending(CONVERSATION).length, 2);
  first.close();
  await new Promise(resolve => setTimeout(resolve, 50));

  // 一時フォルダを消す前に DB を閉じる（Windows では開いたままだと消せない）
  const second = open();
  try {
    assert.deepEqual(second.conversations.messages(CONVERSATION).map(m => `${m.role}:${m.text}`), ['user:最初の発言', 'user:待たせた発言 1', 'user:待たせた発言 2'], '待たせていた発言が、送った順に残っている');
    assert.equal(second.runs.recent(10).length, 1, '終了のときに新しい実行は始めない');
  } finally { second.close(); }
});

// 止められたあとも、gate が開くまで終わらない台本（止めたあと、実行がまだ残っている状態を作る）
const slowToStop = (g: { promise: Promise<void> }): Script => async function* (req) {
  await new Promise<void>(resolve => req.signal.addEventListener('abort', () => resolve(), { once: true }));
  await g.promise;
  throw req.signal.reason;
};

test('止めたあとに送った発言は、止めた実行が終わるのを待って新しい実行を始める（止める前に待たせた発言は保存だけ）', async t => {
  const s = await startApp(t);
  const g = gate();
  const seen: ModelRequest[] = [];
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  s.adapter().scripts = [slowToStop(g), spy(say('止めたあとの返事'), seen)];
  const first = await post(s, '長い作業');
  assert.equal((await post(s, '止める前に待たせた発言')).body.queued, true);
  assert.equal((await s.json(`/api/runs/${first.body.runId}/stop`, 'POST', {})).body.stopped, true);
  assert.equal(s.app.engine.activeRuns().length, 1, '止めたあとも、実行はまだ終わっていない');
  const afterStop = await post(s, '止めたあとに送る発言');
  assert.equal(afterStop.status, 202);
  assert.equal(afterStop.body.queued, true, '実行が残っているあいだは待たせる');
  g.open();
  await s.app.engine.wait(first.body.runId);
  const next = s.app.engine.activeRuns().find(r => r.conversationId === CONVERSATION);
  assert.ok(next && next.runId !== first.body.runId, '止めた実行が終わった瞬間に、止めたあとに送った発言で新しい実行が始まる');
  await settled(s.app, next.runId);
  assert.deepEqual(roles(s), ['user:長い作業', 'user:止める前に待たせた発言', 'user:止めたあとに送る発言', 'assistant:止めたあとの返事']);
  assert.equal(runsOf(s)[0]!.error_kind, 'cancelled');
  assert.equal(runsOf(s).length, 2);
  assert.equal((seen[0]!.messages.at(-1) as { content: string }).content, '止めたあとに送る発言');
  const saved = events.filter(e => e.type === 'warning' && e.code === 'queued_saved');
  assert.equal(saved.length, 1, '止める前に待たせた発言だけが「保存だけ」のお知らせになる');
  assert.deepEqual((saved[0] as { params?: unknown }).params, { count: 1 });
});

test('止めたあとに何も送らなければ、止める前に待たせた発言は保存だけ（新しい実行は始めない）', async t => {
  const s = await startApp(t);
  const g = gate();
  s.adapter().scripts = [after(g, say('届かない返事')), say('始まらないはずの返事')];
  const first = await post(s, '長い作業');
  await post(s, '止める前に待たせた発言');
  assert.equal((await s.json(`/api/runs/${first.body.runId}/stop`, 'POST', {})).body.stopped, true);
  await settled(s.app, first.body.runId);
  await waitFor(() => roles(s).length === 2, '保存');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(roles(s), ['user:長い作業', 'user:止める前に待たせた発言']);
  assert.equal(runsOf(s).length, 1);
  assert.equal(s.app.engine.activeRuns().length, 0);
});

test('保存だけにした理由でお知らせが分かれる: 使えるモデルが無くて返事を始められなかったとき（queued_not_started）は、返事が止まったとき（queued_saved）と別の文', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  const g = gate();
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  // 返事は成功で終わるが、その直前にモデルが使えなくなる（引き取りで新しい実行を始められない）
  s.adapter().scripts = [after(g, async function* () { s.app.status.disable('m1', '落ちました'); yield { type: 'text', delta: 'おわり' }; yield { type: 'done', stop: 'end_turn' as StopReason }; })];
  const first = await post(s, '最初');
  await post(s, '待たせた発言');
  g.open();
  await settled(s.app, first.body.runId);
  await waitFor(() => roles(s).length === 3, '保存');
  const warnings = events.filter(e => e.type === 'warning' && e.code.startsWith('queued_')) as Array<Extract<RunEvent, { type: 'warning' }>>;
  assert.deepEqual(warnings.map(w => w.code), ['queued_not_started']);
  assert.match(warnings[0]!.message, /使えるモデルが無/u, '「返事が止まった」ではなく、始められなかった理由を言う');
  assert.doesNotMatch(warnings[0]!.message, /返事が止まった/u);
  assert.deepEqual(warnings[0]!.params, { count: 1 });
  assert.deepEqual(roles(s), ['user:最初', 'assistant:おわり', 'user:待たせた発言']);
  assert.equal(runsOf(s).length, 1);
});
