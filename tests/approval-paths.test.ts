import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { ApprovalBroker, approvalPaths, approvalPublic, approvalWire, type ApprovalPath } from '../src/tools/approvals.ts';
import { fileEdit, fileList, fileRead, fileWrite } from '../src/tools/builtin/files.ts';
import { shellPreCheck, shellRun } from '../src/tools/builtin/shell.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(join(paths.data, 'reference'), { recursive: true });
  writeFileSync(join(paths.data, 'reference', 'doc.md'), '参照用の文書');
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }, { path: 'reference', mode: 'read' }];
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const events: RunEvent[] = [];
  const approvals = new ApprovalBroker(db, e => events.push(e.type === 'requested'
    ? { type: 'approval.requested', runId: e.view.runId, conversationId: e.view.conversationId, approval: approvalPublic(e.view) }
    : { type: 'approval.resolved', runId: e.view.runId, conversationId: e.view.conversationId, approvalId: e.view.id, outcome: e.outcome }));
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(fileList).register(shellRun);
  const policy = buildPolicy(parsed, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const call = (name: string, args: unknown) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, ctx, { registry, approvals, db, emit: e => events.push(e) });
  // 承認の札が出るまで待ち、拒否して、札の中身を返す
  const asked = async (name: string, args: unknown) => {
    const pending = call(name, args);
    for (let i = 0; i < 300 && !approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
    const view = approvals.pending()[0];
    assert.ok(view, '承認の依頼が来ていない');
    approvals.decide(view.id, 'deny');
    await pending;
    return { view, wire: approvalWire(view), events };
  };
  return { paths, ctx, call, approvals, events, asked };
}

test('シェル: 見つけたパスごとに、許可フォルダの中（読み書き）・中（読むだけ）・外を返す。details の文は今までと同じ', async t => {
  const s = await setup(t);
  const outside = resolve(s.ctx.workspace, '../out.txt');
  const doc = join(s.paths.data, 'reference', 'doc.md');
  const { view } = await s.asked('shell_run', { command: `cat a.txt; cat ${doc}; cat ../out.txt` });
  assert.deepEqual(view.paths, [
    { input: 'a.txt', path: join(s.ctx.workspace, 'a.txt'), verdict: 'in', mode: 'write' },
    { input: doc, path: doc, verdict: 'in', mode: 'read' },
    { input: '../out.txt', path: outside, verdict: 'out' },
  ]);
  assert.equal(view.details.length, 3, '文の details も残す');
  assert.match(view.details[2]!, /許可フォルダの外/u);
});

test('シェル: cd で動いた先からの相対パスは、動いた先で判定する', async t => {
  const s = await setup(t);
  const parent = resolve(s.ctx.workspace, '..');
  const { view } = await s.asked('shell_run', { command: 'cd ..; cat x.txt' });
  assert.deepEqual((view.paths ?? []).filter(p => p.input === 'x.txt'), [{ input: 'x.txt', path: join(parent, 'x.txt'), verdict: 'out' }]);
});

test('シェル: 値の分からない変数のパスは「判定できない」で、path を持たない', async t => {
  const s = await setup(t);
  const { view } = await s.asked('shell_run', { command: 'cat $someUnknownVar' });
  assert.deepEqual(view.paths, [{ input: '$someUnknownVar', verdict: 'unknown' }]);
});

test('シェル: 同じパスを何度か見つけても 1 行にまとめ、数が多すぎる分は切る', () => {
  const inside = { kind: 'inside', mode: 'write', root: '/w' } as const;
  const same = approvalPaths([
    { input: 'a', path: '/w/a', placement: inside }, { input: 'a', path: '/w/a', placement: inside }, { input: './a', path: '/w/a', placement: inside },
    { input: 'a', path: '/w/a', placement: { kind: 'outside' } },
  ]);
  assert.deepEqual(same, [
    { input: 'a', path: '/w/a', verdict: 'in', mode: 'write' }, { input: './a', path: '/w/a', verdict: 'in', mode: 'write' },
    { input: 'a', path: '/w/a', verdict: 'out' },
  ], '同じ判定の同じパスは 1 つ。入力の書き方が違うものと判定が違うものは別');
  const many = approvalPaths(Array.from({ length: 80 }, (_, i) => ({ input: `f${i}`, path: `/w/f${i}`, placement: inside })));
  assert.equal(many.length, 30);
  assert.equal(many[29]!.input, 'f29');
});

