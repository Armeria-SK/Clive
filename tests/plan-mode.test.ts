import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { buildDynamic } from '../src/engine/workspace.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { PLAN_EFFECTS, planAllows, runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDef, ToolEffect } from '../src/tools/types.ts';
import type { PermissionMode } from '../src/shared/permission-mode.ts';
import { CONVERSATION, settled, startApp, waitFor } from './app-setup.ts';
import { tempDir, testConfig, type Script } from './helpers.ts';

// 段 8b: 計画モード。モデルに渡す道具を読む道具（read）と Web の読み取り（network）だけにし、パイプラインでも他の効果を拒否する

const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;
const EFFECTS: ToolEffect[] = ['read', 'write', 'exec', 'network', 'meta'];

function stub(effect: ToolEffect, ran: string[]): ToolDef {
  return { name: `stub_${effect}`, description: effect, input: Type.Object({}, { additionalProperties: false }), effect, allowedIn: ['chat', 'task', 'review'], async execute() { ran.push(effect); return { content: `ran ${effect}` }; } };
}

function pipeline(t: { after: (fn: () => void) => void }, mode: () => PermissionMode, startMode: PermissionMode | undefined) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = parseConfig(testConfig());
  const db = openDatabase(':memory:', MIGRATIONS);
  const approvals = new ApprovalBroker(db, () => undefined);
  const ran: string[] = [];
  const registry = new ToolRegistry();
  for (const effect of EFFECTS) registry.register(stub(effect, ran));
  const policy = buildPolicy(config, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined, ...(startMode ? { permissionMode: startMode } : {}),
  };
  const call = (effect: ToolEffect, c: ToolContext = ctx) => runToolCall({ id: `c-${effect}`, name: `stub_${effect}`, arguments: {} }, c, { registry, approvals, db, emit: () => undefined, permissionMode: mode, conversationAutoRead: () => false });
  return { call, ran, db, ctx };
}

test('計画モード（パイプライン）: 読む道具と Web の読み取りだけが動く。書き込み・実行・meta は、呼ばれても拒否して、道具の記録に決めたのは mode と残す', async t => {
  assert.deepEqual([...PLAN_EFFECTS].sort(), ['network', 'read']);
  const s = pipeline(t, () => 'plan', 'plan');
  for (const effect of EFFECTS) {
    const outcome = await s.call(effect);
    if (PLAN_EFFECTS.has(effect)) {
      assert.equal(outcome.decision, 'allow', effect);
      assert.equal(outcome.output.content, `ran ${effect}`);
    } else {
      assert.equal(outcome.decision, 'deny', effect);
      assert.equal(outcome.decidedBy, 'mode', effect);
      assert.match(outcome.output.content, /計画/u, effect);
    }
  }
  assert.deepEqual(s.ran, ['read', 'network']);
  assert.deepEqual(s.db.prepare("SELECT tool, decision, decided_by FROM tool_calls WHERE decided_by = 'mode' ORDER BY tool").all().map(r => ({ ...r })), [
    { tool: 'stub_exec', decision: 'deny', decided_by: 'mode' }, { tool: 'stub_meta', decision: 'deny', decided_by: 'mode' }, { tool: 'stub_write', decision: 'deny', decided_by: 'mode' },
  ]);
});

test('計画モード（パイプライン）: 始めたときと今のモードの厳しい方。始めはふつう・いまは計画ならその場から効き、始めは計画・いまはふつうなら、その実行のあいだは計画のまま。タスク・振り返りには効かない', async t => {
  const tightened = pipeline(t, () => 'plan', 'normal');
  assert.equal((await tightened.call('write')).decidedBy, 'mode', '途中で計画にしたら、すぐ効く');
  const loosened = pipeline(t, () => 'normal', 'plan');
  assert.equal((await loosened.call('write')).decidedBy, 'mode', '途中でふつうに戻しても、この実行は計画のまま');
  assert.deepEqual(loosened.ran, []);
  const none = pipeline(t, () => 'normal', undefined);
  assert.equal((await none.call('write')).decision, 'allow', 'モードが無い（ふつう）');
  for (const kind of ['task', 'review'] as const) {
    const s = pipeline(t, () => 'plan', 'plan');
    const outcome = await s.call(kind === 'task' ? 'write' : 'meta', { ...s.ctx, kind, conversationId: `${kind}-conv` });
    assert.notEqual(outcome.decidedBy, 'mode', `${kind}: 会話の計画モードは関係ない`);
  }
});

