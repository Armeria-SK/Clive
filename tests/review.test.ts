import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import { defaultConfig } from '../src/config/store.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { reviewPrompt, transcriptOf } from '../src/memory/review.ts';
import { resolvePaths } from '../src/paths.ts';
import { parseSkillFile, renderSkillFile } from '../src/tools/skills/store.ts';
import { createWebServer } from '../src/web/server.ts';
import { FakeAdapter, reply, tempDir, type Script } from './helpers.ts';

const MIN = 60_000;

function toolCall(name: string, args: unknown): Script {
  return async function* () {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

async function setup(t: { after: (fn: () => void) => void }, edit: (c: AppConfig) => void = () => undefined, before: (workspace: string) => void = () => undefined) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  before(paths.workspace);
  const config = defaultConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  edit(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-05T01:00:00Z') }; // 日本時間 10:00
  let adapter!: FakeAdapter;
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false,
    adapterOverride: p => (adapter = new FakeAdapter(p)),
  });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  const chat = async (conversationId: string, text: string) => {
    const outcome = app.engine.send(conversationId, text);
    assert.ok(outcome.ok, JSON.stringify(outcome));
    const result = await app.engine.wait(outcome.runId);
    assert.ok(!result || result.ok);
    return outcome.runId;
  };
  return { app, adapter: () => adapter, clock, chat, paths };
}

