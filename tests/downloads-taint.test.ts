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
import { docRead } from '../src/tools/builtin/docs.ts';
import { fileList, fileRead } from '../src/tools/builtin/files.ts';
import { fileSearch } from '../src/tools/builtin/file-search.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// tests/file-search.test.ts の setup を写したもの。registry は fileRead・fileList・fileSearch・docRead
function setup(t: { after: (fn: () => void) => void }, mutate: (c: AppConfig) => void = () => undefined) {
  const paths: AppPaths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(join(paths.data, 'reference'), { recursive: true });
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }, { path: 'reference', mode: 'read' }];
  mutate(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const events: RunEvent[] = [];
  const approvals = new ApprovalBroker(db, e => events.push(e.type === 'requested'
    ? { type: 'approval.requested', runId: e.view.runId, conversationId: e.view.conversationId, approval: approvalPublic(e.view) }
    : { type: 'approval.resolved', runId: e.view.runId, conversationId: e.view.conversationId, approvalId: e.view.id, outcome: e.outcome }));
  const registry = new ToolRegistry().register(fileRead).register(fileList).register(fileSearch).register(docRead);
  const policy = buildPolicy(parsed, paths);
  const controller = new AbortController();
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: controller.signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const call = (name: string, args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, { registry, approvals, db, emit: e => events.push(e), conversationAutoRead: () => false });
  return { paths, ctx, call };
}

function put(s: ReturnType<typeof setup>, name: string, data: Buffer | string): void {
  const file = join(s.paths.workspace, name);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, data);
}

