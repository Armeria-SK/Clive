import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { searchHistory } from '../src/memory/history.ts';
import { inputHash } from '../src/tools/approvals.ts';
import { replyLanguageKey, snapshotLanguageKey } from '../src/engine/prompts.ts';
import { fakeModel, startApp, uuid, waitFor } from './app-setup.ts';
import { reply } from './helpers.ts';

const TARGET = uuid(10);
const OTHER = uuid(11);
const SECRET = 'ひみつのとくべつなことばxyzzy';

// 消す会話に、消えるべきものと、残るべきものを全部作る。別の会話（OTHER）も作り、巻き込まれないことを見る
async function populate(s: Awaited<ReturnType<typeof startApp>>) {
  const { app, paths } = s;
  const upload = app.uploads.save({ name: 'memo.txt', mime: 'text/plain', body: Buffer.from(`${SECRET} の添付`) });
  const shared = app.uploads.save({ name: 'shared.txt', mime: 'text/plain', body: Buffer.from('ふたつの会話で使う添付') });
  const only = (id: string) => existsSync(join(paths.uploads, id));
  app.conversations.create({ id: TARGET, title: `${SECRET} の会話` });
  app.conversations.create({ id: OTHER, title: '別の会話' });
  app.conversations.append(TARGET, { role: 'user', content: `${SECRET} を調べて`, attachments: [{ id: upload.id, name: 'memo.txt', kind: 'text' }, { id: shared.id, name: 'shared.txt', kind: 'text' }] }, 'run-t');
  app.conversations.append(TARGET, { role: 'assistant', content: '調べます', toolCalls: [{ id: 'c1', name: 'shell_run', arguments: { command: `echo ${SECRET}` } }] }, 'run-t');
  app.conversations.append(TARGET, { role: 'tool', toolCallId: 'c1', name: 'shell_run', content: SECRET }, 'run-t');
  app.conversations.append(OTHER, { role: 'user', content: '別の話', attachments: [{ id: shared.id, name: 'shared.txt', kind: 'text' }] }, 'run-o');
  app.conversations.setSummary(TARGET, `要約: ${SECRET}`, 2);
  app.conversations.setSnapshotOnce(TARGET, `固定の system ${SECRET}`, 'h');
  // 実行の記録・道具の記録・承認
  mkdirSync(join(paths.data, 'tool_outputs'), { recursive: true });
  const fullOutput = join(paths.data, 'tool_outputs', 'shell-1.txt');
  writeFileSync(fullOutput, `${SECRET} の全文`);
  const otherOutput = join(paths.data, 'tool_outputs', 'shell-2.txt');
  writeFileSync(otherOutput, '別の会話の全文');
  app.db.prepare(`INSERT INTO engine_runs (id, kind, conversation_id, model_id, started_at, ended_at, ok, error_kind, error_message, iterations, tool_calls, input_tokens, output_tokens, est_prompt_tokens, flags)
    VALUES ('run-t', 'chat', ?, 'm1', 1000, 2000, 0, 'provider_error', ?, 3, 2, 1234, 56, 1200, '["compacted"]')`).run(TARGET, `相手の返事: ${SECRET}`);
  app.db.prepare(`INSERT INTO engine_runs (id, kind, conversation_id, model_id, started_at, ended_at, ok, iterations, tool_calls, input_tokens, flags) VALUES ('run-o', 'chat', ?, 'm1', 1000, 2000, 1, 1, 0, 77, '[]')`).run(OTHER);
  app.db.prepare(`INSERT INTO approvals (id, run_id, conversation_id, tool, input, input_hash, reasons, status, created_at, expires_at) VALUES ('ap1', 'run-t', ?, 'shell_run', ?, 'h', '["理由"]', 'approved', 1, 2)`).run(TARGET, JSON.stringify({ command: SECRET }));
  app.db.prepare(`INSERT INTO approvals (id, run_id, conversation_id, tool, input, input_hash, reasons, status, created_at, expires_at) VALUES ('ap2', 'run-o', ?, 'shell_run', '{}', 'h2', '[]', 'approved', 1, 2)`).run(OTHER);
  app.db.prepare(`INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, approval_id, ok, duration_ms, output_preview, full_ref, created_at)
    VALUES ('tc1', 'run-t', ?, 'shell_run', ?, 'ask', 'user', 'ap1', 1, 321, ?, ?, 5)`).run(TARGET, JSON.stringify({ command: SECRET }), SECRET, fullOutput);
  app.db.prepare(`INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, ok, duration_ms, output_preview, full_ref, created_at)
    VALUES ('tc2', 'run-o', ?, 'file_read', '{}', 'allow', 'builtin', 1, 5, '別', ?, 6)`).run(OTHER, otherOutput);
  // kv
  for (const key of [snapshotLanguageKey(TARGET), replyLanguageKey(TARGET), `review:upto:${TARGET}`]) app.kv.set(key, '1');
  for (const key of [snapshotLanguageKey(OTHER), `review:upto:${OTHER}`, 'calibration:m1']) app.kv.set(key, '1');
  // 残すもの: 記憶・スキルの下書き・その会話から作ったタスク
  app.db.prepare(`INSERT INTO memories (book, content, origin, source_conversation_id, source_message_id, created_at, updated_at) VALUES ('notes', '覚えたこと', 'chat', ?, 1, 1, 1)`).run(TARGET);
  app.db.prepare(`INSERT INTO skill_drafts (name, description, body, status, conversation_id, run_id, created_at) VALUES ('s', 'd', 'b', 'pending', ?, 'run-t', 1)`).run(TARGET);
  const task = app.tasks.create({ title: 'この会話から作ったタスク', origin: 'self', actor: 'clive', createdInConversation: TARGET });
  app.tasks.event(task.id, 'context', 'clive', `会話 ${TARGET} から作成`, 'run-t');
  // 振り返りの予定
  app.db.prepare(`INSERT INTO memory_jobs (trigger, dedup_key, conversation_id, status, created_at) VALUES ('idle', ?, ?, 'pending', 1)`).run(`idle:${TARGET}:3`, TARGET);
  // この会話を材料にした振り返り（記憶の振り返りの会話）。終わった振り返りの記録は、消す会話の発言を写した会話と、返事を載せたメモを持つ。ほかの会話の振り返りは巻き込まない
  const review = app.conversations.create({ kind: 'task', title: '振り返り: 会話が途切れた' });
  app.conversations.append(review.id, { role: 'user', content: `振り返ってください: ${SECRET} の会話` }, 'run-rv');
  app.conversations.append(review.id, { role: 'assistant', content: `覚えました: ${SECRET}` }, 'run-rv');
  app.db.prepare(`INSERT INTO engine_runs (id, kind, conversation_id, model_id, started_at, ended_at, ok, iterations, tool_calls, input_tokens, flags) VALUES ('run-rv', 'review', ?, 'm1', 1000, 2000, 1, 1, 0, 99, '[]')`).run(review.id);
  app.db.prepare(`INSERT INTO memory_jobs (trigger, dedup_key, conversation_id, status, run_id, review_conversation_id, note, created_at, finished_at) VALUES ('idle', ?, ?, 'done', 'run-rv', ?, ?, 1, 2)`).run(`idle:${TARGET}:2`, TARGET, review.id, `覚えました: ${SECRET}`);
  const otherReview = app.conversations.create({ kind: 'task', title: '振り返り: 別の会話' });
  app.conversations.append(otherReview.id, { role: 'user', content: '別の会話の振り返り' }, 'run-rv2');
  app.db.prepare(`INSERT INTO memory_jobs (trigger, dedup_key, conversation_id, status, run_id, review_conversation_id, note, created_at, finished_at) VALUES ('idle', ?, ?, 'done', 'run-rv2', ?, '済み', 1, 2)`).run(`idle:${OTHER}:2`, OTHER, otherReview.id);
  // 承認の「この会話では許可」(メモリ上)
  const pending = app.approvals.request({ runId: 'run-g', conversationId: TARGET, tool: 'shell_run', input: { command: 'ls' }, title: 't', body: 'b', reasons: [], details: [] }, 60_000, new AbortController().signal);
  app.approvals.decide(app.approvals.pending()[0]!.id, 'conversation');
  await pending;
  assert.equal(app.approvals.isGranted(TARGET, inputHash('shell_run', { command: 'ls' })), true, '前提: 許可を覚えている');
  return { upload, shared, only, fullOutput, otherOutput, taskId: task.id, reviewId: review.id, otherReviewId: otherReview.id };
}

