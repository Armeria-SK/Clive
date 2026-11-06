import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import type { ModelRequest } from '../src/providers/types.ts';
import { PERMISSION_MODES, stricterMode } from '../src/shared/permission-mode.ts';
import { CONVERSATION, settled, startApp } from './app-setup.ts';
import { tempDir, type Script } from './helpers.ts';

// 段 8b: 入力欄の権限モード（ふつう / 自動承認 / 計画）。会話ごとに覚える。新しい会話はいつも「ふつう」

test('マイグレーション 11: conversations に permission_mode が足される。前からある会話は normal。知らない値は入れられない', t => {
  const path = join(tempDir(t), 'clive.db');
  const before = openDatabase(path, MIGRATIONS.slice(0, 10));
  before.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at) VALUES ('old', 'chat', '前からある会話', 1, 1)").run();
  before.close();
  const db = openDatabase(path, MIGRATIONS);
  try {
    const row = new Conversations(db).get('old') as unknown as Record<string, unknown>;
    assert.equal(row.permission_mode, 'normal');
    assert.throws(() => db.prepare("UPDATE conversations SET permission_mode = 'yolo' WHERE id = 'old'").run(), /CHECK|constraint/iu);
    assert.throws(() => db.prepare('UPDATE conversations SET permission_mode = NULL WHERE id = ?').run('old'), /NOT NULL|constraint/iu);
  } finally { db.close(); }
});

test('モードの強さ: 計画 > ふつう > 自動承認。厳しい方が勝つ', () => {
  assert.deepEqual([...PERMISSION_MODES], ['normal', 'auto', 'plan']);
  assert.equal(stricterMode('auto', 'normal'), 'normal');
  assert.equal(stricterMode('normal', 'auto'), 'normal');
  assert.equal(stricterMode('auto', 'plan'), 'plan');
  assert.equal(stricterMode('plan', 'normal'), 'plan');
  assert.equal(stricterMode('auto', 'auto'), 'auto');
});

test('PATCH: モードを選ぶと会話に覚え、一覧とメッセージの応答に permission_mode が出る。知らない値・型違いは 400 で、変えない', async t => {
  const s = await startApp(t);
  await s.json('/api/conversations', 'POST', { title: 'モード' });
  const id = s.app.conversations.list()[0]!.id;
  assert.equal(s.app.conversations.get(id)!.permission_mode, 'normal', '新しい会話はふつうから');
  for (const mode of ['auto', 'plan', 'normal'] as const) {
    const ok = await s.json(`/api/conversations/${id}`, 'PATCH', { permissionMode: mode });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.conversation.permission_mode, mode);
    assert.equal((await s.json('/api/conversations', 'GET')).body.conversations[0].permission_mode, mode);
    assert.equal((await s.json(`/api/conversations/${id}/messages`, 'GET')).body.conversation.permission_mode, mode);
  }
  await s.json(`/api/conversations/${id}`, 'PATCH', { permissionMode: 'auto' });
  for (const bad of ['yolo', '', 5, null, true]) {
    const refused = await s.json(`/api/conversations/${id}`, 'PATCH', { permissionMode: bad });
    assert.equal(refused.status, 400, JSON.stringify(bad));
    assert.equal(refused.body.code, 'http.bad_enum', JSON.stringify(bad));
    assert.equal(s.app.conversations.get(id)!.permission_mode, 'auto', `${JSON.stringify(bad)}: 拒否したら変えない`);
  }
  const mixed = await s.json(`/api/conversations/${id}`, 'PATCH', { title: '変えない', permissionMode: 'yolo' });
  assert.equal(mixed.status, 400);
  assert.equal(s.app.conversations.get(id)!.title, 'モード', '一緒に送った題の変更も取りやめる');
});