// tests/doc-read.test.ts の tinyPdf を写したもの（その試験を import すると、あちらの試験も動いてしまうため）
function tinyPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 10 100 Td (${text}) Tj ET`;
  return Buffer.from([
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> endobj',
    `4 0 obj << /Length ${content.length} >> stream`, content, 'endstream endobj',
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    'trailer << /Root 1 0 R >>', '%%EOF', '',
  ].join('\n'), 'latin1');
}

test('downloads-taint: file_read が downloads/ の下を読んだら「外から読んだ」印を付ける', async t => {
  const s = setup(t);
  put(s, 'downloads/a.txt', 'downloaded text');
  const out = await s.call('file_read', { path: 'downloads/a.txt' });
  assert.equal(out.decision, 'allow');
  assert.ok(!out.output.isError);
  assert.equal(s.ctx.taint.tainted, true, 'downloads/ の下を読んだ実行は印を持つ');
  assert.deepEqual(s.ctx.taint.sources, ['file_read']);
});

test('downloads-taint: file_read が downloads/ の外を読んだら印を付けない', async t => {
  const s = setup(t);
  put(s, 'notes/a.txt', 'plain text');
  const out = await s.call('file_read', { path: 'notes/a.txt' });
  assert.equal(out.decision, 'allow');
  assert.ok(!out.output.isError);
  assert.equal(s.ctx.taint.tainted, false, 'downloads/ の外は印を付けない');
  assert.deepEqual(s.ctx.taint.sources, []);
});

test('downloads-taint: file_read が断られた読み取り（外・秘密）は印を付けない', async t => {
  const s = setup(t);
  put(s, 'secrets/a.txt', 'secret text');
  writeFileSync(join(s.paths.data, 'outside.txt'), 'Outside text');
  const outside = await s.call('file_read', { path: '../outside.txt' });
  assert.equal(outside.decision, 'deny');
  assert.equal(s.ctx.taint.tainted, false, '外への ../ は印を付けない');
  const secret = await s.call('file_read', { path: 'secrets/a.txt' });
  assert.equal(secret.decision, 'deny');
  assert.equal(s.ctx.taint.tainted, false, '秘密の場所は印を付けない');
  assert.deepEqual(s.ctx.taint.sources, []);
});

test('downloads-taint: file_search が downloads/ の下の行を返したら印を付ける', async t => {
  const s = setup(t);
  put(s, 'downloads/a.txt', 'downloaded text');
  const out = await s.call('file_search', { text: 'downloaded' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /downloads\/a\.txt:1: downloaded text/u);
  assert.equal(s.ctx.taint.tainted, true, 'downloads/ の下の行を返した検索は印を持つ');
  assert.deepEqual(s.ctx.taint.sources, ['file_search']);
});

test('downloads-taint: file_search が downloads/ の外だけに合えば印を付けない', async t => {
  const s = setup(t);
  put(s, 'notes/a.txt', 'plain text');
  const out = await s.call('file_search', { text: 'plain' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /notes\/a\.txt:1: plain text/u);
  assert.equal(s.ctx.taint.tainted, false, 'downloads/ の外だけに合えば印を付けない');
  assert.deepEqual(s.ctx.taint.sources, []);
});

test('downloads-taint: file_search の名前だけの検索でも、downloads/ の下の名前を返したら印を付ける（名前は相手が決める）', async t => {
  const s = setup(t);
  put(s, 'downloads/a.txt', 'downloaded text');
  const out = await s.call('file_search', { name: 'a.txt' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /downloads\/a\.txt/u);
  assert.equal(s.ctx.taint.tainted, true, 'downloads/ の下の名前を返した検索は印を持つ');
  assert.deepEqual(s.ctx.taint.sources, ['file_search']);
});

test('downloads-taint: file_search の名前だけの検索が downloads/ の外だけに合えば印を付けない', async t => {
  const s = setup(t);
  put(s, 'downloads/b.txt', 'downloaded text');
  put(s, 'notes/a.txt', 'plain text');
  const out = await s.call('file_search', { name: 'a.txt' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /notes\/a\.txt/u);
  assert.doesNotMatch(out.output.content, /downloads/u);
  assert.equal(s.ctx.taint.tainted, false, 'downloads/ の外だけに合えば印を付けない');
  assert.deepEqual(s.ctx.taint.sources, []);
});

test('downloads-taint: file_search の名前だけの検索が downloads/ の中と外の両方に合えば印を付ける', async t => {
  const s = setup(t);
  put(s, 'downloads/b.txt', 'downloaded text');
  put(s, 'notes/a.txt', 'plain text');
  const out = await s.call('file_search', { name: '*.txt' });
  assert.match(out.output.content, /notes\/a\.txt/u);
  assert.match(out.output.content, /downloads\/b\.txt/u);
  assert.equal(s.ctx.taint.tainted, true);
  assert.deepEqual(s.ctx.taint.sources, ['file_search']);
});

test('downloads-taint: file_list が downloads/ の中を一覧したら印を付ける', async t => {
  const s = setup(t);
  put(s, 'downloads/a.txt', 'downloaded text');
  const out = await s.call('file_list', { path: 'downloads' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /a\.txt/u);
  assert.equal(s.ctx.taint.tainted, true, 'downloads/ の下の名前を返した一覧は印を持つ');
  assert.deepEqual(s.ctx.taint.sources, ['file_list']);
});

test('downloads-taint: file_list は、作業フォルダの 1 階層だけ（downloads/ という固定の名前だけ）なら印を付けず、downloads/ の中まで入ったら付ける', async t => {
  const s = setup(t);
  put(s, 'downloads/a.txt', 'downloaded text');
  put(s, 'notes/b.txt', 'plain text');
  const shallow = await s.call('file_list', {});
  assert.match(shallow.output.content, /downloads\//u);
  assert.doesNotMatch(shallow.output.content, /a\.txt/u);
  assert.equal(s.ctx.taint.tainted, false, 'downloads/ という固定の名前だけなら印を付けない');
  const deep = await s.call('file_list', { depth: 2 });
  assert.match(deep.output.content, /a\.txt/u);
  assert.equal(s.ctx.taint.tainted, true, '下の階層で downloads/ の中の名前を返したら印を付ける');
  assert.deepEqual(s.ctx.taint.sources, ['file_list']);
});

test('downloads-taint: file_list が downloads/ の外や空の downloads/ を一覧しても印を付けない', async t => {
  const s = setup(t);
  put(s, 'notes/b.txt', 'plain text');
  mkdirSync(join(s.paths.workspace, 'downloads'), { recursive: true });
  const outside = await s.call('file_list', { path: 'notes' });
  assert.match(outside.output.content, /b\.txt/u);
  const empty = await s.call('file_list', { path: 'downloads' });
  assert.equal(empty.decision, 'allow');
  assert.ok(!empty.output.isError);
  assert.equal(s.ctx.taint.tainted, false, '名前を何も返していないので印を付けない');
  assert.deepEqual(s.ctx.taint.sources, []);
});

test('downloads-taint: doc_read が downloads/ の下を読んだら印を付ける（Q14 の確認）', async t => {
  const s = setup(t);
  put(s, 'downloads/a.pdf', tinyPdf('Hello PDF'));
  const out = await s.call('doc_read', { path: 'downloads/a.pdf' });
  assert.equal(out.decision, 'allow');
  assert.ok(!out.output.isError);
  assert.equal(s.ctx.taint.tainted, true, 'doc_read は downloads/ の下でも必ず印を付ける');
  assert.deepEqual(s.ctx.taint.sources, ['doc_read']);
});
