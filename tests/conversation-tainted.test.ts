import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Runs } from '../src/db/runs.ts';
import { tempDir } from './helpers.ts';

// 段 8b（審査の直し）: 会話ごとの「外から読んだことがある」印（自動承認の判定役を、その会話では使わない）と、実行ごとの「自動承認で外を読んだ」印

test('マイグレーション 12: conversations に ever_tainted、engine_runs に auto_read_outside が足される。前に外から読んだ実行のある会話は 1 になり、ほかは 0', t => {
  assert.equal(MIGRATIONS.length, 12);
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
  const db = openDatabase(path, MIGRATIONS);
  try {
    const convoColumns = (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(c => c.name);
    const runColumns = (db.prepare('PRAGMA table_info(engine_runs)').all() as Array<{ name: string }>).map(c => c.name);
    assert.ok(convoColumns.includes('ever_tainted'));
    assert.ok(runColumns.includes('auto_read_outside'));
    const flag = (id: string) => (db.prepare('SELECT ever_tainted FROM conversations WHERE id = ?').get(id) as { ever_tainted: number }).ever_tainted;
    assert.deepEqual([flag('clean'), flag('read-web'), flag('read-web-task')], [0, 1, 0], 'チャットの実行が読んでいた会話だけ。タスクの会話の実行は数えない');
    assert.equal(new Runs(db).get('r-web')!.auto_read_outside, 0);
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

test('実行の印: markAutoRead で付けた実行は auto_read_outside が 1。付けなければ 0', t => {
  const db = openDatabase(join(tempDir(t), 'clive.db'), MIGRATIONS);
  try {
    const runs = new Runs(db);
    runs.start('a', 'chat', 'c1');
    runs.start('b', 'chat', 'c1');
    runs.markAutoRead('a');
    assert.deepEqual([runs.get('a')!.auto_read_outside, runs.get('b')!.auto_read_outside], [1, 0]);
  } finally { db.close(); }
});