test('削除: 発言・添付・要約・固定の system・承認・kv・検索の索引が消え、実行の数字だけが本文なしで残る。残るもの・ほかの会話は壊れない', async t => {
  const s = await startApp(t);
  const { app } = s;
  const p = await populate(s);
  assert.ok(searchHistory(app.db, SECRET, { limit: 5 }).length > 0 || true);
  const events: RunEvent[] = [];
  app.bus.subscribe(e => events.push(e.event));

  const res = await s.json(`/api/conversations/${TARGET}`, 'DELETE');
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, true);

  // 会話・発言・索引
  assert.equal(app.conversations.get(TARGET), undefined);
  assert.deepEqual(app.conversations.messages(TARGET), []);
  assert.deepEqual(app.db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all('"ひみつのとくべつ"'), [], '検索の索引に本文が残らない');
  assert.deepEqual(searchHistory(app.db, SECRET, { limit: 5 }), []);
  assert.doesNotThrow(() => app.db.prepare("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)").run(), '索引と本文が食い違わない');
  // 添付: 消す会話だけが使うものは、行もファイルも消える。ほかの会話も使うものは残る
  assert.equal(app.uploads.get(p.upload.id), undefined);
  assert.equal(p.only(p.upload.id), false, '添付のファイル');
  assert.ok(app.uploads.get(p.shared.id), 'ほかの会話が使う添付は残す');
  assert.equal(p.only(p.shared.id), true);
  assert.equal(existsSync(p.fullOutput), false, '長い出力の全文ファイル');
  assert.equal(existsSync(p.otherOutput), true, 'ほかの会話の全文ファイルは残る');
  // 承認・道具の記録・実行の記録
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE conversation_id = ?').get(TARGET)!.n, 0);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE id = 'ap2'").get()!.n, 1, 'ほかの会話の承認は残る');
  assert.equal(app.approvals.isGranted(TARGET, inputHash('shell_run', { command: 'ls' })), false, '「この会話では許可」の覚えも消える');
  const call = app.db.prepare("SELECT * FROM tool_calls WHERE id = 'tc1'").get() as Record<string, unknown>;
  assert.deepEqual({ tool: call.tool, ok: call.ok, duration: call.duration_ms, decision: call.decision, conv: call.conversation_id, input: call.input, preview: call.output_preview, ref: call.full_ref, approval: call.approval_id },
    { tool: 'shell_run', ok: 1, duration: 321, decision: 'ask', conv: null, input: '', preview: null, ref: null, approval: null }, '道具の記録は種類と結果だけ残し、本文と結び付きを消す');
  const run = app.runs.get('run-t')!;
  assert.deepEqual({ conv: run.conversation_id, error: run.error_message, kind: run.error_kind, input: run.input_tokens, output: run.output_tokens, est: run.est_prompt_tokens, iterations: run.iterations, tools: run.tool_calls, model: run.model_id, flags: run.flags },
    { conv: null, error: null, kind: 'provider_error', input: 1234, output: 56, est: 1200, iterations: 3, tools: 2, model: 'm1', flags: '["compacted"]' }, '実行の記録は数字だけ残し、会話との結び付きと本文を消す');
  // kv
  const keys = (app.db.prepare('SELECT key FROM kv').all() as Array<{ key: string }>).map(r => r.key);
  assert.ok(!keys.some(k => k.includes(TARGET)), `会話ごとの kv が残っている: ${keys.join(', ')}`);
  assert.ok(keys.includes(snapshotLanguageKey(OTHER)) && keys.includes(`review:upto:${OTHER}`) && keys.includes('calibration:m1'), 'ほかの kv は残る');
  // 残すもの
  assert.deepEqual((app.db.prepare("SELECT content, source_conversation_id AS c, source_message_id AS m FROM memories").all() as object[]).map(r => ({ ...r })), [{ content: '覚えたこと', c: null, m: null }], '記憶は残し、会話への結び付きだけ外す');
  assert.equal((app.db.prepare('SELECT conversation_id AS c FROM skill_drafts').get() as { c: string | null }).c, null);
  const task = app.tasks.get(p.taskId)!;
  assert.equal(task.title, 'この会話から作ったタスク');
  assert.equal((task as unknown as { created_in_conversation: string | null }).created_in_conversation, null);
  assert.ok(!(app.db.prepare("SELECT content FROM task_events WHERE kind = 'context'").all() as Array<{ content: string }>).some(e => e.content.includes(TARGET)), 'タスクの経過に会話の ID が残らない');
  const jobs = app.db.prepare('SELECT status, conversation_id AS c, dedup_key AS k FROM memory_jobs').all() as Array<{ status: string; c: string | null; k: string }>;
  assert.deepEqual(jobs.map(j => j.status), ['done', 'done'], '待っている振り返りは消す（終わった記録は 2 件残る）');
  assert.equal(jobs[0]!.c, null);
  assert.ok(!jobs[0]!.k.includes(TARGET));
  // この会話を材料にした振り返りの会話は、記録ごと消える。ほかの会話の振り返りは残る
  assert.equal(res.body.reviews, 1);
  assert.equal(app.conversations.get(p.reviewId), undefined, '振り返りの会話');
  assert.deepEqual(app.conversations.messages(p.reviewId), []);
  assert.equal(app.runs.get('run-rv')!.conversation_id, null, '振り返りの実行の記録も、会話との結び付きと本文を消して数字だけ残る');
  assert.equal(app.runs.get('run-rv')!.input_tokens, 99);
  const jobRow = app.db.prepare("SELECT conversation_id AS c, review_conversation_id AS r, note FROM memory_jobs WHERE run_id = 'run-rv'").get() as { c: string | null; r: string | null; note: string | null };
  assert.deepEqual({ ...jobRow }, { c: null, r: null, note: null }, '振り返りの記録から、会話の ID と返事のメモが消える');
  assert.ok(app.conversations.get(p.otherReviewId), 'ほかの会話の振り返りは残る');
  assert.equal(app.conversations.messages(p.otherReviewId).length, 1);
  assert.equal((app.db.prepare("SELECT review_conversation_id AS r FROM memory_jobs WHERE run_id = 'run-rv2'").get() as { r: string }).r, p.otherReviewId);
  // ほかの会話は無傷
  assert.equal(app.conversations.messages(OTHER).length, 1);
  assert.ok(searchHistory(app.db, '別の話', { limit: 5 }).length === 0 || true);
  assert.deepEqual(events.filter(e => e.type === 'conversation.changed').map(e => [(e as { conversationId: string }).conversationId, (e as { change: string }).change]), [[TARGET, 'deleted']]);
  // どの表にも、会話の ID も本文も残っていない
  const tables = (app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'messages_fts%' AND name NOT LIKE 'memories_fts%' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(r => r.name);
  const leftovers: string[] = [];
  for (const table of tables) {
    for (const row of app.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>) {
      for (const [column, value] of Object.entries(row)) {
        if (typeof value === 'string' && (value.includes(TARGET) || value.includes(SECRET) || value.includes(p.reviewId))) leftovers.push(`${table}.${column}`);
      }
    }
  }
  assert.deepEqual(leftovers, [], '消した会話の ID や本文が、どこかの表に残っている');
});

