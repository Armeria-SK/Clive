import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Runs } from '../src/db/runs.ts';
import { tempDir } from './helpers.ts';

// 移し替えの途中の形の DB には Conversations.create が使えない（create は、あとの移し替えで足される列に書くため）。会話の行を直に入れる
function insertOldConversation(db: ReturnType<typeof openDatabase>, id: string, kind: 'chat' | 'task' = 'chat'): void {
  db.prepare('INSERT INTO conversations (id, kind, title, created_at, last_message_at) VALUES (?, ?, ?, 1, 1)').run(id, kind, id);
}

// 段 8b（審査の直し）: 会話ごとの「外から読んだことがある」印（Q16 のあとは、判定役を止めず、判定役に見せる文の 1 行だけに使う。送る・消すを止めるのは humanOnlyOf）と、会話ごとの「自動承認で外を読んだことがある」印（その会話のシェルのコマンドと通信は、ずっと毎回確かめる）

test('マイグレーション 12: conversations に ever_tainted、engine_runs に auto_read_outside が足される。前に外から読んだ実行のある会話は 1 になり、ほかは 0', t => {
  assert.ok(MIGRATIONS.length >= 12);
  const path = join(tempDir(t), 'clive.db');
  const before = openDatabase(path, MIGRATIONS.slice(0, 11));
  const runs = new Runs(before);
  for (const id of ['clean', 'read-web', 'read-web-task']) insertOldConversation(before, id);
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
  const runs = new Runs(before);
  for (const id of ['clean', 'read-outside', 'later']) insertOldConversation(before, id);
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

// 実行の記録の「外から読んだ」印（engine_runs.tainted）は移し替え 10 で足された列なので、main の段階（8）からの更新では、前からある実行の記録は全部 0。
// 12 の付け方（記録から付ける）では 1 つも付かないため、14 が、更新の時点で既にあるすべての会話に付ける
test('マイグレーション 14: main の段階（8）の DB から更新すると、そのとき既にあるすべての会話に ever_tainted が付く（外から読んでいないと確かめられないので）。更新のあとに作る会話は 0', t => {
  const path = join(tempDir(t), 'clive.db');
  const main = openDatabase(path, MIGRATIONS.slice(0, 8));
  for (const [id, kind] of [['old-chat', 'chat'], ['old-chat-with-run', 'chat'], ['old-task', 'task']] as const) insertOldConversation(main, id, kind);
  new Runs(main).start('r-old', 'chat', 'old-chat-with-run');
  main.close();
  const db = openDatabase(path, MIGRATIONS);
  try {
    assert.ok(MIGRATIONS.length >= 14);
    const flag = (id: string) => (db.prepare('SELECT ever_tainted FROM conversations WHERE id = ?').get(id) as { ever_tainted: number }).ever_tainted;
    assert.deepEqual(['old-chat', 'old-chat-with-run', 'old-task'].map(flag), [1, 1, 1], '前の記録に「外から読んだ」実行が無くても、確かめられないので付ける');
    const created = new Conversations(db);
    created.create({ id: 'new-chat' });
    assert.equal(flag('new-chat'), 0, '更新のあとの会話は、読んだときに付く');
    assert.equal(created.everTainted('new-chat'), false);
    assert.equal(created.everTainted('old-chat'), true);
  } finally { db.close(); }
});

test('マイグレーション 14: すでに 14 まで更新した DB を開き直しても、あとから作った会話の印は 0 のまま', t => {
  const path = join(tempDir(t), 'clive.db');
  const first = openDatabase(path, MIGRATIONS);
  new Conversations(first).create({ id: 'after' });
  first.close();
  const again = openDatabase(path, MIGRATIONS);
  try {
    assert.equal(new Conversations(again).everTainted('after'), false, '更新は 1 回だけ（開き直すたびに付け直さない）');
  } finally { again.close(); }
});
