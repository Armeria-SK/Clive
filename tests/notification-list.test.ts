import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrangeNotifications, NOTIFICATION_LIST_LIMIT, PINNED_KINDS } from '../src/shared/notification-list.ts';
import type { NotificationItem } from '../web/src/api.ts';
import { withNotification, withRead } from '../web/src/notification-meta.ts';
import { startApp } from './app-setup.ts';

const flood = (notify: (n: { kind: 'info'; title: string }) => unknown, count: number, from = 0) => {
  for (let i = from; i < from + count; i++) notify({ kind: 'info', title: `info ${i}` });
};

test('一覧: 未読の承認待ちの後に info が 60 件続いても、承認待ちは先頭に残る（新しい 50 件 + 承認待ち 1 件、重ならない）', async t => {
  const s = await startApp(t);
  const { notifications } = s.app;
  const approval = notifications.notify({ kind: 'approval_needed', title: '承認してください', dedupKey: 'approval:a1' })!;
  flood(n => notifications.notify(n), 60);
  const list = notifications.list();
  assert.equal(list.length, NOTIFICATION_LIST_LIMIT + 1);
  assert.equal(list[0]!.id, approval.id, '未読の大事な通知は先頭');
  assert.deepEqual(list.slice(1).map(n => n.title), Array.from({ length: 50 }, (_, i) => `info ${59 - i}`), 'その下は新しい順の 50 件');
  assert.equal(new Set(list.map(n => n.id)).size, list.length, '重ならない');
  assert.equal(notifications.unread(), 61, '未読の数は全部数える');
});

test('一覧: 画面が読む API（GET /api/notifications）も、同じ並びで未読の承認待ち・質問・失敗を返す', async t => {
  const s = await startApp(t);
  const { notifications } = s.app;
  const approval = notifications.notify({ kind: 'approval_needed', title: '承認', dedupKey: 'approval:a1' })!;
  const waiting = notifications.notify({ kind: 'task_waiting', title: '質問', dedupKey: 'w1' })!;
  const failed = notifications.notify({ kind: 'task_failed', title: '失敗', dedupKey: 'f1' })!;
  flood(n => notifications.notify(n), 100);
  const res = await s.json('/api/notifications', 'GET');
  assert.equal(res.status, 200);
  const list = res.body.notifications as Array<{ id: number; kind: string }>;
  assert.deepEqual(list.slice(0, 3).map(n => n.id), [failed.id, waiting.id, approval.id], '大事な未読は新しい順に先頭');
  assert.equal(list.length, 3 + NOTIFICATION_LIST_LIMIT);
  assert.equal(res.body.unread, 103);
});

test('一覧: 既読になった大事な通知は先頭から外れ、新しい順の 50 件に入らなければ消える。task_done・health_alert・info は先頭に出さない', async t => {
  const s = await startApp(t);
  const { notifications } = s.app;
  const approval = notifications.notify({ kind: 'approval_needed', title: '承認', dedupKey: 'approval:a1' })!;
  const done = notifications.notify({ kind: 'task_done', title: '終わった', dedupKey: 'd1' })!;
  const alert = notifications.notify({ kind: 'health_alert', title: '不調', dedupKey: 'h1' })!;
  flood(n => notifications.notify(n), 60);
  assert.ok(!notifications.list().some(n => n.id === done.id || n.id === alert.id), '大事な種類以外の古い未読は、これまでどおり 50 件の外');
  notifications.markRead([approval.id]);
  const list = notifications.list();
  assert.equal(list.length, NOTIFICATION_LIST_LIMIT);
  assert.ok(!list.some(n => n.id === approval.id), '既読の古い通知は出ない');
});

