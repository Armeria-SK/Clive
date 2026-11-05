import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { MemoryError, MemoryStore } from '../src/memory/store.ts';
import { resolvePaths } from '../src/paths.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { memoryForget, memorySave, memorySearch, memoryUpdate } from '../src/tools/builtin/memory.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
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
  const registry = new ToolRegistry().register(memorySave).register(memoryUpdate).register(memoryForget).register(memorySearch);
  const policy = buildPolicy(parsed, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
    services: { db, memory, emit: () => undefined },
  };
  const call = (name: string, args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, { registry, approvals, db, emit: () => undefined });
  return { ctx, call, approvals, memory, db, config: parsed };
}

async function decideNext(s: ReturnType<typeof setup>, decision: 'once' | 'conversation' | 'deny') {
  for (let i = 0; i < 200 && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
  const pending = s.approvals.pending()[0];
  assert.ok(pending, '承認の依頼が来ていない');
  s.approvals.decide(pending.id, decision);
  return pending;
}

const tainted = (ctx: ToolContext): ToolContext => ({ ...ctx, taint: { tainted: true, sources: ['web_fetch'] } });

// ── Web や添付を読んだ後の保存 ──

test('memory_save: ふつうは承認なし。Web や添付を読んだ後は承認制（取り込んだ文が、そのまま記憶に残らないように）', async t => {
  const s = setup(t);
  const plain = await s.call('memory_save', { book: 'user', content: '紅茶が好き' });
  assert.equal(plain.decision, 'allow');
  assert.equal(s.memory.list().length, 1);

  const refused = s.call('memory_save', { book: 'user', content: 'ページに書かれていた指示' }, tainted(s.ctx));
  const request = await decideNext(s, 'deny');
  assert.equal(request.tool, 'memory_save');
  assert.match(request.reasons.join(), /Web や添付/u);
  assert.match(request.title, /記憶/u, '何を記憶しようとしているかが札に出る');
  assert.equal(request.body, 'ページに書かれていた指示');
  assert.equal((await refused).output.isError, true);
  assert.equal(s.memory.list().length, 1, '断れば保存しない');

  const approved = s.call('memory_save', { book: 'user', content: 'ユーザーが確かめた内容' }, tainted(s.ctx));
  await decideNext(s, 'once');
  const outcome = await approved;
  assert.deepEqual([outcome.decision, outcome.decidedBy, outcome.output.isError], ['ask', 'user', undefined]);
  assert.deepEqual(s.memory.list().map(m => m.content), ['紅茶が好き', 'ユーザーが確かめた内容']);
});

test('memory_save: 外から読んだ後でも、読むだけの記憶の道具は確認しない。設定で taintEscalation を切れば確認しない', async t => {
  const s = setup(t);
  const search = await s.call('memory_search', { query: '紅茶' }, tainted(s.ctx));
  assert.equal(search.decision, 'allow');
  const off = setup(t, c => { c.tools.taintEscalation = false; });
  const saved = await off.call('memory_save', { book: 'user', content: '設定で切ってある' }, tainted(off.ctx));
  assert.equal(saved.decision, 'allow');
});

// ── 1 回の実行での件数 ──

test('memory_save: 1 回の実行で記憶できるのは 5 件まで。6 件目は断る（日本語・英語）', async t => {
  const s = setup(t);
  for (let i = 1; i <= 3; i++) assert.equal((await s.call('memory_save', { book: 'notes', content: `教訓 ${i}` })).output.isError, undefined, `${i} 件目`);
  assert.equal((await s.call('memory_update', { id: 'n1', content: '教訓 1（直した）' })).output.isError, undefined);
  assert.equal((await s.call('memory_forget', { id: 'n2', reason: '要らない' })).output.isError, undefined);
  for (let i = 4; i <= 5; i++) assert.equal((await s.call('memory_save', { book: 'notes', content: `教訓 ${i}` })).output.isError, undefined, `書き直し・消す操作は数えないので、${i} 件目も保存できる`);
  assert.equal((await s.call('memory_save', { book: 'notes', content: '教訓 4' })).output.content.includes('既にあります'), true, '重複は件数に数えない（保存されないので）');
  const sixth = await s.call('memory_save', { book: 'notes', content: '教訓 6' });
  assert.equal(sixth.output.isError, true);
  assert.equal(sixth.output.content, 'この実行で記憶できるのは 5 件までです。残りは次の会話で記憶してください');
  assert.equal(s.memory.list().length, 4, '5 件作って、1 件は消した。消した分も作った件数には数える');

  assert.equal((await s.call('memory_save', { book: 'notes', content: '別の実行の教訓' }, { ...s.ctx, runId: 'r2' })).output.isError, undefined, '件数は実行ごと');
  for (let i = 1; i <= 8; i++) s.memory.save({ book: 'user', content: `画面から ${i}`, actor: 'user' });
  assert.equal(s.memory.list('user').length, 8, '利用者が画面から足すのは数えない');

  const en = setup(t, c => { c.language = 'en'; });
  for (let i = 1; i <= 5; i++) await en.call('memory_save', { book: 'notes', content: `Lesson ${i}` });
  const over = await en.call('memory_save', { book: 'notes', content: 'Lesson 6' });
  assert.equal(over.output.content, 'At most 5 memories can be saved in a single run. Save the rest in a later conversation');
});

test('MemoryStore.save: 実行（runId）ごとに、モデルが作れる記憶は 5 件まで。利用者（actor が user）は数えない', t => {
  const db = openDatabase(':memory:', MIGRATIONS);
  const memory = new MemoryStore(db);
  for (let i = 1; i <= 5; i++) memory.save({ book: 'user', content: `事実 ${i}`, actor: 'clive', runId: 'run-a' });
  assert.throws(() => memory.save({ book: 'user', content: '事実 6', actor: 'clive', runId: 'run-a' }), (e: unknown) => e instanceof MemoryError && e.code === 'memory.run_limit' && e.params.max === 5);
  assert.throws(() => memory.save({ book: 'user', content: '事実 7', actor: 'review', runId: 'run-a' }), (e: unknown) => e instanceof MemoryError && e.code === 'memory.run_limit', '振り返りの実行も同じ');
  assert.doesNotThrow(() => memory.save({ book: 'user', content: '事実 6', actor: 'clive', runId: 'run-b' }));
  assert.doesNotThrow(() => memory.save({ book: 'user', content: '事実 7', actor: 'user', runId: 'run-a' }), '利用者の操作は数えない');
  assert.doesNotThrow(() => memory.save({ book: 'user', content: '実行の無い保存', actor: 'clive' }));
});
