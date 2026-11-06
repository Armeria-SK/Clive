import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { CONVERSATION, settled, startApp, waitFor } from './app-setup.ts';
import type { Script } from './helpers.ts';

// 段 9f（API キーを DB・ログ・画面の出来事・API の応答のどこにも残さない）と、段 8b（自動承認の判定役）の取り込み。
// 判定役の返事は相手のモデルが書いた文で、その短い理由は承認の記録・画面の出来事・実行ログの API に出る。返事が鍵そのものを書いても、そのまま残さない

// 鍵らしい形（sk- など）だと、伏せ字の処理に隠れて漏れを見逃すので、どの形にも当たらない文字列を使う
const KEY = 'Zk3qP9xW7mB2vN8cLd5Tq1';

type Started = Awaited<ReturnType<typeof startApp>>;

const say = (text: string): Script => async function* () { yield { type: 'text', delta: text }; yield { type: 'done', stop: 'end_turn' as StopReason }; };
const toolCall = (name: string, args: unknown): Script => async function* () {
  const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

function outsideReadCommand(s: Started): string {
  mkdirSync(s.paths.workspace, { recursive: true });
  const path = join(s.paths.data, 'outside.txt');
  writeFileSync(path, '外のメモの中身');
  return process.platform === 'win32' ? `Get-Content "${path}"` : `cat "${path}"`;
}

const dump = async (s: Started, seen: RunEvent[]): Promise<string> => JSON.stringify([
  s.app.db.prepare('SELECT * FROM approvals').all(),
  s.app.approvals.pending(),
  (await s.json('/api/tool-calls?limit=50', 'GET')).body,
  (await s.json('/api/approvals', 'GET')).body,
  seen,
]);

test('自動承認の判定役が「許す」の理由に API キーをそのまま書いても、承認の記録・実行ログの API・画面の出来事に鍵は残らない', async t => {
  const s = await startApp(t, { env: { FAKE_KEY: KEY } });
  s.adapter().scripts = [toolCall('shell_run', { command: outsideReadCommand(s) }), say(`{"decision":"allow","reason":"鍵 ${KEY} は使わず外のメモを読むだけ"}`), say('読みました')];
  const seen: RunEvent[] = [];
  s.app.bus.subscribe(e => { seen.push(e.event); });
  const sent = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: '外のメモ（outside.txt）を読んで', permissionMode: 'auto' });
  await settled(s.app, sent.body.runId);
  const rows = s.app.db.prepare("SELECT status, reasons FROM approvals WHERE scope = 'auto'").all() as Array<{ status: string; reasons: string }>;
  assert.equal(rows.length, 1, '判定役が許して動いた（判定役の道を通った）');
  assert.equal(rows[0]!.status, 'approved');
  assert.match((JSON.parse(rows[0]!.reasons) as string[]).at(-1)!, /\[REDACTED\]/u, '理由は残るが、鍵のところは伏せ字');
  assert.ok(!(await dump(s, seen)).includes(KEY), '鍵そのものはどこにも無い');
});

test('自動承認の判定役が「確かめる」の理由に API キーをそのまま書いても、承認の札（記録・一覧・画面の出来事）に鍵は残らない', async t => {
  const s = await startApp(t, { env: { FAKE_KEY: KEY } });
  s.adapter().scripts = [toolCall('shell_run', { command: outsideReadCommand(s) }), say(`{"decision":"ask","reason":"鍵 ${KEY} が絡むかもしれない"}`), say('読みました')];
  const seen: RunEvent[] = [];
  s.app.bus.subscribe(e => { seen.push(e.event); });
  const sent = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: '外のメモ（outside.txt）を読んで', permissionMode: 'auto' });
  await waitFor(() => s.app.approvals.pending().length === 1, '承認の札');
  const [request] = s.app.approvals.pending();
  assert.ok(request!.reasons.some(r => r.includes('[REDACTED]')), '判定役の理由は札に載るが、鍵のところは伏せ字');
  assert.ok(!(await dump(s, seen)).includes(KEY), '鍵そのものはどこにも無い');
  s.app.approvals.decide(request!.id, 'deny');
  await settled(s.app, sent.body.runId);
});

test('自動承認のモードでも、鍵を入れる API をシェルから呼ぶ形は判定役に回さず、毎回の確かめの札を出す。許さなければ鍵は入らない', async t => {
  const s = await startApp(t);
  const url = `${s.origin}/api/providers/fake/key`;
  const command = process.platform === 'win32' ? `Invoke-RestMethod -Method Put -Uri ${url} -ContentType application/json -Body '{"key":"${KEY}"}'` : `curl -X PUT -H "Content-Type: application/json" -d '{"key":"${KEY}"}' ${url}`;
  s.adapter().scripts = [toolCall('shell_run', { command }), say('終わりました')];
  const sent = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'fake の API キーを入れて', permissionMode: 'auto' });
  await waitFor(() => s.app.approvals.pending().length === 1, '承認の札');
  const [request] = s.app.approvals.pending();
  assert.equal(request!.onceOnly, true, '同じ文字のコマンドの許可を覚えない、今回だけの確かめ');
  assert.equal(s.adapter().calls.length, 1, '判定役は呼ばれていない');
  assert.equal(s.app.approvals.pending().length, 1, '自動では通らない');
  s.app.approvals.decide(request!.id, 'deny');
  await settled(s.app, sent.body.runId);
  assert.equal((await s.json('/api/providers/fake/key', 'GET')).body.set, false, '許さなければ鍵は入らない');
  assert.equal(s.app.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE scope = 'auto'").get()!.n, 0);
});