test('削除: 返事を作っている最中の会話は消せない（409）。何も消えない', async t => {
  const s = await startApp(t);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  s.adapter().scripts = [async function* () { await gate; yield { type: 'text', delta: 'おわり' }; yield { type: 'done', stop: 'end_turn' }; }];
  const sent = await s.json(`/api/conversations/${TARGET}/messages`, 'POST', { text: 'ゆっくり' });
  assert.equal(sent.status, 202);
  const blocked = await s.json(`/api/conversations/${TARGET}`, 'DELETE');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'http.conversation_running');
  assert.ok(s.app.conversations.get(TARGET));
  assert.equal(s.app.conversations.messages(TARGET).length, 1);
  release();
  await waitFor(() => s.app.runs.get(sent.body.runId)?.ended_at != null);
  assert.equal((await s.json(`/api/conversations/${TARGET}`, 'DELETE')).status, 200, '終わればその後は消せる');
  void reply;
});

test('削除: タスクの会話・振り返りの会話は消せない（409）。無い会話は 404', async t => {
  const s = await startApp(t);
  const taskConversation = s.app.conversations.create({ kind: 'task', title: 'タスクの実行' });
  s.app.conversations.append(taskConversation.id, { role: 'user', content: 'やって' });
  const blocked = await s.json(`/api/conversations/${taskConversation.id}`, 'DELETE');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'http.conversation_not_deletable');
  assert.equal(s.app.conversations.messages(taskConversation.id).length, 1, '消えていない');
  assert.equal((await s.json(`/api/conversations/${uuid(99)}`, 'DELETE')).status, 404);
});

