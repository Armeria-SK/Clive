import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Runs } from '../src/db/runs.ts';
import { tempDir } from './helpers.ts';

// 段 8b（審査の直し）: 会話ごとの「外から読んだことがある」印（自動承認の判定役を、その会話では使わない）と、会話ごとの「自動承認で外を読んだことがある」印（その会話のシェルのコマンドと通信は、ずっと毎回確かめる）

test('マイグレーション 12: conversations に ever_tainted、engine_runs に auto_read_outside が足される。前に外から読んだ実行のある会話は 1 になり、ほかは 0', t => {
  assert.ok(MIGRATIONS.length >= 12);
  const path = join(tempDir(t), 'clive.db');
  const before = openDatabase(path, MIGRATIONS.slice(0, 11));
  const conversations = new Conversations(before);
  const runs = new Runs(before);
  for (const id of ['clean', 'read-web', 'read-web-task']) conversations.create({ id, title: id });
  runs.start('r-clean', 'chat', 'clean');
  runs.start('r-web', 'chat', 'read-web');
  runs.markTainted('r-web');
  runs.start('r-task', 'task', 'read-web-task');
  runs.markTainted('r-task');
  before.close();
  const db = openDatabase(path, MIGRATIONS.slice(0, 12));
  try {
    const convoColumns = (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(c => c.name);
    const runColumns = (db.prepare('PRAGMA table_info(engine_runs)').all() as Array<{ name: string }>).map(c => c.name);
    assert.ok(convoColumns.includes('ever_tainted'));
    assert.ok(runColumns.includes('auto_read_outside'));
    const flag = (id: string) => (db.prepare('SELECT ever_tainted FROM conversations WHERE id = ?').get(id) as { ever_tainted: number }).ever_tainted;
    assert.deepEqual([flag('clean'), flag('read-web'), flag('read-web-task')], [0, 1, 0], 'チャットの実行が読んでいた会話だけ。タスクの会話の実行は数えない');
    assert.equal((db.prepare('SELECT auto_read_outside FROM engine_runs WHERE id = ?').get('r-web') as { auto_read_outside: number }).auto_read_outside, 0);
    assert.throws(() => db.prepare('UPDATE conversations SET ever_tainted = NULL WHERE id = ?').run('clean'), /NOT NULL|constraint/iu);
  } finally { db.close(); }
});

test('会話の印: markTainted で付けたら外れない。無い会話は読めないので、外から読んだことがあるとみなす', t => {
  const db = openDatabase(join(tempDir(t), 'clive.db'), MIGRATIONS);
  try {
    const conversations = new Conversations(db);
    conversations.create({ id: 'c1' });
    assert.equal(conversations.everTainted('c1'), false);
    conversations.markTainted('c1');
    assert.equal(conversations.everTainted('c1'), true);
    conversations.markTainted('c1');
    assert.equal(conversations.everTainted('c1'), true);
    assert.equal(conversations.everTainted('missing'), true, '読めないときは、外から読んだことがあるほうに倒す');
    conversations.markTainted('missing');
  } finally { db.close(); }
});

test('会話の印: markAutoRead で付けたら外れない。無い会話は読めないので、自動承認で外を読んだことがあるとみなす', t => {
  const db = openDatabase(join(tempDir(t), 'clive.db'), MIGRATIONS);
  try {
    const conversations = new Conversations(db);
    conversations.create({ id: 'c1' });
    conversations.create({ id: 'c2' });
    assert.equal(conversations.everAutoRead('c1'), false);
    conversations.markAutoRead('c1');
    conversations.markAutoRead('c1');
    assert.deepEqual([conversations.everAutoRead('c1'), conversations.everAutoRead('c2')], [true, false]);
    assert.equal(conversations.everAutoRead('missing'), true, '読めないときは、読んだことがあるほうに倒す');
    assert.equal((db.prepare('SELECT ever_tainted FROM conversations WHERE id = ?').get('c1') as { ever_tainted: number }).ever_tainted, 0, '外から読んだ印とは別');
    const listed = conversations.list().find(c => c.id === 'c1')!;
    assert.ok(!('ever_auto_read' in listed), '一覧の型には載せない');
  } finally { db.close(); }
});

test('マイグレーション 13: conversations に ever_auto_read が足され、engine_runs.auto_read_outside は無くなる。自動承認で外を読んだ実行のある会話は 1 になり、ほかは 0', t => {
  assert.ok(MIGRATIONS.length >= 13);
  const path = join(tempDir(t), 'clive.db');
  const before = openDatabase(path, MIGRATIONS.slice(0, 12));
  const conversations = new Conversations(before);
  const runs = new Runs(before);
  for (const id of ['clean', 'read-outside', 'later']) conversations.create({ id, title: id });
  runs.start('r-clean', 'chat', 'clean');
  runs.start('r-outside', 'chat', 'read-outside');
  before.prepare('UPDATE engine_runs SET auto_read_outside = 1 WHERE id = ?').run('r-outside');
  runs.start('r-later', 'chat', 'later');
  before.close();
  const db = openDatabase(path, MIGRATIONS);
  try {
    const convoColumns = (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(c => c.name);
    const runColumns = (db.prepare('PRAGMA table_info(engine_runs)').all() as Array<{ name: string }>).map(c => c.name);
    assert.ok(convoColumns.includes('ever_auto_read'));
    assert.ok(!runColumns.includes('auto_read_outside'), '実行ごとの印は、会話の印に置き換わった');
    const flag = (id: string) => (db.prepare('SELECT ever_auto_read FROM conversations WHERE id = ?').get(id) as { ever_auto_read: number }).ever_auto_read;
    assert.deepEqual([flag('clean'), flag('read-outside'), flag('later')], [0, 1, 0]);
    assert.throws(() => db.prepare('UPDATE conversations SET ever_auto_read = NULL WHERE id = ?').run('clean'), /NOT NULL|constraint/iu);
  } finally { db.close(); }
});
