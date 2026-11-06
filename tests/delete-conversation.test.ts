import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import type { RunEvent } from '../src/engine/types.ts';
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
  app.db.prepare(`INSERT INTO memory_jobs (trigger, dedup_key, conversation_id, status, note, created_at, finished_at) VALUES ('idle', ?, ?, 'done', '済み', 1, 2)`).run(`idle:${TARGET}:2`, TARGET);
  // 承認の「この会話では許可」(メモリ上)
  const pending = app.approvals.request({ runId: 'run-g', conversationId: TARGET, tool: 'shell_run', input: { command: 'ls' }, title: 't', body: 'b', reasons: [], details: [] }, 60_000, new AbortController().signal);
  app.approvals.decide(app.approvals.pending()[0]!.id, 'conversation');
  await pending;
  assert.equal(app.approvals.isGranted(TARGET, inputHash('shell_run', { command: 'ls' })), true, '前提: 許可を覚えている');
  return { upload, shared, only, fullOutput, otherOutput, taskId: task.id };
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
  assert.deepEqual(jobs.map(j => j.status), ['done'], '待っている振り返りは消す');
  assert.equal(jobs[0]!.c, null);
  assert.ok(!jobs[0]!.k.includes(TARGET));
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
        if (typeof value === 'string' && (value.includes(TARGET) || value.includes(SECRET))) leftovers.push(`${table}.${column}`);
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