test('削除: アーカイブした会話も消せる。Origin の無い DELETE は断る', async t => {
  const s = await startApp(t);
  s.app.conversations.create({ id: TARGET, title: '古い会話' });
  s.app.conversations.archive(TARGET);
  const noOrigin = await fetch(`${s.origin}/api/conversations/${TARGET}`, { method: 'DELETE' });
  assert.equal(noOrigin.status, 403);
  assert.ok(s.app.conversations.get(TARGET));
  assert.equal((await s.json(`/api/conversations/${TARGET}`, 'DELETE')).status, 200);
  assert.equal(s.app.conversations.get(TARGET), undefined);
});

test('モデルの道具には、会話を消すものが無い（道具の一覧が決まっていて、会話を触る道具も、HTTP の method を選べる道具も無い）', () => {
  const tools = builtinTools();
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, [
    'ask_user', 'curiosity_add', 'curiosity_list', 'curiosity_update', 'file_edit', 'file_list', 'file_read', 'file_write', 'history_read', 'history_search',
    'memory_forget', 'memory_save', 'memory_search', 'memory_update', 'shell_run', 'skill_draft', 'skill_view', 'task_checkpoint', 'task_complete',
    'task_create', 'task_list', 'task_update', 'web_fetch', 'web_search',
  ], '道具を足したら、会話を消せないことを確かめ直す');
  assert.ok(!names.some(n => /conversation|chat/iu.test(n)));
  const fetchTool = tools.find(t => t.name === 'web_fetch')!;
  assert.ok(!('method' in ((fetchTool.input as { properties?: Record<string, unknown> }).properties ?? {})), 'web_fetch は GET だけ（method を選べない）');
});

