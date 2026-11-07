import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { startScreenServer } from './screen-server.ts';

// 段 8（A3）: GET /api/tools と PATCH /api/tools/:name

interface ToolRow { name: string; effect: string; allowedIn: string[]; policy: string; configurable: boolean }
const patch = (s: Awaited<ReturnType<typeof startScreenServer>>, name: string, body: unknown, headers: Record<string, string> = {}) =>
  s.api(`/api/tools/${name}`, { method: 'PATCH', body: JSON.stringify(body), headers });
const fileOf = (s: Awaited<ReturnType<typeof startScreenServer>>) => JSON.parse(readFileSync(s.app.paths.config, 'utf8')) as { tools: { policies?: Record<string, string> } };

test('GET /api/tools: 組み込みの道具 33 個を、名前・効果・使える場面・方針・方針を持てるかで返す（既定はすべて allow）', async t => {
  const s = await startScreenServer(t);
  const res = await s.api('/api/tools');
  assert.equal(res.status, 200);
  const { tools } = (await res.json()) as { tools: ToolRow[] };
  const server = builtinTools();
  assert.equal(tools.length, 33);
  assert.deepEqual(tools.map(tool => tool.name).sort(), server.map(tool => tool.name).sort());
  for (const tool of tools) {
    const def = server.find(d => d.name === tool.name)!;
    assert.deepEqual([tool.effect, tool.allowedIn, tool.policy], [def.effect, [...def.allowedIn], 'allow'], tool.name);
  }
  assert.deepEqual(tools.filter(tool => !tool.configurable).map(tool => tool.name).sort(), ['ask_user', 'task_checkpoint', 'task_complete']);
  assert.deepEqual(tools.find(tool => tool.name === 'memory_save')!.allowedIn, ['chat', 'task', 'review'], '振り返りでも使う道具は、allowedIn に review がある（画面の添え書きの元）');
});

test('PATCH /api/tools/:name: 方針を 1 つだけ変えて設定に保存する。allow に戻すと書いた項目を消す。ほかの設定には触れず、モデルの確認の通信もしない', async t => {
  const s = await startScreenServer(t);
  let probes = 0;
  const probeAll = s.app.status.probeAll.bind(s.app.status);
  s.app.status.probeAll = async (...args: Parameters<typeof probeAll>) => { probes++; return probeAll(...args); };
  const before = fileOf(s) as Record<string, any>;

  const res = await patch(s, 'shell_run', { policy: 'ask' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { tool: { name: 'shell_run', effect: 'exec', allowedIn: ['chat', 'task'], policy: 'ask', configurable: true } });
  assert.equal((await patch(s, 'file_write', { policy: 'block' })).status, 200);
  assert.deepEqual(fileOf(s).tools.policies, { shell_run: 'ask', file_write: 'block' });
  const after = fileOf(s) as Record<string, any>;
  assert.deepEqual({ ...after, tools: { ...after.tools, policies: undefined } }, { ...before, tools: { ...before.tools, policies: undefined } }, 'policies 以外は変わらない');
  const listed = ((await (await s.api('/api/tools')).json()) as { tools: ToolRow[] }).tools;
  assert.deepEqual(listed.filter(tool => tool.policy !== 'allow').map(tool => `${tool.name}:${tool.policy}`).sort(), ['file_write:block', 'shell_run:ask']);
  assert.equal(s.app.config().tools.policies.shell_run, 'ask', '再起動なしでエンジンが読む設定に入る');

  assert.equal((await patch(s, 'shell_run', { policy: 'allow' })).status, 200);
  assert.deepEqual(fileOf(s).tools.policies, { file_write: 'block' }, 'allow に戻すと書いた項目を消す');
  assert.equal(probes, 0, '道具の方針を変えるだけでは、モデルの確認の通信をしない');
});

test('PATCH /api/tools/:name: 同時に別の道具を変えても、どちらも残る（書き換えの取りこぼしが無い）', async t => {
  const s = await startScreenServer(t);
  const results = await Promise.all(['file_write', 'file_edit', 'shell_run', 'web_fetch'].map((name, i) => patch(s, name, { policy: i % 2 ? 'ask' : 'block' })));
  assert.deepEqual(results.map(r => r.status), [200, 200, 200, 200]);
  assert.deepEqual(fileOf(s).tools.policies, { file_write: 'block', file_edit: 'ask', shell_run: 'block', web_fetch: 'ask' });
});

test('PATCH /api/tools/:name: 知らない道具は 404、方針を持てない道具・知らない方針は 400（どれも何も書かない）', async t => {
  const s = await startScreenServer(t);
  const wrote = () => fileOf(s).tools.policies;
  const start = wrote();
  const unknown = await patch(s, 'no_such_tool', { policy: 'ask' });
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as { code: string }).code, 'http.tool_missing');
  for (const name of ['task_complete', 'task_checkpoint', 'ask_user']) {
    const res = await patch(s, name, { policy: 'block' });
    assert.equal(res.status, 400, name);
    assert.equal(((await res.json()) as { code: string }).code, 'http.tool_not_policyable');
  }
  for (const body of [{ policy: 'never' }, { policy: 3 }, {}, { policy: null }]) {
    const res = await patch(s, 'shell_run', body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await patch(s, '__proto__', { policy: 'ask' })).status, 404, 'Object の予約された名前も、道具ではない');
  assert.deepEqual(wrote(), start, '失敗では何も書かない');
});

test('PATCH /api/tools/:name: 書き込みなので Origin が要る。別のサイトの Origin・Sec-Fetch-Site: cross-site は断る', async t => {
  const s = await startScreenServer(t);
  const origin = new URL((await s.api('/api/health')).url).origin;
  const raw = (headers: Record<string, string>) => fetch(`${origin}/api/tools/shell_run`, { method: 'PATCH', body: JSON.stringify({ policy: 'block' }), headers: { 'Content-Type': 'application/json', ...headers } });
  assert.equal((await raw({})).status, 403, 'Origin なし');
  assert.equal((await raw({ Origin: 'http://evil.example' })).status, 403);
  assert.equal((await raw({ Origin: origin, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(fileOf(s).tools.policies && Object.keys(fileOf(s).tools.policies!).length, 0, '断った要求は何も書かない');
});
