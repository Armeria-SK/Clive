import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Runs } from '../src/db/runs.ts';
import type { AttachmentMeta, StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import type { PageNetwork, PageResponse } from '../src/tools/web/public-page.ts';
import { settled, waitFor } from './app-setup.ts';
import { FakeAdapter, reply, tempDir, testConfig, type Script } from './helpers.ts';

const C = 'c1';
const EVIL: AttachmentMeta = { id: 'u1', name: 'evil.txt', kind: 'text' };
const FETCH = { url: 'https://news.example.com/' };
const WRITE = { path: 'out.txt', content: 'x' };

const network: PageNetwork = {
  resolve: async () => ['93.184.216.34'],
  get: async () => ({ status: 200, contentType: 'text/html; charset=utf-8', body: Buffer.from('<!doctype html><html><head><title>t</title></head><body><main><p>ページの本文</p></main></body></html>') }) as PageResponse,
};

const call = (name: string, args: unknown): Script => async function* () {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call: toolCall };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};
// 止められるまで返事を始めない
const untilStopped: Script = async function* (req) {
  await new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }));
};

async function setup(t: { after: (fn: () => void) => void }, options: { maxIterations?: number } = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  config.memory.review = false;
  config.tools.shell.approvalTimeoutSec = 10;
  if (options.maxIterations) config.tools.maxIterations = options.maxIterations;
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, webNetwork: network, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(join(paths.workspace, 'a.txt'), 'こんにちは');
  return { app, adapter: () => adapter, paths };
}
type S = Awaited<ReturnType<typeof setup>>;

function send(s: S, text: string, attachments: AttachmentMeta[] = []): string {
  const outcome = s.app.engine.send(C, text, [], attachments);
  assert.ok(outcome.ok && !outcome.queued, JSON.stringify(outcome));
  return outcome.runId;
}
function retry(s: S): string {
  const outcome = s.app.engine.retry(C);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  return outcome.runId;
}
const next = (s: S, how: 'retry' | 'send') => how === 'retry' ? retry(s) : send(s, '続けて');

// 1 回目の実行: 道具を 1 つ呼んだあと、次の返事を待っているところで止める（最後の発言は道具の結果になる）
async function stopAfterTool(s: S, tool: string, args: unknown, text = '読んで', attachments: AttachmentMeta[] = []): Promise<string> {
  s.adapter().scripts = [call(tool, args), untilStopped];
  const runId = send(s, text, attachments);
  await waitFor(() => s.adapter().calls.length >= 2, '道具のあとの 2 回目の呼び出し');
  s.app.engine.stop(runId);
  await settled(s.app, runId);
  await s.app.engine.wait(runId);
  assert.equal(s.app.conversations.messages(C).at(-1)!.role, 'tool', '前提: 最後の発言は道具の結果');
  return runId;
}

// 次の実行の最初の道具（書き込み）が、確かめを求める（外から読んだ扱い）。断って終わらせる
async function expectAsked(s: S, runId: string, reason: RegExp): Promise<void> {
  await waitFor(() => s.app.approvals.pending().length === 1, '外から読んだあとの書き込みの確かめ');
  assert.match(s.app.approvals.pending()[0]!.reasons.join(' '), reason);
  s.app.approvals.decide(s.app.approvals.pending()[0]!.id, 'deny');
  await settled(s.app, runId);
  assert.equal(existsSync(join(s.paths.workspace, 'out.txt')), false, '断ったので書かれない');
}
// 確かめなしで書き込みが通る（外から読んだ扱いではない）
async function expectWritten(s: S, runId: string): Promise<void> {
  await settled(s.app, runId);
  assert.deepEqual(s.app.approvals.pending(), [], '確かめは出ない');
  assert.equal(existsSync(join(s.paths.workspace, 'out.txt')), true, '書き込みが通った');
}