test('計画モード: 日本語・英語の指示。毎回組み立てる system に入り、ふつうのモードでは何も足さない', () => {
  const now = new Date('2026-11-04T20:00:00Z');
  const plain = buildDynamic('Asia/Tokyo', 'ja', now);
  assert.equal(buildDynamic('Asia/Tokyo', 'ja', now, 'normal'), plain);
  assert.equal(buildDynamic('Asia/Tokyo', 'ja', now, 'auto'), plain);
  const ja = buildDynamic('Asia/Tokyo', 'ja', now, 'plan');
  assert.ok(ja.startsWith(plain));
  assert.match(ja, /計画モード/u);
  assert.match(ja, /手順の一覧/u);
  const en = buildDynamic('Asia/Tokyo', 'en', now, 'plan');
  assert.match(en, /plan mode/iu);
  assert.match(en, /numbered list/u);
  assert.doesNotMatch(en, CJK);
});

type Started = Awaited<ReturnType<typeof startApp>>;
const say = (text: string): Script => async function* () { yield { type: 'text', delta: text }; yield { type: 'done', stop: 'end_turn' as StopReason }; };
const callTool = (name: string, args: unknown): Script => async function* () {
  const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }
const after = (g: { promise: Promise<void> }, script: Script): Script => async function* (req) {
  await Promise.race([g.promise, new Promise<never>((_, reject) => { req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }); })]);
  yield* script(req);
};
const post = (s: Started, text: string, extra: Record<string, unknown> = {}) => s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text, ...extra });
const toolNames = (req: { tools: Array<{ name: string }> }) => req.tools.map(t => t.name).sort();

test('計画モード（エンジン）: モデルに渡す道具は読む道具と Web の読み取りだけ。ふつうのモードでは書き込み・実行・meta の道具も渡す', async t => {
  const s = await startApp(t);
  s.adapter().scripts = [say('計画です'), say('ふつうです')];
  const plan = await post(s, '計画して', { permissionMode: 'plan' });
  await settled(s.app, plan.body.runId);
  const planTools = toolNames(s.adapter().calls[0]!);
  const all = s.app.tools.forRun('chat').map(tool => tool.name).sort();
  assert.deepEqual(planTools, s.app.tools.forRun('chat').filter(planAllows).map(tool => tool.name).sort());
  assert.ok(planTools.includes('file_read') && planTools.includes('file_list') && planTools.includes('web_fetch') && planTools.includes('web_search'));
  for (const gone of ['shell_run', 'file_write', 'file_edit', 'memory_save', 'task_create', 'web_download']) assert.ok(!planTools.includes(gone), `${gone} は渡さない`);
  const normal = await post(s, 'ふつうに', { permissionMode: 'normal' });
  await settled(s.app, normal.body.runId);
  assert.deepEqual(toolNames(s.adapter().calls[1]!), all, 'ふつうのモードは全部');
});

test('計画モード（エンジン）: 毎回組み立てる system の部分に計画の指示が入る（固定の system は変わらない）。英語の設定なら英語', async t => {
  const s = await startApp(t, { configure: c => { c.language = 'en'; } });
  s.adapter().scripts = [say('a'), say('b')];
  const plan = await post(s, 'plan please', { permissionMode: 'plan' });
  await settled(s.app, plan.body.runId);
  const normal = await post(s, 'now normal', { permissionMode: 'normal' });
  await settled(s.app, normal.body.runId);
  const [first, second] = s.adapter().calls;
  assert.match(first!.system.dynamic, /plan mode/iu);
  assert.doesNotMatch(first!.system.frozen, /plan mode/iu, '固定の system は変えない');
  assert.doesNotMatch(second!.system.dynamic, /plan mode/iu);
  assert.equal(first!.system.frozen, second!.system.frozen);
});