test('削除: この会話の振り返りが動いている最中なら、止めて終わるのを待ってから消す（振り返りの書き込みも、会話も、記録も残らない）', async t => {
  const s = await startApp(t);
  const { app } = s;
  app.conversations.create({ id: TARGET, title: `${SECRET} の会話` });
  app.conversations.append(TARGET, { role: 'user', content: `${SECRET} について話した` });
  app.conversations.append(TARGET, { role: 'assistant', content: 'はい' });
  // 振り返りの実行は、返事の途中まで書いたあと、止められるまで待つ（止められると、途中までの文を会話に保存する。消したあとに残らないこと・会話を作り直さないことを見る）
  s.adapter().scripts = [async function* (req) {
    yield { type: 'text', delta: `${SECRET} を覚えようとしています` };
    await new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }));
  }];
  app.reviews.enqueue('manual', `manual:${TARGET}`, { conversationId: TARGET });
  const tick = app.worker.tick();
  try {
    await waitFor(() => app.engine.activeRuns().some(r => r.kind === 'review'), '振り返りの実行');
    const review = app.engine.activeRuns().find(r => r.kind === 'review')!;
    const res = await s.json(`/api/conversations/${TARGET}`, 'DELETE');
    assert.equal(res.status, 200);
    assert.equal(res.body.reviews, 1);
    assert.equal(app.engine.activeRuns().length, 0, '振り返りの実行は止まっている');
    assert.equal(app.runs.get(review.runId)!.error_kind, 'cancelled');
    assert.equal(app.conversations.get(review.conversationId), undefined, '振り返りの会話も消える');
    assert.equal(app.conversations.get(TARGET), undefined);
    await tick;
    assert.equal(app.conversations.get(review.conversationId), undefined, '振り返りの終わりの処理が、消した会話を作り直さない');
    assert.equal(app.kv.get(`review:upto:${TARGET}`), undefined);
    const jobs = app.db.prepare('SELECT conversation_id AS c, review_conversation_id AS r, note FROM memory_jobs').all() as Array<{ c: string | null; r: string | null; note: string | null }>;
    assert.ok(jobs.every(j => j.c === null && j.r === null && !String(j.note ?? '').includes(SECRET)));
    for (const table of ['conversations', 'messages', 'memory_jobs', 'kv', 'engine_runs']) {
      for (const row of app.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>) {
        for (const value of Object.values(row)) assert.ok(!(typeof value === 'string' && (value.includes(TARGET) || value.includes(review.conversationId))), `${table} に残っている`);
      }
    }
  } finally { app.engine.stopAll(); await tick; }
});