test('やり直し: 添付を読んだ実行が、道具を使ったあとで止められても、やり直しは「外から読んだ」扱いのまま（書き込みは確かめが出る）', async t => {
  const s = await setup(t);
  const first = await stopAfterTool(s, 'file_read', { path: 'a.txt' }, '添付を見て', [EVIL]);
  assert.equal(s.app.runs.get(first)!.ok, 0);
  s.adapter().scripts = [call('file_write', WRITE), reply('おわり')];
  const runId = retry(s);
  await expectAsked(s, runId, /evil\.txt|前の実行/u);
});

for (const how of ['retry', 'send'] as const) {
  test(`Web を読んだ実行が止められたあとの実行（${how === 'retry' ? 'やり直し' : '次の発言'}）も「外から読んだ」扱いのまま（書き込みは確かめが出る）`, async t => {
    const s = await setup(t);
    const first = await stopAfterTool(s, 'web_fetch', FETCH);
    assert.equal(s.app.runs.get(first)!.tainted, 1, 'Web を読んだ実行は、終わるとき「外から読んだ」印が残る');
    s.adapter().scripts = [call('file_write', WRITE), reply('おわり')];
    const runId = next(s, how);
    await expectAsked(s, runId, /前の実行/u);
  });
}

test('外から読んでいない実行のあとのやり直しは、今までどおり確かめなしで書ける（印は 0）', async t => {
  const s = await setup(t);
  const first = await stopAfterTool(s, 'file_read', { path: 'a.txt' });
  assert.equal(s.app.runs.get(first)!.tainted, 0);
  s.adapter().scripts = [call('file_write', WRITE), reply('書きました')];
  await expectWritten(s, retry(s));
});

test('最後まで返事を書いて終わった実行の印は、次の実行に持ち越さない（Web を読んだ実行でも）', async t => {
  const s = await setup(t);
  s.adapter().scripts = [call('web_fetch', FETCH), reply('読みました')];
  const first = send(s, 'このページを読んで');
  await settled(s.app, first);
  await s.app.engine.wait(first);
  assert.equal(s.app.runs.get(first)!.ok, 1);
  assert.equal(s.app.runs.get(first)!.tainted, 1, '実行自体は外から読んだ');
  s.adapter().scripts = [call('file_write', WRITE), reply('書きました')];
  await expectWritten(s, send(s, 'メモを書いて'));
});

test('印は実行の頭から残る: 外から読んだ実行をやり直して、すぐ止めても、その次のやり直しも「外から読んだ」扱いのまま', async t => {
  const s = await setup(t);
  await stopAfterTool(s, 'web_fetch', FETCH);
  s.adapter().scripts = [untilStopped];
  const second = retry(s);
  await waitFor(() => s.adapter().calls.length >= 3, '2 回目の実行のモデル呼び出し');
  s.app.engine.stop(second);
  await settled(s.app, second);
  await s.app.engine.wait(second);
  assert.equal(s.app.runs.get(second)!.tainted, 1, '引き継いだ印が、この実行にも残る');
  s.adapter().scripts = [call('file_write', WRITE), reply('おわり')];
  await expectAsked(s, retry(s), /前の実行/u);
});

test('道具の上限で止まってまとめを書いた実行も、最後の返事ではないので、Web を読んだ印を次の実行に持ち越す', async t => {
  const s = await setup(t, { maxIterations: 1 });
  s.adapter().scripts = [call('web_fetch', FETCH), reply('ここまでやりました。次の一手: 書く')];
  const first = send(s, 'このページを読んで');
  await settled(s.app, first);
  await s.app.engine.wait(first);
  assert.equal(s.app.runs.get(first)!.ok, 1);
  assert.match(s.app.runs.get(first)!.flags, /max_iterations/u);
  assert.equal(s.app.conversations.messages(C).at(-1)!.role, 'assistant', '前提: 最後はまとめの返事（道具の呼び出しの付かない assistant の発言）');
  s.adapter().scripts = [call('file_write', WRITE), reply('おわり')];
  await expectAsked(s, send(s, '続けて'), /前の実行/u);
});