test('計画モード（エンジン）: モデルが書き込みを呼んでも拒否する（道具が一覧に無くても二重に止める）。ファイルは作られず、札も出ない', async t => {
  const s = await startApp(t);
  s.adapter().scripts = [callTool('file_write', { path: 'a.md', content: 'x' }), callTool('shell_run', { command: 'echo hi' }), say('計画です')];
  const sent = await post(s, '計画して', { permissionMode: 'plan' });
  await settled(s.app, sent.body.runId);
  assert.equal(existsSync(join(s.paths.workspace, 'a.md')), false);
  assert.equal(s.app.approvals.pending().length, 0);
  assert.deepEqual(s.app.db.prepare('SELECT tool, decision, decided_by FROM tool_calls ORDER BY created_at').all().map(r => ({ ...r })), [
    { tool: 'file_write', decision: 'deny', decided_by: 'mode' }, { tool: 'shell_run', decision: 'deny', decided_by: 'mode' },
  ]);
});

test('計画モード（エンジン）: 実行の途中で計画にしたら、次にモデルを呼ぶときの道具から書き込みが消える。途中でふつうに戻しても、この実行は計画のまま', async t => {
  const s = await startApp(t);
  mkdirSync(s.paths.workspace, { recursive: true });
  writeFileSync(join(s.paths.workspace, 'a.txt'), 'こんにちは');
  const g = gate();
  s.adapter().scripts = [after(g, callTool('file_read', { path: 'a.txt' })), say('読みました')];
  const sent = await post(s, '読んで');
  await s.json(`/api/conversations/${CONVERSATION}`, 'PATCH', { permissionMode: 'plan' });
  g.open();
  await settled(s.app, sent.body.runId);
  const [first, second] = s.adapter().calls;
  assert.ok(toolNames(first!).includes('file_write'), '始めはふつうで、道具を渡した（モデルの呼び出しは、道具を渡したあとにモードが替わった）');
  assert.ok(!toolNames(second!).includes('file_write'), '途中で計画にしたので、次の呼び出しから書き込みの道具が消える');

  const t2 = await startApp(t);
  mkdirSync(t2.paths.workspace, { recursive: true });
  writeFileSync(join(t2.paths.workspace, 'a.txt'), 'こんにちは');
  const g2 = gate();
  t2.adapter().scripts = [after(g2, callTool('file_read', { path: 'a.txt' })), say('読みました')];
  const second2 = await post(t2, '読んで', { permissionMode: 'plan' });
  await t2.json(`/api/conversations/${CONVERSATION}`, 'PATCH', { permissionMode: 'normal' });
  g2.open();
  await settled(t2.app, second2.body.runId);
  assert.ok(t2.adapter().calls.every(c => !toolNames(c).includes('file_write')), '計画で始めた実行は、途中でふつうに戻しても計画のまま');
});

test('計画モード（エンジン）: 使用量の数え方も計画モードの道具の一覧と指示で数える（次の実行と同じ数）', async t => {
  const s = await startApp(t);
  await s.json('/api/conversations', 'POST', { title: '数える' });
  const id = s.app.conversations.list()[0]!.id;
  const normal = (await s.json(`/api/conversations/${id}/context`, 'GET')).body.tokens as number;
  await s.json(`/api/conversations/${id}`, 'PATCH', { permissionMode: 'plan' });
  const plan = (await s.json(`/api/conversations/${id}/context`, 'GET')).body.tokens as number;
  assert.ok(plan < normal, `道具が減るので、計画モードの方が小さい（${plan} < ${normal}）`);

  // 実行の est_prompt_tokens と同じ数: 同じ会話を計画モードで送る前に数えたものと、実行が見積もったもの（新しい発言の分だけ後者が大きい）
  s.adapter().scripts = [say('計画です')];
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: '計画して' });
  await settled(s.app, sent.body.runId);
  const run = s.app.runs.get(sent.body.runId)!;
  const after = (await s.json(`/api/conversations/${id}/context`, 'GET')).body.tokens as number;
  assert.ok(run.est_prompt_tokens !== null && run.est_prompt_tokens >= plan && run.est_prompt_tokens < normal + 200, `実行の見積もり ${run.est_prompt_tokens} は計画モードの数 ${plan} 以上`);
  assert.ok(after > plan);
  await waitFor(() => !s.app.engine.activeRuns().length, '実行が終わる');
});
