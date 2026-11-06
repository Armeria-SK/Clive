import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './app-setup.ts';
import { writeChecklist } from '../src/tools/builtin/checklist-core.ts';

test('作業の一覧を読む API: GET /api/conversations/:id/checklist は一覧を返す。会話が無ければ 404、一覧が無ければ空の一覧', async t => {
  const s = await startApp(t);
  // 会話が無ければ 404（summary と同じ）
  const missing = await s.json('/api/conversations/aaaaaaaa-0000-4000-8000-0000000000ff/checklist', 'GET');
  assert.equal(missing.status, 404);
  // 作ったばかりの会話は空の一覧
  const fresh = await s.json('/api/conversations', 'POST', { title: '空' });
  const id = fresh.body.conversation.id;
  const empty = await s.json(`/api/conversations/${id}/checklist`, 'GET');
  assert.deepEqual({ status: empty.status, items: empty.body.items, tainted: empty.body.tainted, updatedAt: empty.body.updatedAt }, { status: 200, items: [], tainted: false, updatedAt: null });
  // 一覧を書いたらその内容が返る
  writeChecklist(s.app.kv, id, [{ text: 'a', status: 'pending' }], false, 1);
  const got = await s.json(`/api/conversations/${id}/checklist`, 'GET');
  assert.equal(got.status, 200);
  assert.equal(got.body.items.length, 1);
  assert.deepEqual(got.body.items[0], { text: 'a', status: 'pending' });
  // 会話を消すと一覧も消える（erase.ts の決まりに乗っていることの確かめ）
  const del = await s.json(`/api/conversations/${id}`, 'DELETE');
  assert.equal(del.status, 200);
  assert.equal(s.app.kv.get('checklist:' + id), undefined);
});