test('履歴の見方: 道具を呼んだ assistant の発言をまたいで、返事の付いていない添付を数える（実行の記録が無くても）', async t => {
  const s = await setup(t);
  const { conversations } = s.app;
  conversations.append(C, { role: 'user', content: '添付を見て', attachments: [EVIL] });
  conversations.append(C, { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'file_read', arguments: { path: 'a.txt' } }] });
  conversations.append(C, { role: 'tool', toolCallId: 't1', name: 'file_read', content: 'こんにちは' });
  s.adapter().scripts = [call('file_write', WRITE), reply('おわり')];
  await expectAsked(s, retry(s), /evil\.txt/u);
});

test('履歴の見方: 返事の付いた添付は数えない。道具を呼んだだけの assistant の発言は返事ではない', async t => {
  const s = await setup(t);
  const { conversations } = s.app;
  conversations.append(C, { role: 'user', content: '添付を見て', attachments: [EVIL] });
  conversations.append(C, { role: 'assistant', content: '読みました' });
  conversations.append(C, { role: 'user', content: '次はこれ' });
  conversations.append(C, { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'file_read', arguments: { path: 'a.txt' } }] });
  conversations.append(C, { role: 'tool', toolCallId: 't1', name: 'file_read', content: 'こんにちは' });
  s.adapter().scripts = [call('file_write', WRITE), reply('書きました')];
  await expectWritten(s, retry(s));
});

test('履歴の見方: 読み出せる行数（500）のなかに最後の返事が見つからなければ、添付の有無を確かめきれないので「外から読んだ」扱いにする', async t => {
  const s = await setup(t);
  const { conversations } = s.app;
  conversations.append(C, { role: 'user', content: '添付を見て', attachments: [EVIL] });
  for (let i = 0; i < 260; i++) {
    conversations.append(C, { role: 'assistant', content: '', toolCalls: [{ id: `t${i}`, name: 'file_read', arguments: { path: 'a.txt' } }] });
    conversations.append(C, { role: 'tool', toolCallId: `t${i}`, name: 'file_read', content: 'こんにちは' });
  }
  assert.ok(conversations.messages(C, 1000).length > 500, '前提: 500 行より長い');
  s.adapter().scripts = [call('file_write', WRITE), reply('おわり')];
  await expectAsked(s, retry(s), /確かめきれ/u);
});

test('履歴の見方: 500 行より長くても、そのなかに最後の返事が見つかれば、その後ろだけを見る（確かめきれない扱いにしない）', async t => {
  const s = await setup(t);
  const { conversations } = s.app;
  conversations.append(C, { role: 'user', content: '添付を見て', attachments: [EVIL] });
  conversations.append(C, { role: 'assistant', content: '読みました' });
  for (let i = 0; i < 260; i++) {
    conversations.append(C, { role: 'assistant', content: '', toolCalls: [{ id: `t${i}`, name: 'file_read', arguments: { path: 'a.txt' } }] });
    conversations.append(C, { role: 'tool', toolCallId: `t${i}`, name: 'file_read', content: 'こんにちは' });
  }
  conversations.append(C, { role: 'assistant', content: 'まとめです' });
  conversations.append(C, { role: 'user', content: 'ありがとう' });
  s.adapter().scripts = [call('file_write', WRITE), reply('書きました')];
  await expectWritten(s, retry(s));
});

test('実行の記録の印は、実行が終わらなくても残る（Runs.markTainted。落ちたあとの起動時の closeDangling で消えない）', () => {
  const db = openDatabase(':memory:', MIGRATIONS);
  const runs = new Runs(db);
  runs.start('r1', 'chat', 'c1');
  runs.start('r2', 'chat', 'c1');
  assert.equal(runs.get('r1')!.tainted, 0, '既定は 0');
  runs.markTainted('r1');
  assert.equal(runs.closeDangling(), 2);
  assert.equal(runs.get('r1')!.tainted, 1);
  assert.equal(runs.get('r2')!.tainted, 0);
  assert.equal(runs.latestChat('c1')!.id, 'r2', '会話の最後のチャットの実行');
  assert.equal(runs.latestChat('none'), undefined);
  db.close();
});
