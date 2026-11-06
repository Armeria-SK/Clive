import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { ApprovalBroker, approvalPublic } from '../src/tools/approvals.ts';
import { calculate, dateCalc } from '../src/tools/builtin/calc.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// tests/tools.test.ts の setup を写し、registry に calculate と dateCalc だけを登録する
function setup(t: { after: (fn: () => void) => void }, mutate: (c: AppConfig) => void = () => undefined) {
  const paths: AppPaths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(join(paths.data, 'reference'), { recursive: true });
  writeFileSync(join(paths.data, 'reference', 'doc.md'), '参照用の文書');
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }, { path: 'reference', mode: 'read' }];
  mutate(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const events: RunEvent[] = [];
  const approvals = new ApprovalBroker(db, e => events.push(e.type === 'requested'
    ? { type: 'approval.requested', runId: e.view.runId, conversationId: e.view.conversationId, approval: approvalPublic(e.view) }
    : { type: 'approval.resolved', runId: e.view.runId, conversationId: e.view.conversationId, approvalId: e.view.id, outcome: e.outcome }));
  const registry = new ToolRegistry().register(calculate).register(dateCalc);
  const policy = buildPolicy(parsed, paths);
  const controller = new AbortController();
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: controller.signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const call = (name: string, args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, { registry, approvals, db, emit: e => events.push(e), conversationAutoRead: () => false });
  return { paths, ctx, call, approvals, events, db, controller };
}

const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;

test('calculate: 式を計算して結果を返す', async t => {
  const s = setup(t);
  const out = await s.call('calculate', { expression: '1+2*3' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /= 7/u);
});

test('calculate: 0 で割ると失敗', async t => {
  const s = setup(t);
  const out = await s.call('calculate', { expression: '1/0' });
  assert.equal(out.output.isError, true);
});

test('calculate: 空の式は引数の誤りとして実行しない', async t => {
  const s = setup(t);
  const out = await s.call('calculate', { expression: '' });
  assert.equal(out.invalidArguments, true);
});

test('calculate: 位置の分からないエラーでは「?」を出す', async t => {
  const s = setup(t);
  const out = await s.call('calculate', { expression: '2 +' });
  assert.equal(out.output.isError, true);
  assert.doesNotMatch(out.output.content, /（ 文字目/u);
  assert.match(out.output.content, /\?/u);
});

test('date_calc: 月末に月を足すとその月の末日になる', async t => {
  const s = setup(t);
  const out = await s.call('date_calc', { op: 'add', date: '2026-01-31', months: 1 });
  assert.match(out.output.content, /2026-02-28/u);
});

test('date_calc: 曜日を見る', async t => {
  const s = setup(t);
  const out = await s.call('date_calc', { op: 'weekday', date: '2026-11-06' });
  assert.match(out.output.content, /金曜日/u);
});

test('date_calc: タイムゾーンを変換する', async t => {
  const s = setup(t);
  const out = await s.call('date_calc', { op: 'convert', datetime: '2026-07-01T09:00', timezone: 'Asia/Tokyo', to_timezone: 'America/New_York' });
  assert.match(out.output.content, /2026-06-30T20:00/u);
});

test('date_calc: convert でソースのタイムゾーンが読めなければ timezone を指す', async t => {
  const s = setup(t);
  const out = await s.call('date_calc', { op: 'convert', datetime: '2026-07-01T09:00', timezone: 'Mars/Base', to_timezone: 'America/New_York' });
  assert.equal(out.output.isError, true);
  assert.doesNotMatch(out.output.content, /to_timezone/u);
  assert.match(out.output.content, /timezone/u);
});

test('date_calc: diff で date が正しく to が読めなければ to を指す', async t => {
  const s = setup(t);
  const out = await s.call('date_calc', { op: 'diff', date: '2026-01-01', to: 'not-a-date' });
  assert.equal(out.output.isError, true);
  assert.match(out.output.content, /: to$/u);
});

test('date_calc: add に date が無いと失敗', async t => {
  const s = setup(t);
  const out = await s.call('date_calc', { op: 'add' });
  assert.equal(out.output.isError, true);
});

test('date_calc: 英語の設定では出力に日本語が混ざらない', async t => {
  const s = setup(t, c => { c.language = 'en'; });
  for (const out of [
    await s.call('calculate', { expression: '1+2*3' }),
    await s.call('date_calc', { op: 'add', date: '2026-01-31', months: 1 }),
    await s.call('date_calc', { op: 'weekday', date: '2026-11-06' }),
    await s.call('date_calc', { op: 'convert', datetime: '2026-07-01T09:00', timezone: 'Asia/Tokyo', to_timezone: 'America/New_York' }),
  ]) {
    assert.doesNotMatch(out.output.content, CJK);
  }
});
