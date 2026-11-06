import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { ApprovalBroker, approvalPublic } from '../src/tools/approvals.ts';
import { fileEdit, fileList, fileRead, fileWrite } from '../src/tools/builtin/files.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// 段 8（A3）: 道具ごとの方針は、今の判定に「厳しさを足す」ことしかできない。
// allow は何も緩めない / ask は毎回（会話の許可を越えて）承認を求める / block は使わせない

type Policy = 'allow' | 'ask' | 'block';

function stub(name: string, allowedIn: ToolDef['allowedIn'], ran: string[]): ToolDef {
  return { name, description: name, input: Type.Object({}, { additionalProperties: false }), effect: 'meta', allowedIn, async execute() { ran.push(name); return { content: `ran ${name}` }; } };
}

function setup(t: { after: (fn: () => void) => void }, policies: Record<string, Policy> = {}, mutate: (c: AppConfig) => void = () => undefined) {
  const paths: AppPaths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(join(paths.data, 'reference'), { recursive: true });
  writeFileSync(join(paths.data, 'reference', 'doc.md'), '参照用の文書');
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }, { path: 'reference', mode: 'read' }];
  config.tools.policies = policies;
  mutate(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const events: RunEvent[] = [];
  const approvals = new ApprovalBroker(db, e => events.push(e.type === 'requested'
    ? { type: 'approval.requested', runId: e.view.runId, conversationId: e.view.conversationId, approval: approvalPublic(e.view) }
    : { type: 'approval.resolved', runId: e.view.runId, conversationId: e.view.conversationId, approvalId: e.view.id, outcome: e.outcome }));
  const ran: string[] = [];
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(fileList).register(shellRun)
    .register(stub('memory_save', ['chat', 'task', 'review'], ran))
    .register(stub('task_complete', ['task'], ran)).register(stub('task_checkpoint', ['task'], ran)).register(stub('ask_user', ['task'], ran));
  const policy = buildPolicy(parsed, paths);
  const controller = new AbortController();
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: controller.signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const call = (name: string, args: unknown, c: ToolContext = ctx, live?: () => AppConfig) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, { registry, approvals, db, emit: e => events.push(e), ...(live ? { config: live } : {}) });
  return { paths, ctx, call, approvals, events, db, ran, parsed, controller };
}

