import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { ApprovalBroker, approvalPublic } from '../src/tools/approvals.ts';
import { fileEdit, fileList, fileRead, fileWrite } from '../src/tools/builtin/files.ts';
import { fileSearch } from '../src/tools/builtin/file-search.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// tests/tools.test.ts の setup を写したもの。registry に fileSearch を足す
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
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(fileList).register(shellRun).register(fileSearch);
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

// 秘密・大きなフォルダ・バイナリを混ぜた作業フォルダを作る
function makeFixtures(s: ReturnType<typeof setup>): void {
  const ws = s.paths.workspace;
  mkdirSync(join(ws, 'notes'), { recursive: true });
  mkdirSync(join(ws, 'secrets'), { recursive: true });
  mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(ws, 'notes', 'a.md'), 'りんご');
  writeFileSync(join(ws, 'notes', 'b.txt'), 'バナナ\nりんごジュース');
  writeFileSync(join(ws, '.env'), 'りんご=1');
  writeFileSync(join(ws, 'secrets', 'key.txt'), 'りんご');
  writeFileSync(join(ws, 'node_modules', 'pkg', 'readme.md'), 'りんご');
  writeFileSync(join(ws, 'bin.dat'), Buffer.concat([Buffer.from([0]), Buffer.from('りんご')]));
}

