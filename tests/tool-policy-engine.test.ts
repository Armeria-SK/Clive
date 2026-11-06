import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { ModelConfig } from '../src/config/schema.ts';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { FakeAdapter, reply, tempDir, type Script, testConfig } from './helpers.ts';

// 段 8（A3）: 道具ごとの方針がエンジンを通ったときの動き。block はモデルに渡す道具の一覧から外れ、数えるときも同じ一覧を通る

function toolCall(name: string, args: unknown): Script {
  return async function* () {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

async function setup(t: { after: (fn: () => void) => void }, policies: Record<string, 'allow' | 'ask' | 'block'> = {}, model: Partial<ModelConfig> = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false, ...model }];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  config.tools.policies = policies;
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  const events: RunEvent[] = [];
  app.bus.subscribe(e => events.push(e.event));
  t.after(() => app.close());
  const send = async (text: string, conversation = 'c1') => {
    const outcome = app.engine.send(conversation, text);
    assert.ok(outcome.ok, JSON.stringify(outcome));
    return { runId: outcome.runId, done: app.engine.wait(outcome.runId)! };
  };
  return { app, adapter: () => adapter, events, send, paths };
}

const toolNames = (req: { tools: Array<{ name: string }> }): string[] => req.tools.map(tool => tool.name);

test('A3: 止めた道具は、モデルに渡す道具の一覧から外れる（ほかの道具はそのまま）', async t => {
  const plain = await setup(t);
  plain.adapter().scripts.push(reply('はい'));
  await (await plain.send('こんにちは')).done;
  const all = toolNames(plain.adapter().calls[0]!);
  assert.ok(all.includes('file_write') && all.includes('shell_run'));

  const s = await setup(t, { file_write: 'block', web_fetch: 'block', shell_run: 'ask' });
  s.adapter().scripts.push(reply('はい'));
  await (await s.send('こんにちは')).done;
  const names = toolNames(s.adapter().calls[0]!);
  assert.deepEqual(all.filter(name => !names.includes(name)).sort(), ['file_write', 'web_fetch'], '外れるのは block の 2 つだけ（ask の shell_run は一覧に残る）');
  assert.ok(names.includes('shell_run'));
});

test('A3: 道具の数の上限（maxTools）は、止めた道具を外したあとの一覧で数える', async t => {
  const plain = await setup(t, {}, { maxTools: 2 });
  plain.adapter().scripts.push(reply('はい'));
  await (await plain.send('こんにちは')).done;
  const [first, second] = toolNames(plain.adapter().calls[0]!);
  assert.ok(first && second);

  const s = await setup(t, { [first]: 'block' }, { maxTools: 2 });
  s.adapter().scripts.push(reply('はい'));
  await (await s.send('こんにちは')).done;
  const names = toolNames(s.adapter().calls[0]!);
  assert.equal(names.length, 2, '止めた分が穴にならず、次の道具が入って 2 個のまま');
  assert.ok(!names.includes(first));
  assert.equal(names[0], second);
});

test('A3: 設定を変えると、次のモデルの呼び出しから一覧が変わる（会話の途中でも）。数えるとき（コンテキストの使用量）も同じ一覧を通る', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(reply('1'));
  await (await s.send('1 つめ')).done;
  assert.ok(toolNames(s.adapter().calls[0]!).includes('file_write'));
  const before = s.app.engine.contextUsage('c1');
  assert.ok(before.ok);
  const current = s.app.config();
  await s.app.applyConfig({ ...current, tools: { ...current.tools, policies: { file_write: 'block', file_edit: 'block', shell_run: 'block' } } }, { probe: false });
  const after = s.app.engine.contextUsage('c1');
  assert.ok(after.ok);
  // 会話は同じなので、違いは道具の仕様だけ。止めた 3 つ分だけ少なく数える
  assert.ok(after.tokens < before.tokens, `止めた道具の分だけ少なく数える（前: ${before.tokens}、後: ${after.tokens}）`);
  // 設定を保存すると窓口が作り直される（偽の窓口も新しくなる）ので、2 回目の台本と呼び出しは新しい窓口のもの
  s.adapter().scripts.push(reply('2'));
  await (await s.send('2 つめ')).done;
  assert.ok(!toolNames(s.adapter().calls[0]!).includes('file_write'));
  assert.ok(toolNames(s.adapter().calls[0]!).includes('file_read'));
});

test('A3: モデルが止めた道具を呼んでも（一覧に無いのに呼ぶ・古い履歴からなど）実行せず、「決めたのは policy」で記録して続ける', async t => {
  const s = await setup(t, { file_write: 'block' });
  s.adapter().scripts.push(toolCall('file_write', { path: 'hello.md', content: 'やあ' }), reply('書けませんでした'));
  const { runId, done } = await s.send('hello.md を作って');
  assert.ok((await done).ok);
  assert.equal(existsSync(join(s.paths.workspace, 'hello.md')), false);
  const toolMessage = s.app.conversations.messages('c1').find(m => m.role === 'tool')!;
  assert.match(toolMessage.text, /止めている/u);
  const rows = s.app.db.prepare('SELECT tool, decision, decided_by, ok FROM tool_calls WHERE run_id = ?').all(runId).map(r => ({ ...r }));
  assert.deepEqual(rows, [{ tool: 'file_write', decision: 'deny', decided_by: 'policy', ok: 0 }]);
});

