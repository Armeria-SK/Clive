import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent, StopReason } from '../src/engine/types.ts';
import { readHistory, searchHistory } from '../src/memory/history.ts';
import { MemoryError, MemoryStore, renderBooks } from '../src/memory/store.ts';
import { resolvePaths } from '../src/paths.ts';
import { FakeAdapter, reply, tempDir, type Script, testConfig } from './helpers.ts';

function store(caps = { user: 200, notes: 300 }) {
  const db = openDatabase(':memory:', MIGRATIONS);
  let now = 1_000;
  return { db, memory: new MemoryStore(db, () => caps, () => now++) };
}

test('記憶: 保存・更新・削除と、それぞれの取り消し', () => {
  const { memory } = store();
  const { memory: m, eventId: created } = memory.save({ book: 'user', content: 'ユーザーは  コーヒーより紅茶が好き', actor: 'clive', conversationId: 'c1', messageId: 3 });
  assert.equal(m.content, 'ユーザーは コーヒーより紅茶が好き', '空白をまとめる');
  assert.equal(m.source_message_id, 3);
  const { eventId: updated } = memory.update(m.id, 'ユーザーは紅茶が好き（特にアールグレイ）', 'clive');
  memory.undo(updated);
  assert.equal(memory.get(m.id)!.content, 'ユーザーは コーヒーより紅茶が好き');
  const { eventId: forgotten } = memory.forget(m.id, 'user', 'もう違う');
  assert.equal(memory.list('user').length, 0);
  memory.undo(forgotten);
  assert.equal(memory.list('user').length, 1);
  memory.undo(created);
  assert.equal(memory.list('user').length, 0, '作成の取り消しは忘れる扱い');
  assert.throws(() => memory.undo(created), /既に取り消し/u);
  assert.equal(memory.events(m.id).length, 6);
});

test('記憶: 上限を超える保存は、統合を促すエラーにする（自動では消さない）', () => {
  const { memory } = store({ user: 30, notes: 300 });
  memory.save({ book: 'user', content: 'あ'.repeat(20), actor: 'clive' });
  assert.throws(() => memory.save({ book: 'user', content: 'い'.repeat(20), actor: 'clive' }), (e: unknown) => e instanceof MemoryError && /memory_update でまとめる/u.test(e.message));
  assert.equal(memory.list('user').length, 1);
  assert.doesNotThrow(() => memory.save({ book: 'notes', content: 'い'.repeat(20), actor: 'clive' }), 'ブックごとに上限は別');
});

test('記憶: 秘密情報・重複・長すぎる1件・空は保存しない', () => {
  const { memory } = store({ user: 5000, notes: 5000 });
  assert.throws(() => memory.save({ book: 'user', content: 'キーは sk-ant-api03-abcdefghijklmnop です', actor: 'clive' }), /API キー/u);
  memory.save({ book: 'user', content: '同じ内容', actor: 'clive' });
  assert.throws(() => memory.save({ book: 'user', content: '同じ内容', actor: 'clive' }), /既にあります/u);
  assert.throws(() => memory.save({ book: 'user', content: 'x'.repeat(700), actor: 'clive' }), /長すぎます/u);
  assert.throws(() => memory.save({ book: 'user', content: '   ', actor: 'clive' }), /空/u);
});

test('記憶: 3文字以上は FTS、短い語は LIKE で探す', () => {
  const { memory } = store({ user: 5000, notes: 5000 });
  memory.save({ book: 'user', content: 'ローカルLLMは Ollama で動かしている', actor: 'clive' });
  memory.save({ book: 'notes', content: '猫の名前はタマ', actor: 'clive' });
  assert.equal(memory.search('Ollama').length, 1);
  assert.equal(memory.search('猫').length, 1, '1文字');
  assert.equal(memory.search('タマ 猫').length, 1, '短い語を含む複数語');
  assert.equal(memory.search('犬').length, 0);
  assert.match(renderBooks(memory.list()), /\[u1\] ローカルLLM[\s\S]*\[n2\] 猫/u);
});