test('ファイル検索: 名前のワイルドカードで探す。大きなフォルダの中は探さない', async t => {
  const s = setup(t);
  makeFixtures(s);
  const out = await s.call('file_search', { name: '*.md' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /notes\/a\.md/u);
  assert.doesNotMatch(out.output.content, /node_modules\/pkg\/readme\.md/u);
  assert.match(out.output.content, /node_modules/u); // search.heavy の印
});

test('ファイル検索: 中身の文字で探す。秘密・大きなフォルダ・バイナリは出さない', async t => {
  const s = setup(t);
  makeFixtures(s);
  const out = await s.call('file_search', { text: 'りんご' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /notes\/a\.md:1: りんご/u);
  assert.match(out.output.content, /notes\/b\.txt:2: りんごジュース/u);
  assert.doesNotMatch(out.output.content, /secrets\/key\.txt/u);
  assert.doesNotMatch(out.output.content, /bin\.dat/u);
  assert.doesNotMatch(out.output.content, /node_modules\/pkg\/readme\.md/u);
  assert.doesNotMatch(out.output.content, /\.env/u);
});

test('ファイル検索: path に大きなフォルダを指定すると中を探す', async t => {
  const s = setup(t);
  makeFixtures(s);
  const out = await s.call('file_search', { path: 'node_modules', text: 'りんご' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /node_modules\/pkg\/readme\.md:1: りんご/u);
});

test('ファイル検索: 名前と中身の両方に合うものだけ返す', async t => {
  const s = setup(t);
  makeFixtures(s);
  const out = await s.call('file_search', { name: '*.md', text: 'バナナ' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /見つかりませんでした/u);
});

test('ファイル検索: 名前も中身も無ければ直させる', async t => {
  const s = setup(t);
  makeFixtures(s);
  const out = await s.call('file_search', {});
  assert.equal(out.output.isError, true);
  assert.match(out.output.content, /少なくとも 1 つ/u);
});

test('ファイル検索: 作業フォルダの外は拒否する', async t => {
  const s = setup(t);
  makeFixtures(s);
  const out = await s.call('file_search', { path: '../', name: '*.md' });
  assert.equal(out.decision, 'deny');
});

test('ファイル検索: 結果が max_results に達したら打ち切る', async t => {
  const s = setup(t);
  makeFixtures(s);
  const ws = s.paths.workspace;
  for (let i = 1; i <= 21; i++) writeFileSync(join(ws, `f${String(i).padStart(2, '0')}.txt`), `ファイル ${i}`);
  const out = await s.call('file_search', { name: '*.txt', max_results: 20 });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /20 件で打ち切りました/u);
});

test('ファイル検索: シンボリックリンクの先（外のフォルダ）は探さない', async t => {
  const s = setup(t);
  makeFixtures(s);
  const outside = join(s.paths.data, 'outside-dir');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret-fruit.txt'), 'りんご');
  try { symlinkSync(outside, join(s.paths.workspace, 'link'), 'junction'); } catch { t.skip('シンボリックリンクを作れない環境'); return; }
  const out = await s.call('file_search', { text: 'りんご' });
  assert.equal(out.decision, 'allow');
  assert.doesNotMatch(out.output.content, /secret-fruit/u);
});

test('ファイル検索: 名前ワイルドカードは指数回帰しない（*?*?… は 100ms 以内で false）', async t => {
  const s = setup(t);
  writeFileSync(join(s.paths.workspace, 'a'.repeat(44)), 'x');
  const start = Date.now();
  const out = await s.call('file_search', { name: '*?*?*?*?*?*?*?*?*?*?Z' });
  const ms = Date.now() - start;
  assert.equal(out.decision, 'allow');
  assert.ok(ms < 100, `ワイルドカードの照合が ${ms}ms かかった`);
  assert.match(out.output.content, /見つかりませんでした/u);
});

test('ファイル検索: 名前ワイルドカードは大文字小文字を区別できる', async t => {
  const s = setup(t);
  writeFileSync(join(s.paths.workspace, 'a.MD'), 'x');
  const insensitive = await s.call('file_search', { name: '*.md' });
  assert.match(insensitive.output.content, /a\.MD/u);
  const sensitive = await s.call('file_search', { name: '*.md', case_sensitive: true });
  assert.match(sensitive.output.content, /見つかりませんでした/u);
});

test('ファイル検索: [ ] は正規表現ではなくそのままの文字', async t => {
  const s = setup(t);
  writeFileSync(join(s.paths.workspace, '[z-a].txt'), 'x');
  const out = await s.call('file_search', { name: '[z-a].txt' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /\[z-a\]\.txt/u);
});

test('ファイル検索: 中止済みのシグナルなら素早く止まり、例外を投げない', async t => {
  const s = setup(t);
  for (let i = 1; i <= 300; i++) writeFileSync(join(s.paths.workspace, `f${String(i).padStart(3, '0')}.txt`), 'x');
  s.controller.abort();
  const out = await s.call('file_search', { name: '*.txt' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /見つかりませんでした/u);
});

test('ファイル検索: 上限を超えたら全体で止まる（内側のループだけではない）', async t => {
  const s = setup(t);
  const ws = s.paths.workspace;
  writeFileSync(join(ws, 'a.txt'), 'x');
  mkdirSync(join(ws, 'sub'), { recursive: true });
  writeFileSync(join(ws, 'sub', 'b.txt'), 'x');
  for (let i = 1; i <= 20_000; i++) writeFileSync(join(ws, `z${String(i).padStart(5, '0')}.dat`), 'x');
  const out = await s.call('file_search', { name: '*.txt' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /20001 個まで見て止めました/u);
  assert.doesNotMatch(out.output.content, /20002 個まで/u);
  assert.doesNotMatch(out.output.content, /sub\/b\.txt/u);
});

test('ファイル検索: 名前の検索でも秘密・禁止リストは出さない', async t => {
  const s = setup(t, c => { c.tools.deny = ['workspace/locked']; });
  makeFixtures(s);
  const ws = s.paths.workspace;
  mkdirSync(join(ws, 'locked'), { recursive: true });
  writeFileSync(join(ws, 'locked', 'secret.txt'), 'x');
  const star = await s.call('file_search', { name: '*' });
  assert.equal(star.decision, 'allow');
  assert.doesNotMatch(star.output.content, /\.env/u);
  assert.doesNotMatch(star.output.content, /secrets\/key\.txt/u);
  assert.doesNotMatch(star.output.content, /locked\/secret\.txt/u);
  const env = await s.call('file_search', { name: '*.env' });
  assert.doesNotMatch(env.output.content, /\.env/u);
});