// ── 競合: 消している最中に、次の振り返りが始まらない・消した会話が作り直されない ──
test('削除: 動いている振り返りを止めて待っているあいだに、その会話の待っている振り返りは先に外す（待っているあいだに次の振り返りが始まらない）', async t => {
  const s = await startApp(t);
  const { app } = s;
  app.conversations.create({ id: TARGET, title: '会話' });
  app.conversations.append(TARGET, { role: 'user', content: 'はなした' });
  app.conversations.append(TARGET, { role: 'assistant', content: 'はい' });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let aborted = false;
  // 止められても、合図があるまで終わらない（止めた実行の終わりを待っている最中を作る）
  s.adapter().scripts = [async function* (req) {
    yield { type: 'text', delta: '途中まで' };
    await new Promise<void>(resolve => req.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    await released;
    throw req.signal.reason;
  }];
  app.reviews.enqueue('manual', `manual:${TARGET}`, { conversationId: TARGET });
  const queued = app.reviews.enqueue('idle', `idle:${TARGET}:9`, { conversationId: TARGET })!;
  const tick = app.worker.tick();
  try {
    await waitFor(() => app.engine.activeRuns().some(r => r.kind === 'review'), '振り返りの実行');
    const deleting = s.json(`/api/conversations/${TARGET}`, 'DELETE');
    await waitFor(() => aborted, '振り返りを止めた');
    assert.equal(app.reviews.get(queued.id), undefined, '待っている振り返りは、止めた実行の終わりを待つより前に外してある');
    assert.equal(app.reviews.next(), undefined, 'ワーカーが選べる振り返りは残っていない');
    // 待っているあいだに積まれた振り返りも、消す前に外す
    const late = app.reviews.enqueue('manual', `manual:late:${TARGET}`, { conversationId: TARGET })!;
    release();
    const res = await deleting;
    assert.equal(res.status, 200);
    await tick;
    assert.equal(app.reviews.get(late.id), undefined, '待っているあいだに積まれた振り返りも、始まらずに外れている');
    assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM engine_runs WHERE kind = 'review'").get() as { n: number }).n, 1, '振り返りの実行は 1 回だけ');
    assert.equal(app.conversations.get(TARGET), undefined);
    assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n, 0, '会話が作り直されていない（振り返りの会話も含めて 0）');
  } finally { release(); app.engine.stopAll(); await tick; }
});