test('履歴: 会話をまたいで探し、今の会話は除き、前後を読める', () => {
  const db = openDatabase(':memory:', MIGRATIONS);
  let now = Date.now() - 100 * 86_400_000;
  const conversations = new Conversations(db, () => now);
  conversations.append('old', { role: 'user', content: 'ベクトル検索のライブラリを比べたい' });
  now = Date.now() - 2 * 86_400_000;
  conversations.create({ id: 'recent', title: '最近の相談' });
  conversations.append('recent', { role: 'user', content: 'ベクトル検索は sqlite-vec にしよう' });
  conversations.append('recent', { role: 'assistant', content: 'わかりました' });
  conversations.append('current', { role: 'user', content: 'ベクトル検索の話、いつだっけ' });
  const all = searchHistory(db, 'ベクトル検索', { excludeConversationId: 'current' });
  assert.deepEqual(all.map(h => h.conversationId), ['recent', 'old']);
  assert.equal(all[0]!.title, '最近の相談');
  assert.deepEqual(searchHistory(db, 'ベクトル検索', { days: 30, excludeConversationId: 'current' }).map(h => h.conversationId), ['recent']);
  assert.equal(searchHistory(db, '検索 vec', {}).length, 1, '短い語を含む');
  const around = readHistory(db, 'recent', { aroundMessageId: all[0]!.messageId });
  assert.deepEqual(around.map(r => r.role), ['user', 'assistant']);
});

// ── エンジンとの組み合わせ ────────────────────────────────

function toolCall(name: string, args: unknown): Script {
  return async function* () {
    yield { type: 'tool_call', call: { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args } };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

async function app(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(join(paths.workspace, 'SOUL.md'), '# SOUL\n名前は Clive');
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const a = new App({ paths, databasePath: ':memory:', log: () => undefined, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await a.status.probeAll(a.config());
  const events: RunEvent[] = [];
  a.bus.subscribe(e => events.push(e.event));
  t.after(() => a.close());
  const send = async (conversationId: string, text: string) => {
    const outcome = a.engine.send(conversationId, text);
    assert.ok(outcome.ok, JSON.stringify(outcome));
    return a.engine.wait(outcome.runId)!;
  };
  return { app: a, adapter: () => adapter, events, send, paths };
}

test('会話中に覚えたことは、今の会話の system には入らず、次の会話から入る（キャッシュを壊さない）', async t => {
  const s = await app(t);
  s.adapter().scripts.push(toolCall('memory_save', { book: 'user', content: 'ユーザーは紅茶が好き' }), reply('覚えました'), reply('はい'), reply('紅茶ですね'));
  await s.send('c1', '私は紅茶が好き');
  const changed = s.events.find(e => e.type === 'memory.changed') as Extract<RunEvent, { type: 'memory.changed' }>;
  assert.equal(changed.action, 'create');
  assert.equal(s.app.memory.list('user')[0]!.source_message_id, s.app.conversations.messages('c1')[0]!.id, '出典は発言にひも付く');
  await s.send('c1', 'ありがとう');
  const [first, , third] = s.adapter().calls;
  assert.equal(first!.system.frozen, third!.system.frozen, '同じ会話では system を変えない');
  assert.doesNotMatch(third!.system.frozen, /紅茶/u);
  await s.send('c2', '飲み物の好みは？');
  assert.match(s.adapter().calls[3]!.system.frozen, /\[u\d+\] ユーザーは紅茶が好き/u);
});

test('SOUL.md の書き換えは承認制にし、中身が変わったら版を残す', async t => {
  const s = await app(t);
  s.adapter().scripts.push(toolCall('file_write', { path: 'SOUL.md', content: '# SOUL\n名前は Clive。皮肉屋' }), reply('提案しました'));
  const done = s.send('c1', '性格を変えて');
  for (let i = 0; i < 300 && !s.app.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
  const pending = s.app.approvals.pending()[0]!;
  assert.match(pending.reasons.join(), /人格・プロフィール/u);
  s.app.approvals.decide(pending.id, 'once');
  await done;
  s.adapter().scripts.push(reply('はい'));
  await s.send('c2', 'こんにちは');
  const versions = s.app.db.prepare("SELECT content FROM file_versions WHERE name = 'SOUL.md' ORDER BY id").all() as Array<{ content: string }>;
  assert.equal(versions.length, 2);
  assert.match(versions[1]!.content, /皮肉屋/u);
});