test('A3: ask の道具は、会話の中でも毎回承認を求める（「この会話では許可」を送っても、2 回目はまた聞く）', async t => {
  const s = await setup(t, { file_write: 'ask' });
  s.adapter().scripts.push(
    toolCall('file_write', { path: 'a.md', content: '1' }), toolCall('file_write', { path: 'a.md', content: '2' }), reply('書きました'),
  );
  const { done } = await s.send('a.md を 2 回書いて');
  const approvals: Array<Extract<RunEvent, { type: 'approval.requested' }>> = [];
  for (let n = 1; n <= 2; n++) {
    for (let i = 0; i < 300 && s.events.filter(e => e.type === 'approval.requested').length < n; i++) await new Promise(r => setTimeout(r, 10));
    const requested = s.events.filter(e => e.type === 'approval.requested')[n - 1] as Extract<RunEvent, { type: 'approval.requested' }>;
    assert.ok(requested, `${n} 回目の承認の依頼`);
    approvals.push(requested);
    assert.equal((requested.approval as { everyTime?: boolean }).everyTime, true, '画面に渡す形にも「毎回」の印が付く');
    s.app.approvals.decide(requested.approval.id, 'conversation');
  }
  assert.ok((await done).ok);
  assert.notEqual(approvals[0]!.approval.id, approvals[1]!.approval.id);
  assert.equal(existsSync(join(s.paths.workspace, 'a.md')), true);
});

test('A3: 実行の途中で持ち主が道具を止めたら、その実行の次の呼び出しから効く（実行を始めたときの設定のままにしない）', async t => {
  const s = await setup(t);
  const blockWhileRunning: Script = async function* () {
    const current = s.app.config();
    await s.app.applyConfig({ ...current, tools: { ...current.tools, policies: { file_write: 'block' } } }, { probe: false });
    const call: ToolCall = { id: 'call_late', name: 'file_write', arguments: { path: 'late.md', content: 'x' } };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
  s.adapter().scripts.push(blockWhileRunning);
  const { runId, done } = await s.send('late.md を作って');
  assert.ok((await done).ok);
  assert.equal(existsSync(join(s.paths.workspace, 'late.md')), false);
  assert.deepEqual(s.app.db.prepare('SELECT tool, decided_by FROM tool_calls WHERE run_id = ?').all(runId).map(r => ({ ...r })), [{ tool: 'file_write', decided_by: 'policy' }]);
});

// 道具ごとの方針は「実行を始めたときの設定」と「いまの設定」の厳しい方（パイプラインの policyFor と同じ決め）。モデルに渡す一覧（#toolsFor）も同じ決めにする
const withPolicies = async (s: { app: App }, policies: Record<string, 'allow' | 'ask' | 'block'>) => {
  const current = s.app.config();
  await s.app.applyConfig({ ...current, tools: { ...current.tools, policies } }, { probe: false });
};
const toolListCall = (s: { app: App }, policies: Record<string, 'allow' | 'ask' | 'block'>): Script => async function* () {
  await withPolicies(s, policies);
  const call: ToolCall = { id: 'call_list', name: 'file_list', arguments: {} };
  yield { type: 'tool_call', call };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

test('A3: 実行を始めたときに止めていた道具は、途中で「承認なし」に緩めても、その実行のあいだはモデルに渡す一覧へ戻らない。次の実行からは戻る', async t => {
  const s = await setup(t, { file_write: 'block' });
  const first = s.adapter();
  first.scripts.push(toolListCall(s, {}));
  const { runId, done } = await s.send('一覧を見て');
  assert.ok((await done).ok);
  assert.ok(!toolNames(first.calls[0]!).includes('file_write'), '最初の呼び出しでは止めている');
  assert.notEqual(s.adapter(), first, '設定を保存したので、窓口は作り直されている（2 回目の呼び出しは新しい窓口）');
  const second = s.adapter().calls[0]!;
  assert.ok(second, '道具を呼んだあとの 2 回目のモデルの呼び出し');
  assert.ok(!toolNames(second).includes('file_write'), '途中で緩めても、この実行の 2 回目の呼び出しの一覧に戻らない');
  assert.ok(toolNames(second).includes('file_list'));
  assert.equal(s.app.db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE run_id = ?').get(runId)!.n, 1);

  s.adapter().scripts.push(reply('はい'));
  await (await s.send('次の実行', 'c2')).done;
  assert.ok(toolNames(s.adapter().calls.at(-1)!).includes('file_write'), '次の実行からは、緩めた設定が効いて一覧に戻る');
});

test('A3: 途中で厳しくした分は、その場から一覧に効く（始めたときが承認なしでも、いまが止めるなら外れる）', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(toolListCall(s, { file_write: 'block' }));
  const { done } = await s.send('一覧を見て');
  assert.ok((await done).ok);
  assert.ok(!toolNames(s.adapter().calls[0]!).includes('file_write'), '途中で止めたら、2 回目の呼び出しの一覧から外れる');
  assert.ok(toolNames(s.adapter().calls[0]!).includes('file_list'));
});