test('最初の発言でモードを選べて、あとの送信でも覚えている。モードを省いた最初の発言はふつう', async t => {
  const s = await startApp(t);
  s.adapter().scripts = [async function* () { yield { type: 'text', delta: '一つ目' }; yield { type: 'done', stop: 'end_turn' as StopReason }; },
    async function* () { yield { type: 'text', delta: '二つ目' }; yield { type: 'done', stop: 'end_turn' as StopReason }; }];
  const first = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'こんにちは', permissionMode: 'auto' });
  assert.equal(first.status, 202);
  await settled(s.app, first.body.runId);
  assert.equal(s.app.conversations.get(CONVERSATION)!.permission_mode, 'auto', '渡されたら会話に覚える');
  const second = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'もう一度' });
  await settled(s.app, second.body.runId);
  assert.equal(s.app.conversations.get(CONVERSATION)!.permission_mode, 'auto', '省いた送信は覚えたまま');

  const plain = await s.json(`/api/conversations/aaaaaaaa-0000-4000-8000-000000000002/messages`, 'POST', { text: 'はじめて' });
  await settled(s.app, plain.body.runId);
  assert.equal(s.app.conversations.get('aaaaaaaa-0000-4000-8000-000000000002')!.permission_mode, 'normal');

  const bad = await s.json(`/api/conversations/aaaaaaaa-0000-4000-8000-000000000003/messages`, 'POST', { text: 'だめ', permissionMode: 'yolo' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'http.bad_enum');
  assert.equal(s.app.conversations.get('aaaaaaaa-0000-4000-8000-000000000003'), undefined, '断ったときは会話も残らない');
});

type Started = Awaited<ReturnType<typeof startApp>>;
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }
const after = (g: { promise: Promise<void> }, script: Script): Script => async function* (req) {
  await Promise.race([g.promise, new Promise<never>((_, reject) => { req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }); })]);
  yield* script(req);
};
const say = (text: string): Script => async function* () { yield { type: 'text', delta: text }; yield { type: 'done', stop: 'end_turn' as StopReason }; };
const toolCall = (name: string, args: unknown): Script => async function* () {
  const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};
const sawText = (req: ModelRequest, text: string) => JSON.stringify(req.messages).includes(text);
const post = (s: Started, text: string, extra: Record<string, unknown> = {}) => s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text, ...extra });

test('実行中にモードを替えたら、モデルを替えたときと同じ: そのあとに送った発言は今の実行へ差し込まず、実行が終わってから新しいモードの実行で読ませる', async t => {
  const s = await startApp(t);
  mkdirSync(s.paths.workspace, { recursive: true });
  writeFileSync(join(s.paths.workspace, 'a.txt'), 'こんにちは');
  const g = gate();
  s.adapter().scripts = [after(g, toolCall('file_read', { path: 'a.txt' })), say('ふつうの返事'), say('計画の返事')];
  const first = await post(s, 'a.txt を読んで');
  assert.equal((await post(s, 'EARLIER')).body.queued, true);
  assert.equal((await s.json(`/api/conversations/${CONVERSATION}`, 'PATCH', { permissionMode: 'plan' })).status, 200);
  const secret = await post(s, 'SECRET');
  assert.equal(secret.body.queued, true);
  assert.equal(secret.body.runId, first.body.runId);
  g.open();
  await s.app.engine.wait(first.body.runId);
  const second = s.app.engine.activeRuns().find(r => r.conversationId === CONVERSATION);
  assert.ok(second && second.runId !== first.body.runId, '古い実行が終わったとき、新しい実行が始まっている');
  await settled(s.app, second.runId);
  const calls = s.adapter().calls;
  assert.equal(calls.length, 3);
  assert.ok(calls.slice(0, 2).every(c => !sawText(c, 'SECRET')), '始めのモードの実行に、替えたあとの発言が混ざらない');
  assert.ok(sawText(calls[1]!, 'EARLIER'), '替える前に待たせた発言は、今までどおり差し込む');
  assert.ok(sawText(calls[2]!, 'SECRET'), '新しいモードの実行が、待たせていた発言を読む');
});

test('実行中にモードを替えて、また元に戻したなら、発言は保留しない（始まったときのモードと同じなので差し込める）', async t => {
  const s = await startApp(t);
  mkdirSync(s.paths.workspace, { recursive: true });
  writeFileSync(join(s.paths.workspace, 'a.txt'), 'こんにちは');
  const g = gate();
  s.adapter().scripts = [after(g, toolCall('file_read', { path: 'a.txt' })), say('返事')];
  const first = await post(s, 'a.txt を読んで');
  await s.json(`/api/conversations/${CONVERSATION}`, 'PATCH', { permissionMode: 'auto' });
  await s.json(`/api/conversations/${CONVERSATION}`, 'PATCH', { permissionMode: 'normal' });
  assert.equal((await post(s, 'BACK')).body.queued, true);
  g.open();
  await settled(s.app, first.body.runId);
  assert.equal(s.adapter().calls.length, 2, '新しい実行は始まらず、同じ実行が読む');
  assert.ok(sawText(s.adapter().calls[1]!, 'BACK'));
});
