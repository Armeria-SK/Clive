import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Runs } from '../src/db/runs.ts';
import { tempDir } from './helpers.ts';

test('マイグレーションは新規でも再オープンでも同じ状態になる', t => {
  const path = join(tempDir(t), 'clive.db');
  openDatabase(path, MIGRATIONS).close();
  const db = openDatabase(path, MIGRATIONS);
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(user_version, MIGRATIONS.length);
  db.close();
});

test('アプリより新しいスキーマは開かない', t => {
  const path = join(tempDir(t), 'clive.db');
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => openDatabase(path, MIGRATIONS), /新しい/);
});

test('未適用のマイグレーションがあれば、適用前にバックアップを取る', t => {
  const dir = tempDir(t);
  const path = join(dir, 'clive.db');
  openDatabase(path, MIGRATIONS.slice(0, 1)).close();
  openDatabase(path, [...MIGRATIONS, 'CREATE TABLE extra (id INTEGER) STRICT;'], { backupDir: join(dir, 'backups') }).close();
  assert.equal(readdirSync(join(dir, 'backups')).length, 1);
});

test('発言を追加すると、会話の行が無くても同じトランザクションで作る', () => {
  const db = openDatabase(':memory:', MIGRATIONS);
  const conversations = new Conversations(db);
  const saved = conversations.append('c1', { role: 'user', content: 'こんにちは' });
  assert.ok(saved.id > 0);
  assert.ok(conversations.get('c1'));
  conversations.append('c1', { role: 'assistant', content: 'やあ' });
  assert.deepEqual(conversations.messages('c1').map(m => m.message), [
    { role: 'user', content: 'こんにちは' },
    { role: 'assistant', content: 'やあ' },
  ]);
});

test('発言は trigram で日本語の部分一致検索ができる', () => {
  const db = openDatabase(':memory:', MIGRATIONS);
  const conversations = new Conversations(db);
  conversations.append('c1', { role: 'user', content: 'ローカルLLMのコンテキスト長を確認したい' });
  const hits = db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`).all('"コンテキスト"');
  assert.equal(hits.length, 1);
});

test('凍結スナップショットは一度しか書かれない', () => {
  const db = openDatabase(':memory:', MIGRATIONS);
  const conversations = new Conversations(db);
  conversations.create({ id: 'c1' });
  assert.equal(conversations.setSnapshotOnce('c1', 'A', 'ha'), true);
  assert.equal(conversations.setSnapshotOnce('c1', 'B', 'hb'), false);
  assert.equal(conversations.get('c1')?.snapshot, 'A');
});

test('実行記録の開始・終了と、再起動時の片付け', () => {
  const db = openDatabase(':memory:', MIGRATIONS);
  let now = 1000;
  const runs = new Runs(db, () => now);
  runs.start('r1', 'chat', 'c1');
  now = 1500;
  runs.finish('r1', { ok: true, attempts: 2, modelId: 'm', usage: { inputTokens: 10, outputTokens: 5 }, flags: ['x'] });
  const row = runs.get('r1')!;
  assert.equal(row.ok, 1);
  assert.equal(row.duration_ms, 500);
  assert.equal(row.attempts, 2);
  assert.equal(row.flags, '["x"]');
  runs.start('r2', 'chat');
  assert.equal(runs.closeDangling(), 1);
  assert.equal(runs.get('r2')!.error_kind, 'cancelled');
});

test('KV の読み書き', () => {
  const kv = new KV(openDatabase(':memory:', MIGRATIONS));
  kv.setJson('a', { b: 1 });
  assert.deepEqual(kv.getJson('a'), { b: 1 });
  kv.set('a', 'not json');
  assert.equal(kv.getJson('a'), undefined);
  kv.delete('a');
  assert.equal(kv.get('a'), undefined);
});