test('振り返りの実行では、シェルもファイルも渡さず、呼ばれても拒否する', async t => {
  const s = await setup(t);
  await s.app.worker.tick(); // 振り返りの対象にする時刻（review:since）を決める
  s.adapter().scripts.push(reply('こんにちは'));
  await s.chat('c1', '今日は渋谷で打ち合わせ');
  s.app.reviews.enqueue('manual', 'manual:c1', { conversationId: 'c1' });
  s.adapter().scripts.push(toolCall('shell_run', { command: 'echo hi', cwd: '.' }), reply('変更なし'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const request = s.adapter().calls.at(-2)!;
  const names = request.tools.map(t => t.name);
  assert.ok(names.includes('memory_save') && names.includes('skill_draft') && names.includes('curiosity_add'));
  for (const forbidden of ['shell_run', 'file_write', 'file_edit', 'file_read', 'task_create', 'web_fetch', 'web_search']) assert.ok(!names.includes(forbidden), forbidden);
  assert.match(String(request.messages.at(-1)?.content), /振り返り/u);
  assert.match(String(request.messages.at(-1)?.content), /渋谷で打ち合わせ/u);
  const call = s.app.db.prepare("SELECT decision, ok FROM tool_calls WHERE tool = 'shell_run'").get() as { decision: string; ok: number };
  assert.equal(call.decision, 'deny');
  const job = s.app.reviews.list()[0]!;
  assert.equal(job.status, 'done');
  assert.equal(job.note, '変更なし');
});

test('会話が途切れたときの振り返りは、新しい発言が来るまで 1 回だけ', async t => {
  const s = await setup(t, c => { c.memory.reviewIdleMinutes = 30; });
  await s.app.worker.tick();
  s.adapter().scripts.push(reply('了解'));
  await s.chat('c1', '来週から大阪に出張です');
  s.clock.now += 10 * MIN;
  assert.equal(await s.app.worker.tick(), 'idle', 'まだ途切れていない');
  s.clock.now += 25 * MIN;
  s.adapter().scripts.push(toolCall('memory_save', { book: 'user', content: '来週から大阪に出張' }), reply('出張の予定を覚えました'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.memory.list()[0]?.content, '来週から大阪に出張');
  assert.equal(s.app.memory.list()[0]?.origin, 'review');
  const calls = s.adapter().calls.length;
  for (let i = 0; i < 6; i++) { s.clock.now += 30 * MIN; assert.equal(await s.app.worker.tick(), 'idle'); }
  assert.equal(s.adapter().calls.length, calls, '同じ発言では二度振り返らない');

  s.adapter().scripts.push(reply('いってらっしゃい'));
  await s.chat('c1', '新幹線は朝 7 時です');
  s.clock.now += 31 * MIN;
  s.adapter().scripts.push(reply('変更なし'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const prompt = String(s.adapter().calls.at(-1)!.messages.at(-1)?.content);
  assert.match(prompt, /新幹線は朝 7 時/u);
  assert.doesNotMatch(prompt, /大阪に出張/u, '前回振り返った発言は渡さない');
});

test('振り返りで記憶をまとめても、取り消せる', async t => {
  const s = await setup(t);
  const a = s.app.memory.save({ book: 'user', content: 'コーヒーが好き', actor: 'clive' }).memory;
  const b = s.app.memory.save({ book: 'user', content: '朝はコーヒーを飲む', actor: 'clive' }).memory;
  await s.app.worker.tick();
  s.adapter().scripts.push(reply('はい'));
  await s.chat('c1', 'コーヒーの話');
  s.app.reviews.enqueue('manual', 'manual:c1', { conversationId: 'c1' });
  s.adapter().scripts.push(
    toolCall('memory_update', { id: `u${a.id}`, content: 'コーヒーが好きで、朝に飲む' }),
    toolCall('memory_forget', { id: `u${b.id}`, reason: '上にまとめた' }),
    reply('2件を1件にまとめました'),
  );
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.deepEqual(s.app.memory.list().map(m => m.content), ['コーヒーが好きで、朝に飲む']);
  const events = s.app.memory.events().filter(e => e.actor === 'review');
  assert.equal(events.length, 2);
  for (const e of events) s.app.memory.undo(e.id);
  assert.deepEqual(s.app.memory.list().map(m => m.content).sort(), ['コーヒーが好き', '朝はコーヒーを飲む']);
});

test('ユーザーが消した記憶は、振り返りの依頼文で「覚え直さない」と伝える', () => {
  const prompt = reviewPrompt({ trigger: 'idle', transcript: '【ユーザー】こんにちは', forgotten: ['猫を飼っている'] });
  assert.match(prompt, /消した記憶[\s\S]*猫を飼っている/u);
  const transcript = transcriptOf([
    { id: 1, conversation_id: 'c', run_id: null, role: 'user', text: 'a'.repeat(50), message: { role: 'user', content: 'x' }, created_at: 0 },
    { id: 2, conversation_id: 'c', run_id: null, role: 'assistant', text: '新しい方', message: { role: 'assistant', content: 'x' }, created_at: 0 },
  ], 20);
  assert.equal(transcript, '【Clive】新しい方', '長すぎるときは新しい方を残す');
});

test('タスクが終わったら振り返る。重い会話の後も振り返る', async t => {
  const s = await setup(t, c => { c.memory.reviewAfterToolCalls = 1; });
  await s.app.worker.tick();
  const task = s.app.tasks.create({ title: '調べもの', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'わかった', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.reviews.list()[0]?.trigger, 'task');
  assert.equal(s.app.reviews.list()[0]?.task_id, task.id);
  s.adapter().scripts.push(reply('変更なし'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.match(String(s.adapter().calls.at(-1)!.messages.at(-1)?.content), /終わったタスク[\s\S]*わかった/u);

  s.adapter().scripts.push(toolCall('memory_search', { query: 'コーヒー' }), reply('ありませんでした'));
  const runId = await s.chat('c2', 'コーヒーの記憶ある？');
  assert.ok(s.app.reviews.list().some(j => j.trigger === 'heavy_run' && j.dedup_key === `run:${runId}`));
});

test('振り返りを切ると、きっかけがあっても積まない', async t => {
  const s = await setup(t, c => { c.memory.review = false; });
  await s.app.worker.tick();
  s.adapter().scripts.push(reply('はい'));
  await s.chat('c1', 'こんにちは');
  s.clock.now += 60 * MIN;
  assert.equal(await s.app.worker.tick(), 'idle');
  assert.equal(s.app.reviews.list().length, 0);
});

test('スキルの下書きは、承認するまで索引に出ず、読めない', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(
    toolCall('skill_draft', { name: 'weekly-report', description: '週報を書くとき', body: '1. 今週のタスクを集める\n2. 3行でまとめる', reason: '毎週頼まれるので' }),
    reply('下書きしました'),
  );
  await s.chat('c1', '週報の手順を覚えて');
  assert.equal(s.app.skills.list().length, 0);
  assert.equal(s.app.skills.index(), '');
  const draft = s.app.skills.drafts()[0]!;
  assert.equal(draft.status, 'pending');
  assert.equal(s.app.notifications.list()[0]?.link, '#/skills/draft/weekly-report');

  s.app.skills.approve(draft.id);
  assert.match(s.app.skills.index(), /weekly-report: 週報を書くとき/u);
  s.adapter().scripts.push(toolCall('skill_view', { name: 'weekly-report' }), reply('手順どおりに書きます'));
  await s.chat('c2', '週報を書いて');
  const system = s.adapter().calls.at(-2)!.system.frozen;
  assert.match(system, /weekly-report/u, '新しい会話の system に索引が入る');
  assert.match(s.app.conversations.messages('c2').find(m => m.role === 'tool')!.text, /3行でまとめる/u);
  assert.equal(s.app.skills.get('weekly-report')!.uses, 1);
  assert.throws(() => s.app.skills.approve(draft.id), /承認待ち/u);
});

test('SKILL.md の読み書き（先頭の --- の中の name と description）', () => {
  const text = renderSkillFile({ name: 'a-b', description: '説明: "引用"あり', body: '本文\n2行目' });
  const parsed = parseSkillFile(text);
  assert.equal(parsed.name, 'a-b');
  assert.equal(parsed.description, '説明: "引用"あり');
  assert.equal(parseSkillFile("---\nname: x\ndescription: 'it''s'\n---\nb").description, "it's");
  assert.equal(parsed.body, '本文\n2行目');
  assert.deepEqual(parseSkillFile('本文だけ'), { body: '本文だけ' });
});

test('好奇心から調べるタスクを作り、結果を書き戻す（自発行動・上限・静かな時間帯を守る）', async t => {
  const s = await setup(t, c => { c.memory.review = false; c.worker.curiosityPerDay = 1; c.worker.idleMinutes = 0; c.worker.quietStart = '23:00'; c.worker.quietEnd = '07:00'; });
  s.app.curiosity.add({ topic: 'node:sqlite の FTS5', why: '日本語検索に使えるか', source: 'clive' });
  s.app.curiosity.add({ topic: 'croner のタイムゾーン', source: 'clive' });
  assert.equal(await s.app.worker.tick(), 'idle', '自発行動がオフ');
  await s.app.applyConfig({ ...s.app.config(), worker: { ...s.app.config().worker, autonomy: true } });
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'trigram で日本語も検索できる', notify: true }));
  assert.equal(await s.app.worker.tick(), 'ran');
  const done = s.app.curiosity.list({ includeClosed: true }).find(i => i.topic === 'node:sqlite の FTS5')!;
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'trigram で日本語も検索できる');
  assert.equal(await s.app.worker.tick(), 'idle', '24 時間に 1 件まで');
  s.clock.now = Date.parse('2026-11-05T15:00:00Z'); // 翌日の日本時間 00:00（静かな時間帯）
  s.clock.now += 0;
  assert.equal(await s.app.worker.tick(), 'idle', '静かな時間帯');
  s.clock.now = Date.parse('2026-11-06T01:30:00Z'); // 翌日の 10:30
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'IANA 名で指定できる', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.curiosity.list().length, 0);
});

test('自発タスクを承認制にしているとき、断ったら好奇心は「やめた」になる', async t => {
  const s = await setup(t, c => { c.memory.review = false; c.worker.autonomy = true; c.worker.idleMinutes = 0; c.worker.selfTasksNeedApproval = true; });
  const item = s.app.curiosity.add({ topic: 'WebGPU', source: 'clive' });
  assert.equal(await s.app.worker.tick(), 'idle');
  const proposal = s.app.tasks.list({ statuses: ['inbox'] })[0]!;
  assert.equal(proposal.origin, 'curiosity');
  s.app.tasks.finish(proposal.id, 'cancelled', null, 'user');
  assert.equal(s.app.curiosity.get(item.id)!.status, 'dropped');
  assert.equal(s.adapter().calls.length, 0);
});

test('初回だけ CURIOSITY.md の箇条書きを取り込む', async t => {
  const s = await setup(t, () => undefined, workspace => {
    writeFileSync(join(workspace, 'CURIOSITY.md'), '# CURIOSITY\n\n## 気になっていること\n- 量子計算\n- [ ] 古典音楽の調律\n\n本文は無視\n');
  });
  assert.deepEqual(s.app.curiosity.list().map(i => i.topic).sort(), ['古典音楽の調律', '量子計算'].sort());
  assert.ok(s.app.kv.get('curiosity:imported'));
});

test('API: レビュー・スキル・好奇心・振り返りの記録', async t => {
  const s = await setup(t);
  const web = createWebServer(s.app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(() => { web.server.closeAllConnections(); web.server.close(); });
  const api = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() as any };
  };

  s.app.skills.write({ name: 'greet', description: 'あいさつ', body: 'こんにちは' });
  const draft = s.app.skills.draft({ name: 'greet', description: 'あいさつ（丁寧）', body: 'こんにちは。お元気ですか', reason: '丁寧にしたい' });
  const review = await api('/api/review');
  assert.equal(review.body.skillDrafts[0].current.body, 'こんにちは', '直す前の中身も返す（差分を見せるため）');
  assert.equal((await api(`/api/skill-drafts/${draft.id}/approve`, {})).status, 200);
  assert.equal((await api('/api/skills/greet')).body.skill.body, 'こんにちは。お元気ですか');
  assert.equal((await api('/api/skills/Bad_Name', { description: 'x', body: 'y' }, 'PUT')).status, 400);
  assert.equal((await api('/api/skills/memo', { description: 'メモ', body: '書く' }, 'PUT')).status, 200);
  assert.deepEqual((await api('/api/skills')).body.skills.map((k: any) => k.name), ['greet', 'memo']);
  assert.equal((await api('/api/skills/memo', undefined, 'DELETE')).status, 200);

  const added = await api('/api/curiosity', { topic: 'Rust の所有権', why: '気になった' });
  assert.equal(added.status, 201);
  assert.equal((await api('/api/curiosity', { topic: 'Rust の所有権' })).status, 400, '重複');
  const made = await api(`/api/curiosity/${added.body.item.id}/task`, {});
  assert.equal(made.body.task.origin, 'curiosity');
  assert.equal((await api('/api/curiosity')).body.items[0].status, 'researching');
  assert.equal((await api(`/api/curiosity/${added.body.item.id}`, { status: 'nope' }, 'PATCH')).status, 400);

  s.app.conversations.create({ id: 'c9' });
  s.app.conversations.append('c9', { role: 'user', content: 'メモして' });
  assert.equal((await api('/api/reviews', { conversationId: 'c9' })).status, 202);
  assert.equal((await api('/api/reviews', { conversationId: 'c9' })).status, 200, '同じ発言では二度積まない');
  const jobs = await api('/api/reviews');
  assert.equal(jobs.body.pending, 1);
  assert.equal(jobs.body.jobs[0].triggerLabel, '手動');
});