test('一覧: 大事な未読が新しい 50 件の中にあっても、先頭に 1 回だけ出る', async t => {
  const s = await startApp(t);
  const { notifications } = s.app;
  flood(n => notifications.notify(n), 5);
  const failed = notifications.notify({ kind: 'task_failed', title: '失敗', dedupKey: 'f1' })!;
  flood(n => notifications.notify(n), 5, 5);
  const list = notifications.list();
  assert.equal(list.length, 11);
  assert.equal(list[0]!.id, failed.id);
  assert.equal(list.filter(n => n.id === failed.id).length, 1);
  assert.deepEqual(list.slice(1).map(n => n.title), Array.from({ length: 10 }, (_, i) => `info ${9 - i}`));
});

test('一覧: 大事な種類は承認待ち・タスクの質問・タスクの失敗の 3 つ', () => {
  assert.deepEqual([...PINNED_KINDS], ['approval_needed', 'task_waiting', 'task_failed']);
});

// ── 画面側（サーバーと同じ並べ方で、届いた通知・既読を反映する）──
let seq = 0;
const item = (kind: string, patch: Partial<NotificationItem> = {}): NotificationItem => {
  seq += 1;
  return { id: seq, kind, title: `${kind} ${seq}`, body: null, link: null, read_at: null, created_at: seq, ...patch };
};

test('画面: info が続けて届いても、未読の承認待ちは一覧の先頭に残る', () => {
  const approval = item('approval_needed');
  let list: NotificationItem[] | null = null;
  list = withNotification(list, approval);
  for (let i = 0; i < 120; i++) list = withNotification(list, item('info'));
  assert.equal(list.length, NOTIFICATION_LIST_LIMIT + 1);
  assert.equal(list[0]!.id, approval.id);
  assert.equal(new Set(list.map(n => n.id)).size, list.length);
  assert.deepEqual(list.slice(1).map(n => n.id), list.slice(1).map(n => n.id).sort((a, b) => b - a), 'その下は新しい順');
});

test('画面: 同じ id の通知が重ねて届いても 1 件。既読にすると先頭から外れる', () => {
  const approval = item('task_waiting');
  let list = withNotification(withNotification(null, approval), approval);
  assert.equal(list.length, 1);
  for (let i = 0; i < 60; i++) list = withNotification(list, item('info'));
  assert.equal(list[0]!.id, approval.id);
  const afterOne = withRead(list, [approval.id], 999)!;
  assert.equal(afterOne.length, NOTIFICATION_LIST_LIMIT, '既読になった古い通知は新しい順の 50 件の外へ');
  assert.ok(!afterOne.some(n => n.id === approval.id));
  const afterAll = withRead(list, undefined, 999)!;
  assert.equal(afterAll.length, NOTIFICATION_LIST_LIMIT);
  assert.ok(afterAll.every(n => n.read_at !== null));
  assert.equal(withRead(null, undefined, 1), null);
});

test('画面: 新しい 50 件の中の通知を既読にしても、一覧には残り、新しい順の場所に戻る', () => {
  const failed = item('task_failed');
  let list = withNotification(null, failed);
  for (let i = 0; i < 3; i++) list = withNotification(list, item('info'));
  assert.equal(list[0]!.id, failed.id);
  const read = withRead(list, [failed.id], 5)!;
  assert.equal(read.length, 4);
  assert.equal(read[read.length - 1]!.id, failed.id, '古いので、新しい順では最後');
  assert.equal(read[read.length - 1]!.read_at, 5);
});

test('arrangeNotifications: 先に来た同じ id を使い、大事な未読を新しい順に先頭へ', () => {
  const rows = [
    { id: 3, kind: 'info', read_at: null, tag: 'new-3' }, { id: 3, kind: 'info', read_at: 9, tag: 'old-3' },
    { id: 2, kind: 'approval_needed', read_at: null, tag: 'a' }, { id: 1, kind: 'task_failed', read_at: null, tag: 'f' },
  ];
  assert.deepEqual(arrangeNotifications(rows, 1).map(r => r.tag), ['a', 'f', 'new-3']);
  assert.deepEqual(arrangeNotifications(rows, 0).map(r => r.tag), ['a', 'f']);
});
