import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunEvent } from '../src/engine/types.ts';
import { PAGE_META } from '../web/src/pages.ts';
import { parseRoute, routeHash } from '../web/src/routes.ts';
import { startApp, uuid } from './app-setup.ts';

async function make(s: Awaited<ReturnType<typeof startApp>>, n: number, title: string, at: number) {
  const id = uuid(n);
  s.app.conversations.create({ id, title });
  s.app.db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(at, id);
  return id;
}

test('GET /api/conversations?archived=1 は、アーカイブしたチャットだけを新しい順に返す。ふつうの一覧には出ない', async t => {
  const s = await startApp(t);
  const a = await make(s, 1, '古いもの', 100);
  const b = await make(s, 2, '新しいもの', 300);
  const c = await make(s, 3, 'そのまま', 200);
  s.app.conversations.create({ id: uuid(4), title: 'タスクの会話', kind: 'task' });
  s.app.conversations.archive(uuid(4));
  await s.json(`/api/conversations/${a}`, 'PATCH', { archived: true });
  await s.json(`/api/conversations/${b}`, 'PATCH', { archived: true });
  const listed = (await s.json('/api/conversations', 'GET')).body.conversations.map((x: { id: string }) => x.id);
  assert.deepEqual(listed, [c], 'ふつうの一覧にはアーカイブしたものが出ない');
  const archived = await s.json('/api/conversations?archived=1', 'GET');
  assert.equal(archived.status, 200);
  assert.deepEqual(archived.body.conversations.map((x: { id: string }) => x.id), [b, a], '新しい順。タスクの会話は含めない');
  assert.ok(archived.body.conversations.every((x: { archived: number }) => x.archived === 1));
  assert.ok(archived.body.conversations.every((x: object) => !('snapshot' in x) && !('summary' in x)), '全文は載せない');
});

test('アーカイブした会話の題で絞れる（q。大文字小文字を区別せず、% と _ は文字として探す）。戻すとふつうの一覧に戻る', async t => {
  const s = await startApp(t);
  const ids = [await make(s, 1, 'Docker の相談', 1), await make(s, 2, '旅行の計画', 2), await make(s, 3, '100% のやる気', 3), await make(s, 4, 'abc', 4)];
  for (const id of ids) await s.json(`/api/conversations/${id}`, 'PATCH', { archived: true });
  const titles = async (q: string) => (await s.json(`/api/conversations?archived=1&q=${encodeURIComponent(q)}`, 'GET')).body.conversations.map((x: { title: string }) => x.title);
  assert.deepEqual(await titles('docker'), ['Docker の相談']);
  assert.deepEqual(await titles('旅行'), ['旅行の計画']);
  assert.deepEqual(await titles('%'), ['100% のやる気'], '% はそのままの文字');
  assert.deepEqual(await titles('_'), [], '_ は何にでも当たる印ではない');
  assert.deepEqual(await titles(' '), ['abc', '100% のやる気', '旅行の計画', 'Docker の相談'], '空白だけなら絞らない');
  const back = await s.json(`/api/conversations/${ids[1]}`, 'PATCH', { archived: false });
  assert.equal(back.status, 200);
  assert.ok((await s.json('/api/conversations', 'GET')).body.conversations.some((x: { id: string }) => x.id === ids[1]));
  assert.ok(!(await titles('旅行')).length, 'アーカイブの一覧からは消える');
});

test('アーカイブした会話も、開いて読める（メッセージの API はそのまま）', async t => {
  const s = await startApp(t);
  const id = await make(s, 1, '読む', 1);
  s.app.conversations.append(id, { role: 'user', content: 'こんにちは' });
  await s.json(`/api/conversations/${id}`, 'PATCH', { archived: true });
  const got = await s.json(`/api/conversations/${id}/messages`, 'GET');
  assert.equal(got.status, 200);
  assert.equal(got.body.conversation.archived, 1);
  assert.deepEqual(got.body.messages.map((m: { text: string }) => m.text), ['こんにちは']);
});

test('アーカイブ・戻す・題の変更は、ほかの画面にも届くよう出来事（conversation.changed）を流す', async t => {
  const s = await startApp(t);
  const id = await make(s, 1, '題', 1);
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  await s.json(`/api/conversations/${id}`, 'PATCH', { archived: true });
  await s.json(`/api/conversations/${id}`, 'PATCH', { archived: false });
  await s.json(`/api/conversations/${id}`, 'PATCH', { title: '新しい題' });
  assert.deepEqual(events.filter(e => e.type === 'conversation.changed').map(e => (e as { change: string }).change), ['archived', 'unarchived', 'renamed']);
  await s.json(`/api/conversations/${id}`, 'PATCH', { modelId: null });
  assert.equal(events.filter(e => e.type === 'conversation.changed').length, 3, '題もアーカイブも変えない PATCH では流さない');
});

test('画面: #/archived の経路とページの名前', () => {
  assert.deepEqual(parseRoute('#/archived'), { page: 'archived' });
  assert.equal(routeHash({ page: 'archived' }), '#/archived');
  assert.equal(PAGE_META.archived.icon, 'archive');
});