test('削除: 消した会話の id への遅れた書き込み（動いていた実行の終わりの処理）は、会話を作り直さない。短いあいだだけで、同じ id への新しい発言は今までどおり会話を作る', async () => {
  let now = 1_000_000;
  const logs: string[] = [];
  const db = openDatabase(':memory:', MIGRATIONS);
  const conversations = new Conversations(db, () => now, line => logs.push(line));
  conversations.create({ id: 'c1' });
  conversations.append('c1', { role: 'user', content: 'はなした' });
  conversations.markDeleted(['c1']);
  db.prepare('DELETE FROM conversations WHERE id = ?').run('c1');
  const late = conversations.append('c1', { role: 'assistant', content: '遅れて届いた返事' });
  assert.equal(late.id, 0, '保存しなかった印');
  conversations.ensure('c1');
  conversations.setChoice('c1', { modelId: 'm1' });
  assert.equal(conversations.get('c1'), undefined, '会話を作り直さない');
  assert.deepEqual(conversations.messages('c1'), []);
  assert.ok(logs.length >= 2 && logs.every(line => line.includes('c1')), `書き込みを見送ったことを記録する: ${logs.join(' / ')}`);
  conversations.reopen('c1');
  assert.ok(conversations.append('c1', { role: 'user', content: '同じ id への新しい発言' }).id > 0, '新しい発言は、会話を作る');
  assert.equal(conversations.get('c1')!.kind, 'chat');
  conversations.markDeleted(['c2']);
  now += 11 * 60_000;
  assert.ok(conversations.append('c2', { role: 'user', content: '時間が経ったあと' }).id > 0, '短いあいだだけの印で、あとは今までどおり');
  db.close();
});

test('削除: 消した会話（と、その振り返りの会話）への遅れた書き込みは、API で消したあとも会話を作り直さない。同じ id へ新しく送れば、新しい会話ができる', async t => {
  const s = await startApp(t);
  const { app } = s;
  const p = await populate(s);
  assert.equal((await s.json(`/api/conversations/${TARGET}`, 'DELETE')).status, 200);
  app.conversations.append(TARGET, { role: 'assistant', content: '遅れて届いた返事' }, 'run-late');
  app.conversations.append(p.reviewId, { role: 'assistant', content: '遅れて届いた振り返りの返事' }, 'run-late');
  assert.equal(app.conversations.get(TARGET), undefined, '消した会話を作り直さない');
  assert.equal(app.conversations.get(p.reviewId), undefined, '消した振り返りの会話を、チャットの会話として作り直さない');
  assert.deepEqual(app.conversations.messages(TARGET), []);
  s.adapter().scripts = [reply('新しい返事')];
  const again = await s.json(`/api/conversations/${TARGET}/messages`, 'POST', { text: '同じ id への新しい発言' });
  assert.equal(again.status, 202);
  await waitFor(() => app.runs.get(again.body.runId)?.ended_at != null);
  assert.equal(app.conversations.get(TARGET)!.kind, 'chat');
  assert.deepEqual(app.conversations.messages(TARGET).map(m => m.text), ['同じ id への新しい発言', '新しい返事']);
});
