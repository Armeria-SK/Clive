import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { resolvePaths } from '../src/paths.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { checklistWrite } from '../src/tools/builtin/checklist.ts';
import { readChecklist } from '../src/tools/builtin/checklist-core.ts';
import { KV } from '../src/db/kv.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { tempDir, testConfig } from './helpers.ts';

function setup(t: { after: (fn: () => void) => void }, mutate: (c: AppConfig) => void = () => undefined) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  mutate(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const memory = new MemoryStore(db);
  const approvals = new ApprovalBroker(db, () => undefined);
  const registry = new ToolRegistry().register(checklistWrite);
  const policy = buildPolicy(parsed, paths);
  const events: RunEvent[] = [];
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
    services: { db, memory, emit: e => events.push(e) },
  };
  const call = (name: string, args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, { registry, approvals, db, emit: e => events.push(e), conversationAutoRead: () => false });
  return { ctx, db, call, events, config: parsed };
}

const kv = (db: DatabaseSync) => new KV(db);

test('checklist_write: 一覧を書く（前の一覧を丸ごと置き換える）', async t => {
  const s = setup(t);
  const out = await s.call('checklist_write', {
    items: [
      { text: '調べる', status: 'done' },
      { text: '直す', status: 'in_progress' },
      { text: '試す', status: 'pending' },
    ],
  });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /3/);
  assert.match(out.output.content, /1/);
  const list = readChecklist(kv(s.db), 'c1');
  assert.equal(list?.items.length, 3);
  const updated = s.events.filter(e => e.type === 'checklist.updated');
  assert.equal(updated.length, 1);
  assert.equal((updated[0] as { items: unknown[] }).items.length, 3);
});

test('checklist_write: もう一度書くと置き換わる（足されない）', async t => {
  const s = setup(t);
  await s.call('checklist_write', { items: [{ text: 'a', status: 'pending' }, { text: 'b', status: 'pending' }] });
  const out = await s.call('checklist_write', { items: [{ text: 'c', status: 'pending' }] });
  assert.equal(out.decision, 'allow');
  const list = readChecklist(kv(s.db), 'c1');
  assert.equal(list?.items.length, 1);
  assert.equal(list?.items[0]?.text, 'c');
});

test('checklist_write: items を空にすると消える', async t => {
  const s = setup(t);
  await s.call('checklist_write', { items: [{ text: 'a', status: 'pending' }] });
  const out = await s.call('checklist_write', { items: [] });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /空/u);
  assert.equal(readChecklist(kv(s.db), 'c1'), undefined);
  const updated = s.events.filter(e => e.type === 'checklist.updated');
  assert.equal(updated.length, 2);
  assert.equal((updated[1] as { items: unknown[] }).items.length, 0);
});

test('checklist_write: 引数の誤り（31 個・201 文字・status: skip・知らない項目）は実行しない', async t => {
  const s = setup(t);
  const thirtyOne = Array.from({ length: 31 }, (_, i) => ({ text: `item${i}`, status: 'pending' as const }));
  const long = 'あ'.repeat(201);
  const cases = [
    { items: thirtyOne },
    { items: [{ text: long, status: 'pending' }] },
    { items: [{ text: 'x', status: 'skip' }] },
    { items: [], url: 'x' },
  ];
  for (const args of cases) {
    const out = await s.call('checklist_write', args);
    assert.equal(out.decision, 'deny');
    assert.equal(out.invalidArguments, true);
    assert.ok(out.output.isError);
  }
  assert.equal(readChecklist(kv(s.db), 'c1'), undefined);
  assert.equal(s.events.filter(e => e.type === 'checklist.updated').length, 0);
});

test('checklist_write: 外の内容を読んだあと（tainted）に書くと、保存の tainted が true', async t => {
  const s = setup(t);
  const taintedCtx: ToolContext = { ...s.ctx, taint: { tainted: true, sources: ['web_fetch'] } };
  const out = await s.call('checklist_write', { items: [{ text: 'a', status: 'pending' }] }, taintedCtx);
  assert.equal(out.decision, 'allow');
  const list = readChecklist(kv(s.db), 'c1');
  assert.equal(list?.tainted, true);
  const updated = s.events.filter(e => e.type === 'checklist.updated');
  assert.equal((updated[0] as { tainted: boolean }).tainted, true);
});

test('checklist_write: services の無い ctx では isError', async t => {
  const s = setup(t);
  const noServices: ToolContext = { ...s.ctx, services: undefined };
  const out = await s.call('checklist_write', { items: [{ text: 'a', status: 'pending' }] }, noServices);
  assert.ok(out.output.isError);
  assert.match(out.output.content, /保存できません/u);
});

test('checklist_write: kind: review では使えない（pipeline.tool_not_allowed）', async t => {
  const s = setup(t);
  const reviewCtx: ToolContext = { ...s.ctx, kind: 'review' };
  const out = await s.call('checklist_write', { items: [{ text: 'a', status: 'pending' }] }, reviewCtx);
  assert.equal(out.decision, 'deny');
  assert.match(out.output.content, /この種類の実行では使えません/u);
});

test('checklist_write: 英語の設定では出力に日本語の文字が無い', async t => {
  const s = setup(t, c => { c.language = 'en'; });
  const out = await s.call('checklist_write', { items: [{ text: 'a', status: 'pending' }] });
  assert.equal(out.decision, 'allow');
  assert.ok(!/[぀-ヿ゠-ヿ一-鿿]/u.test(out.output.content));
});