async function waitPending(s: ReturnType<typeof setup>) {
  for (let i = 0; i < 300 && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
  const pending = s.approvals.pending()[0];
  assert.ok(pending, '承認の依頼が来ていない');
  return pending;
}

const withPolicy = (s: ReturnType<typeof setup>, policies: Record<string, Policy>): AppConfig => ({ ...s.parsed, tools: { ...s.parsed.tools, policies } });

test('A3: 設定の既定は空（書かなければ全部 allow）。知らない値・道具の名前でない鍵は設定を読む段階で断る', () => {
  assert.deepEqual(parseConfig(testConfig()).tools.policies, {});
  assert.deepEqual(parseConfig({ ...testConfig(), tools: { ...testConfig().tools, policies: { shell_run: 'ask', file_write: 'block' } } }).tools.policies, { shell_run: 'ask', file_write: 'block' });
  const bad = (policies: unknown) => parseConfig({ ...testConfig(), tools: { ...testConfig().tools, policies } } as never);
  assert.throws(() => bad({ shell_run: 'never' }), /policies/u);
  assert.throws(() => bad({ 'Not A Tool': 'ask' }), /policies/u);
  assert.throws(() => bad({ shell_run: 'ask', ['x'.repeat(65)]: 'ask' }), /policies/u);
});

// 判定の結果を並べた表。allow（既定でも明示でも）で、方針なしと一字も変わらないことを確かめる
async function decisions(s: ReturnType<typeof setup>): Promise<Array<[string, string]>> {
  writeFileSync(join(s.paths.workspace, '.env'), 'SECRET=xyz');
  const rows: Array<[string, string]> = [];
  const note = async (label: string, name: string, args: unknown, c: ToolContext = s.ctx) => {
    const outcome = await s.call(name, args, c);
    rows.push([label, `${outcome.decision}/${outcome.decidedBy}/${outcome.output.isError ? 'error' : 'ok'}`]);
  };
  await note('禁止のファイルに書く', 'file_write', { path: '.env', content: 'x' });
  await note('許可フォルダの外に書く', 'file_write', { path: '../outside.txt', content: 'x' });
  await note('読むだけのフォルダに書く', 'file_write', { path: join(s.paths.data, 'reference', 'doc.md'), content: 'x' });
  await note('設定を読む', 'file_read', { path: s.paths.config });
  await note('秘密を読む（シェル）', 'shell_run', { command: 'cat .env' });
  await note('強い禁止のコマンド', 'shell_run', { command: 'sudo rm -rf /' });
  await note('ふつうに読む', 'file_read', { path: join(s.paths.data, 'reference', 'doc.md') });
  await note('振り返りでは書けない', 'file_write', { path: 'a.md', content: 'x' }, { ...s.ctx, kind: 'review' });
  // 外から読んだ内容のあとの書き込みは、方針が allow でも確かめる
  const tainted = { ...s.ctx, taint: { tainted: true, sources: ['web_fetch'] } };
  const asking = s.call('file_write', { path: 'tainted.md', content: 'x' }, tainted);
  const request = await waitPending(s);
  rows.push(['外を読んだあと', `ask/${request.reasons.length}`]);
  s.approvals.decide(request.id, 'deny');
  await asking;
  assert.equal(existsSync(join(s.paths.workspace, 'tainted.md')), false);
  return rows;
}

test('A3: allow（既定でも、明示しても）は判定を緩めない: 拒否・秘密・読むだけ・振り返りの禁止・外を読んだあとの確かめは、方針なしと同じ', async t => {
  const plain = await decisions(setup(t));
  const explicit = await decisions(setup(t, { file_write: 'allow', file_read: 'allow', file_edit: 'allow', file_list: 'allow', shell_run: 'allow' }));
  assert.deepEqual(explicit, plain);
  assert.deepEqual(plain.filter(([, d]) => d.startsWith('deny')).map(([label]) => label), ['禁止のファイルに書く', '許可フォルダの外に書く', '読むだけのフォルダに書く', '設定を読む', '秘密を読む（シェル）', '強い禁止のコマンド', '振り返りでは書けない'], 'この表の拒否が、方針なしでも拒否のまま（比べる基準が壊れていない）');
});

test('A3: ask は、ふだん確かめなしの呼び出しにも毎回承認を求める。札は「この会話では許可」を出さず、送られても今回だけ。同じ入力でも次はまた聞く', async t => {
  const s = setup(t, { file_write: 'ask' });
  const first = s.call('file_write', { path: 'a.md', content: '1' });
  const request = await waitPending(s);
  assert.equal(request.everyTime, true, '札に「毎回」の印（画面は「この会話では許可」を出さない）');
  assert.equal(approvalPublic(request).everyTime, true);
  assert.equal(approvalPublic(request).onceOnly, false, 'コードを動かす確かめ（onceOnly）とは別');
  assert.match(request.reasons.join(), /file_write/u);
  assert.match(request.reasons.join(), /承認を求める/u);
  assert.equal(existsSync(join(s.paths.workspace, 'a.md')), false, '承認の前は動かない');
  assert.equal(s.approvals.decide(request.id, 'conversation'), true, '古い画面から「この会話では許可」が送られても');
  const done = await first;
  assert.equal(done.decision, 'ask');
  assert.equal(done.decidedBy, 'user');
  assert.equal(existsSync(join(s.paths.workspace, 'a.md')), true);
  assert.deepEqual((s.db.prepare('SELECT scope FROM approvals').all() as Array<{ scope: string }>).map(r => r.scope), ['once'], '会話の許可として覚えない');

  const second = s.call('file_write', { path: 'a.md', content: '1' });
  const again = await waitPending(s);
  assert.notEqual(again.id, request.id, '同じ入力でも、また承認を求める');
  s.approvals.decide(again.id, 'deny');
  const denied = await second;
  assert.equal(denied.output.isError, true);
  assert.match(denied.output.content, /拒否/u);
});

test('A3: ask は会話の許可（ほかの理由で前に「この会話では許可」にした同じ入力）も越える', async t => {
  const s = setup(t, {}, c => { c.tools.shell.ask = ['echo needs-approval']; });
  const first = s.call('shell_run', { command: 'echo needs-approval' });
  s.approvals.decide((await waitPending(s)).id, 'conversation');
  await first;
  assert.equal((await s.call('shell_run', { command: 'echo needs-approval' })).decidedBy, 'conversation-grant', '方針が無ければ、会話の許可で済む（比べる基準）');

  // その会話の許可が残っているまま、持ち主が shell_run を「承認を求める」にした（実行の途中の変更でも、次の実行でも）
  const strict = withPolicy(s, { shell_run: 'ask' });
  const next = s.call('shell_run', { command: 'echo needs-approval' }, { ...s.ctx, config: strict });
  const request = await waitPending(s);
  assert.equal(request.everyTime, true);
  assert.deepEqual([...(request.kinds ?? [])].sort(), ['policy', 'precheck'], '許可を覚えた理由（持ち主の確かめ）と方針の理由が重なっている');
  s.approvals.decide(request.id, 'deny');
  assert.equal((await next).decidedBy, 'user', '会話の許可（conversation-grant）では通らず、承認を求めた');
});

test('A3: ask は拒否を承認に変えない（拒否は承認を求める前に拒否のまま。承認の依頼も出さない）', async t => {
  const s = setup(t, { file_write: 'ask', shell_run: 'ask', file_read: 'ask' });
  writeFileSync(join(s.paths.workspace, '.env'), 'SECRET=xyz');
  for (const [name, args] of [['file_write', { path: '.env', content: 'x' }], ['file_read', { path: s.paths.config }], ['shell_run', { command: 'cat .env' }], ['shell_run', { command: 'sudo rm -rf /' }]] as Array<[string, unknown]>) {
    const outcome = await s.call(name, args);
    assert.equal(outcome.decision, 'deny', JSON.stringify(args));
    assert.equal(s.approvals.pending().length, 0, `${JSON.stringify(args)}: 承認の依頼を出さない`);
  }
});

test('A3: block は実行せず拒否する。承認の依頼も出さず、道具の記録には「決めたのは policy」で残る。引数が不正でも、会話の許可・フックの allow があっても越えられない', async t => {
  const dir = tempDir(t);
  const allow = join(dir, 'allow.mjs');
  writeFileSync(allow, `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('{"decision":"allow"}')})`);
  const s = setup(t, { file_write: 'block', shell_run: 'block' }, c => {
    c.tools.hooks.preToolUse = [{ matcher: 'file_.*', command: [process.execPath, allow], timeoutMs: 10_000, onError: 'deny' }];
    c.tools.shell.ask = ['echo needs-approval'];
  });
  const blocked = await s.call('file_write', { path: 'a.md', content: 'x' });
  assert.equal(blocked.decision, 'deny');
  assert.equal(blocked.decidedBy, 'policy');
  assert.match(blocked.output.content, /file_write/u);
  assert.equal(existsSync(join(s.paths.workspace, 'a.md')), false);
  assert.equal(s.approvals.pending().length, 0);
  assert.equal((await s.call('file_write', { path: 'a.md' })).decidedBy, 'policy', '引数が不正でも、ほかの理由より先に止まる');
  assert.deepEqual(s.db.prepare("SELECT tool, decision, decided_by FROM tool_calls WHERE tool = 'file_write' ORDER BY created_at").all().map(r => ({ ...r })), [
    { tool: 'file_write', decision: 'deny', decided_by: 'policy' }, { tool: 'file_write', decision: 'deny', decided_by: 'policy' },
  ]);
  assert.equal((await s.call('file_read', { path: join(s.paths.data, 'reference', 'doc.md') })).decision, 'allow', '方針が無い道具は今までどおり');

  // 前に「この会話では許可」にした入力も、止めたあとは通らない
  const grant = setup(t, {}, c => { c.tools.shell.ask = ['echo needs-approval']; });
  const first = grant.call('shell_run', { command: 'echo needs-approval' });
  grant.approvals.decide((await waitPending(grant)).id, 'conversation');
  await first;
  const later = withPolicy(grant, { shell_run: 'block' });
  const outcome = await grant.call('shell_run', { command: 'echo needs-approval' }, { ...grant.ctx, config: later });
  assert.equal(outcome.decision, 'deny');
  assert.equal(outcome.decidedBy, 'policy');
});

test('A3: 振り返りでは ask は拒否として扱う（承認する人がいない裏の作業なので待たない）。会話では承認を求める', async t => {
  const s = setup(t, { memory_save: 'ask' });
  s.ctx.config.tools.shell.approvalTimeoutSec = 1;
  const review = await s.call('memory_save', {}, { ...s.ctx, kind: 'review', conversationId: 'review-conv' });
  assert.equal(review.decision, 'deny');
  assert.equal(review.decidedBy, 'policy');
  assert.match(review.output.content, /振り返り/u);
  assert.equal(s.approvals.pending().length, 0, '待たない');
  assert.deepEqual(s.ran, []);
  const chat = s.call('memory_save', {});
  const request = await waitPending(s);
  s.approvals.decide(request.id, 'once');
  assert.equal((await chat).decision, 'ask');
  assert.deepEqual(s.ran, ['memory_save']);

  const plain = setup(t);
  assert.equal((await plain.call('memory_save', {}, { ...plain.ctx, kind: 'review' })).decision, 'allow', '方針が無ければ振り返りで使える（比べる基準）');
});

test('A3: タスクの実行で ask になったら、今のシェルの承認と同じ流れ（タスクの承認待ち。時間が過ぎたら動かさない）', async t => {
  const s = setup(t, { file_write: 'ask' });
  s.ctx.config.tools.shell.approvalTimeoutSec = 1;
  const outcome = await s.call('file_write', { path: 'a.md', content: 'x' }, { ...s.ctx, kind: 'task', conversationId: 'task-conv' });
  assert.equal(outcome.decision, 'ask');
  assert.match(outcome.output.content, /承認の待ち時間が過ぎたため実行しませんでした/u);
  assert.equal(existsSync(join(s.paths.workspace, 'a.md')), false);
  const requested = s.events.filter(e => e.type === 'approval.requested');
  assert.equal(requested.length, 1);
  assert.equal(requested[0]!.conversationId, 'task-conv');
});

test('A3: 方針を持てない道具（task_complete・task_checkpoint・ask_user）は、設定に block・ask と書いてあっても無視する（止めるとワーカーが終われなくなる）', async t => {
  const s = setup(t, { task_complete: 'block', task_checkpoint: 'ask', ask_user: 'block' });
  const task = { ...s.ctx, kind: 'task' as const, conversationId: 'task-conv' };
  for (const name of ['task_complete', 'task_checkpoint', 'ask_user']) {
    const outcome = await s.call(name, {}, task);
    assert.equal(outcome.decision, 'allow', name);
    assert.equal(outcome.output.content, `ran ${name}`);
  }
  assert.equal(s.approvals.pending().length, 0);
});

test('A3: 実行の途中で設定が厳しくなったら、その場から効く。緩くなったときは、次の実行から（途中では緩めない）', async t => {
  const s = setup(t);
  const stricter = withPolicy(s, { file_write: 'block' });
  assert.equal((await s.call('file_write', { path: 'a.md', content: 'x' }, s.ctx, () => stricter)).decidedBy, 'policy', '開いたときは方針なし → いまは block');
  assert.equal(existsSync(join(s.paths.workspace, 'a.md')), false);

  const started = setup(t, { file_write: 'block' });
  const looser = withPolicy(started, {});
  const outcome = await started.call('file_write', { path: 'a.md', content: 'x' }, started.ctx, () => looser);
  assert.equal(outcome.decision, 'deny', '実行を始めたときの方針が block なら、途中で緩めても、その実行では使えない');

  const asked = setup(t, {});
  const live = withPolicy(asked, { file_write: 'ask' });
  const pending = asked.call('file_write', { path: 'b.md', content: 'x' }, asked.ctx, () => live);
  const request = await waitPending(asked);
  assert.equal(request.everyTime, true, '途中で ask にしても効く');
  asked.approvals.decide(request.id, 'deny');
  await pending;
});

test('A3: ask の理由には種類が付く（事前の判定 precheck・外から読んだ内容 taint・方針 policy・フック hook・コードを動かす code）。付かない理由を自動で通さないための土台', async t => {
  const dir = tempDir(t);
  const askHook = join(dir, 'ask.mjs');
  writeFileSync(askHook, `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'ask',permissionDecisionReason:'念のため確認'}}))})`);
  const kindsOf = async (s: ReturnType<typeof setup>, name: string, args: unknown, c: ToolContext = s.ctx) => {
    const running = s.call(name, args, c);
    const request = await waitPending(s);
    const kinds = [...(request.kinds ?? [])].sort();
    s.approvals.decide(request.id, 'deny');
    await running;
    return kinds;
  };

  const plain = setup(t);
  const outside = join(plain.paths.data, 'outside.txt');
  writeFileSync(outside, 'x');
  assert.deepEqual(await kindsOf(plain, 'shell_run', { command: process.platform === 'win32' ? `Get-Content "${outside}"` : `cat "${outside}"` }), ['precheck'], '許可フォルダの外を読む');
  writeFileSync(join(plain.paths.workspace, 'put.js'), "console.log('x');\n");
  assert.ok((await kindsOf(plain, 'shell_run', { command: 'node put.js' })).includes('code'), 'コードを動かす');
  assert.deepEqual(await kindsOf(plain, 'file_write', { path: 'a.md', content: 'x' }, { ...plain.ctx, taint: { tainted: true, sources: ['web_fetch'] } }), ['taint']);

  const policy = setup(t, { file_write: 'ask' });
  assert.deepEqual(await kindsOf(policy, 'file_write', { path: 'a.md', content: 'x' }), ['policy']);
  assert.deepEqual(await kindsOf(policy, 'file_write', { path: 'a.md', content: 'x' }, { ...policy.ctx, taint: { tainted: true, sources: ['web_fetch'] } }), ['policy', 'taint']);

  const hooked = setup(t, {}, c => { c.tools.hooks.preToolUse = [{ matcher: 'file_write', command: [process.execPath, askHook], timeoutMs: 10_000, onError: 'deny' }]; });
  assert.deepEqual(await kindsOf(hooked, 'file_write', { path: 'a.md', content: 'x' }), ['hook']);
});