test('すべての判定の種類: 中（読み書き・読むだけ）・外・拒否・判定できない', () => {
  const cases: Array<[Parameters<typeof approvalPaths>[0][number]['placement'], ApprovalPath]> = [
    [{ kind: 'inside', mode: 'write', root: '/w' }, { input: 'p', path: '/p', verdict: 'in', mode: 'write' }],
    [{ kind: 'inside', mode: 'read', root: '/r' }, { input: 'p', path: '/p', verdict: 'in', mode: 'read' }],
    [{ kind: 'outside' }, { input: 'p', path: '/p', verdict: 'out' }],
    [{ kind: 'deny', reason: '秘密のファイル' }, { input: 'p', path: '/p', verdict: 'deny' }],
  ];
  for (const [placement, expected] of cases) assert.deepEqual(approvalPaths([{ input: 'p', path: '/p', placement }]), [expected]);
  assert.deepEqual(approvalPaths([{ input: 'p', placement: { kind: 'unresolved', reason: '変数' } }]), [{ input: 'p', verdict: 'unknown' }]);
  assert.deepEqual(approvalPaths([{ input: 'p', path: '/まだ分からない', placement: { kind: 'unresolved', reason: '変数' } }]), [{ input: 'p', verdict: 'unknown' }], '判定できないものは path を持たない');
  assert.deepEqual(approvalPaths([]), []);
});

test('ファイルの道具: 確かめになる書き込み（人格・スキル・.git）は、その 1 つのパスを中（読み書き）として返す', async t => {
  const s = await setup(t);
  const { view } = await s.asked('file_write', { path: 'SOUL.md', content: 'x' });
  assert.deepEqual(view.paths, [{ input: 'SOUL.md', path: join(s.ctx.workspace, 'SOUL.md'), verdict: 'in', mode: 'write' }]);
  const git = await s.asked('file_write', { path: 'proj/.git/hooks/pre-commit', content: 'x' });
  assert.deepEqual((git.view.paths ?? []).map(p => [p.input, p.verdict, p.mode]), [['proj/.git/hooks/pre-commit', 'in', 'write']]);
});

test('シェル: 今回だけの確かめ（コードを動かす確かめ）にも、見つけたパスの判定を添える', async t => {
  const s = await setup(t);
  const { view } = await s.asked('shell_run', { command: 'echo hi > ../o.txt' });
  assert.equal(view.onceOnly, true);
  assert.deepEqual((view.paths ?? []).map(p => [p.input, p.verdict]), [['../o.txt', 'out']]);
});

test('パスを持たない承認（外から読んだあとの確かめなど）は paths が空', async t => {
  const s = await setup(t);
  s.ctx.taint.tainted = true;
  s.ctx.taint.sources.push('web_fetch');
  const { view, wire } = await s.asked('file_write', { path: 'b.md', content: 'x' });
  assert.equal(view.paths?.length, 1, '書き込み先のパスは出す');
  const bare = approvalPublic({ ...view, paths: undefined });
  assert.deepEqual(bare.paths, [], 'パスが無ければ空の配列（画面は details の文に戻る）');
  assert.deepEqual(wire.paths, view.paths);
});

test('承認の形は 1 か所: SSE の知らせと API の応答は、同じ paths を同じ形で持つ', async t => {
  const s = await setup(t);
  const { view, events } = await s.asked('shell_run', { command: 'cat ../out.txt' });
  const sse = events.find(e => e.type === 'approval.requested') as Extract<RunEvent, { type: 'approval.requested' }>;
  assert.deepEqual(sse.approval.paths, approvalPublic(view).paths);
  assert.deepEqual(sse.approval, approvalPublic(view));
  assert.deepEqual(Object.keys(approvalWire(view)).sort(), ['runId', 'conversationId', ...Object.keys(approvalPublic(view))].sort());
  assert.ok(Object.keys(approvalPublic(view)).includes('paths'));
});

// A8 の前に本物のガードで取った判定の表。パスを返す側を足しても、allow / ask / deny と「今回だけ」は 1 つも変わらない（この表は赤くならない見張り）
test('A8 は判定を変えない: 事前判定の allow / ask / deny と今回だけは、パスを返す前に取った表のまま', async t => {
  const s = await setup(t);
  const table: Array<[string, 'allow' | 'ask' | 'deny', boolean]> = [
    ['cat a.txt', 'allow', false], ['cat ../out.txt', 'ask', false], ['cd ..; cat x.txt', 'ask', false], ['cat $someUnknownVar', 'ask', false],
    ['cat .env', 'deny', false], ['mkfs', 'deny', false], ['npm install left-pad', 'ask', true], ['cat a.txt; cat ../out.txt', 'ask', false],
    ['cat *.txt', 'allow', false], ['ls', 'allow', false], ['echo hi > ../o.txt', 'ask', true],
  ];
  for (const [command, decision, onceOnly] of table) {
    const pre = shellPreCheck({ command }, s.ctx);
    assert.deepEqual([pre.decision, pre.onceOnly === true], [decision, onceOnly], command);
  }
});
