import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TRIGGER_LABEL } from '../src/memory/review.ts';
import type { ReviewJob, RunRow, ToolCallRow } from '../web/src/api.ts';
import { setLanguagePreference } from '../web/src/i18n/index.ts';
import { parseRoute, routeHash } from '../web/src/routes.ts';
import {
  changeLabel, decidedByLabel, decisionLabel, decisionTag, formatTokens, jobStatusLabel, jobTag, jobTriggerLabel, LOG_LIMIT, logHash, runDetail, runKindLabel,
  runSeconds, runStatus, toolStatus,
} from '../web/src/runlog-meta.ts';
import { toTab } from '../web/src/tabs.ts';
import { startScreenServer } from './screen-server.ts';

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'r', kind: 'chat', conversation_id: 'c', model_id: 'local', attempts: 1, started_at: 1, duration_ms: 3200, ok: 1, error_kind: null, error_message: null,
  input_tokens: 3200, output_tokens: 412, cache_read_tokens: 1100, est_prompt_tokens: 3300, flags: [], ...over,
});
const ja = () => setLanguagePreference('ja');
const en = () => setLanguagePreference('en');
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('実行の結果: 成功・失敗（種類を訳す）・実行中を分け、知らない種類はコードのまま出す', () => {
  ja();
  assert.deepEqual(runStatus(run()), { icon: 'check', tone: 'plain', label: '成功' });
  assert.deepEqual(runStatus(run({ ok: 0, error_kind: 'rate_limit' })), { icon: 'x', tone: 'bad', label: '利用制限' });
  assert.deepEqual(runStatus(run({ ok: 0, error_kind: 'something_new' })), { icon: 'x', tone: 'bad', label: 'something_new' });
  assert.deepEqual(runStatus(run({ ok: 0, error_kind: null })), { icon: 'x', tone: 'bad', label: 'エラー' });
  assert.deepEqual(runStatus(run({ ok: null })), { icon: 'loader', tone: 'wait', label: '実行中' });
  en();
  assert.equal(runStatus(run({ ok: 0, error_kind: 'context_overflow' })).label, 'Context too small');
  assert.equal(runStatus(run({ ok: null })).label, 'Running');
  ja();
});

test('トークンの短い書き方と、秒数・実行の種類', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1000), '1.0k');
  assert.equal(formatTokens(3249), '3.2k');
  assert.equal(formatTokens(70000), '70.0k');
  ja();
  assert.equal(runSeconds(3200), '3.2 秒');
  assert.equal(runSeconds(null), '—');
  assert.equal(runKindLabel('review'), '振り返り');
  assert.equal(runKindLabel('future_kind'), 'future_kind');
  en();
  assert.equal(runSeconds(41800), '41.8 s');
  assert.equal(runKindLabel('task'), 'Task');
  ja();
});

test('実行の詳細: 成功は入出力とキャッシュ、失敗は理由と試行。見積もりと印はどちらにも付く', () => {
  ja();
  assert.equal(runDetail(run()), '入 3.2k · 出 412 · キャッシュ 1.1k · 見積もり 3.3k');
  assert.equal(runDetail(run({ attempts: 3, flags: ['text_tool_calls', 'x'], cache_read_tokens: 0 })), '入 3.2k · 出 412 · 試行 3 · 見積もり 3.3k · text_tool_calls・x');
  assert.equal(runDetail(run({ ok: 0, error_message: '429 Too Many Requests', attempts: 3, input_tokens: null, output_tokens: null, cache_read_tokens: null, est_prompt_tokens: 4100 })), '429 Too Many Requests · 試行 3 · 見積もり 4.1k');
  assert.equal(runDetail(run({ ok: 0, error_message: '中止しました', attempts: 0, est_prompt_tokens: null })), '中止しました');
  assert.equal(runDetail(run({ ok: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, est_prompt_tokens: null })), '', '実行中で何も無ければ空');
  en();
  assert.equal(runDetail(run({ attempts: 2 })), 'in 3.2k · out 412 · cache 1.1k · 2 attempts · est. 3.3k');
  assert.equal(runDetail(run({ ok: 0, error_message: 'boom', attempts: 1, est_prompt_tokens: null })), 'boom · 1 attempt');
  ja();
});

test('道具の記録: 判定の札と、決めたのは誰かを訳す。知らない値はそのまま出す', () => {
  ja();
  assert.deepEqual((['allow', 'ask', 'deny'] as const).map(decisionLabel), ['許可', '承認を求めた', '拒否']);
  assert.deepEqual((['allow', 'ask', 'deny'] as const).map(decisionTag), ['tag-neutral', 'tag-accent', 'tag-outline']);
  assert.deepEqual(['builtin', 'registry', 'validation', 'user', 'conversation-grant'].map(decidedByLabel), ['組み込み', '道具の登録', '引数の検査', 'あなた', 'この会話の許可']);
  assert.equal(decidedByLabel('hook:no-lan'), 'フック no-lan');
  assert.equal(decidedByLabel('mystery'), 'mystery');
  assert.deepEqual(toolStatus(null), { icon: 'clock', tone: 'wait', label: '待ち' });
  assert.deepEqual(toolStatus(1), { icon: 'check', tone: 'plain', label: '成功' });
  assert.deepEqual(toolStatus(0), { icon: 'x', tone: 'bad', label: '失敗' });
  en();
  assert.equal(decisionLabel('ask'), 'Asked for approval');
  assert.equal(decidedByLabel('hook:no-lan'), 'Hook no-lan');
  assert.equal(toolStatus(null).label, 'Waiting');
  ja();
});

test('振り返りの記録: きっかけ・状態・変更の種類をコードから訳す', () => {
  ja();
  assert.equal(jobTriggerLabel('heavy_run'), '道具を多く使った');
  assert.equal(jobTriggerLabel('new_trigger'), 'new_trigger');
  assert.deepEqual((['pending', 'running', 'done', 'failed'] as ReviewJob['status'][]).map(jobStatusLabel), ['待ち', '実行中', '済み', '失敗']);
  assert.deepEqual((['pending', 'running', 'done', 'failed'] as ReviewJob['status'][]).map(jobTag), ['tag-neutral', 'tag-accent', 'tag-neutral', 'tag-outline']);
  assert.deepEqual(['create', 'update', 'forget', 'restore', 'other'].map(changeLabel), ['足した', '直した', '消した', '戻した', 'other']);
  en();
  assert.equal(jobTriggerLabel('idle'), 'The conversation went quiet');
  assert.equal(changeLabel('forget'), 'Deleted');
  ja();
});

test('コードの網羅: サーバーが作る種類は、すべて辞書に訳がある（足されたのに画面が知らない、を防ぐ）', () => {
  ja();
  const errorKinds = [...(/export type EngineErrorKind =([^;]*);/u.exec(source('src/engine/types.ts'))?.[1] ?? '').matchAll(/'([a-z_]+)'/gu)].map(m => m[1]!);
  assert.ok(errorKinds.length >= 7, `EngineErrorKind を読めた: ${errorKinds.join(',')}`);
  for (const kind of errorKinds) {
    for (const lang of [ja, en]) {
      lang();
      assert.notEqual(runStatus({ ok: 0, error_kind: kind }).label, kind, `${kind} の訳`);
    }
  }
  ja();
  const runKinds = [...(/export type RunKind =([^;]*);/u.exec(source('src/tools/types.ts'))?.[1] ?? '').matchAll(/'([a-z_]+)'/gu)].map(m => m[1]!);
  assert.deepEqual(runKinds.sort(), ['chat', 'review', 'task']);
  for (const kind of runKinds) assert.notEqual(runKindLabel(kind), kind);
  const pipeline = source('src/tools/pipeline.ts');
  const decidedBy = new Set([
    ...[...pipeline.matchAll(/decidedBy = '([a-z-]+)'/gu)].map(m => m[1]!),
    ...[...pipeline.matchAll(/refuse\('(?:allow|ask|deny)', '([a-z-]+)'/gu)].map(m => m[1]!),
    ...[...pipeline.matchAll(/decidedBy: '([a-z-]+)'/gu)].map(m => m[1]!),
  ]);
  assert.ok(decidedBy.size >= 5, `決めた人の値を読めた: ${[...decidedBy].join(',')}`);
  for (const by of decidedBy) for (const lang of [ja, en]) { lang(); assert.notEqual(decidedByLabel(by), by, `${by} の訳`); }
  assert.ok(source('src/tools/pipeline.ts').includes('`hook:${result.hook}`'), 'フックの名前は hook:<名前> の形');
  ja();
  for (const trigger of Object.keys(TRIGGER_LABEL)) {
    assert.equal(jobTriggerLabel(trigger), TRIGGER_LABEL[trigger as keyof typeof TRIGGER_LABEL], `${trigger}: 画面の訳はサーバーの日本語と同じ`);
    en();
    assert.notEqual(jobTriggerLabel(trigger), trigger);
    ja();
  }
});

test('経路: #/runs[/tools|/reviews] と、振り返りの実行中のリンク。#/review はタブにしない', () => {
  assert.deepEqual(parseRoute('#/runs'), { page: 'runs' });
  assert.deepEqual(parseRoute('#/runs/tools'), { page: 'runs', tab: 'tools' });
  assert.deepEqual(parseRoute('#/runs/reviews'), { page: 'runs', tab: 'reviews' });
  assert.deepEqual(parseRoute('#/runs/reviews?x=1'), { page: 'runs', tab: 'reviews' });
  assert.deepEqual(parseRoute('#/runs/unknown'), { page: 'runs' });
  assert.deepEqual(parseRoute('#/runsx'), { page: 'runs' }, '前方一致は今までどおり');
  for (const hash of ['#/runs', '#/runs/tools', '#/runs/reviews']) assert.equal(routeHash(parseRoute(hash)), hash);
  assert.equal(logHash('runs'), '#/runs');
  assert.equal(logHash('tools'), '#/runs/tools');
  assert.equal(logHash('reviews'), '#/runs/reviews');
  assert.deepEqual(toTab('#/runs/reviews'), { key: 'runs', hash: '#/runs/reviews' }, '実行ログのタブは 1 つで、開いている表を覚える');
  assert.equal(toTab('#/review'), null, '#/review は転送だけで、タブにしない');
  assert.deepEqual(parseRoute('#/review'), { page: 'review' });
});

test('画面が使う API: 実行・道具・振り返りの記録を、画面の読み取りで表にできる', async t => {
  ja();
  const s = await startScreenServer(t);
  const now = Date.now();
  s.app.db.prepare(`INSERT INTO engine_runs (id, kind, model_id, attempts, started_at, ended_at, duration_ms, ok, error_kind, error_message, est_prompt_tokens, flags)
    VALUES ('r-fail', 'task', 'local', 2, ?, ?, 900, 0, 'context_overflow', '長さが足りません', 70000, '["server_truncation_suspected"]')`).run(now, now + 900);
  s.app.db.prepare(`INSERT INTO engine_runs (id, kind, model_id, attempts, started_at, ok, flags) VALUES ('r-live', 'review', 'local', 1, ?, NULL, '[]')`).run(now + 1);
  const insertCall = s.app.db.prepare(`INSERT INTO tool_calls (id, run_id, tool, input, decision, decided_by, ok, created_at) VALUES (?, 'r-fail', ?, '{}', ?, ?, ?, ?)`);
  insertCall.run('k1', 'shell_run', 'ask', 'user', null, now);
  insertCall.run('k2', 'web_fetch', 'deny', 'hook:no-lan', 0, now + 1);
  s.app.reviews.enqueue('idle', 'k:1', { conversationId: 'c1' });
  s.app.reviews.finish(s.app.reviews.next()!.id, 'done', '変えるものはありませんでした');

  const runs = ((await (await s.api('/api/runs?limit=200')).json()) as { runs: RunRow[] }).runs;
  const live = runs.find(r => r.id === 'r-live')!;
  assert.deepEqual(runStatus(live), { icon: 'loader', tone: 'wait', label: '実行中' });
  const failed = runs.find(r => r.id === 'r-fail')!;
  assert.ok(Array.isArray(failed.flags), 'flags は配列で来る');
  assert.equal(runStatus(failed).label, '長さ不足');
  assert.equal(runKindLabel(failed.kind), 'タスク');
  assert.equal(runDetail(failed), '長さが足りません · 試行 2 · 見積もり 70.0k · server_truncation_suspected');

  const calls = ((await (await s.api('/api/tool-calls?limit=200')).json()) as { toolCalls: ToolCallRow[] }).toolCalls;
  assert.deepEqual(calls.map(c => c.id), ['k2', 'k1'], '新しい順');
  const denied = calls.find(c => c.id === 'k2')!;
  assert.deepEqual([decisionLabel(denied.decision), decidedByLabel(denied.decided_by), toolStatus(denied.ok).label], ['拒否', 'フック no-lan', '失敗']);
  const asked = calls.find(c => c.id === 'k1')!;
  assert.deepEqual([decisionLabel(asked.decision), decidedByLabel(asked.decided_by), toolStatus(asked.ok).label], ['承認を求めた', 'あなた', '待ち']);

  const reviews = (await (await s.api('/api/reviews')).json()) as { jobs: ReviewJob[]; pending: number };
  assert.equal(reviews.jobs.length, 1);
  assert.equal(jobTriggerLabel(reviews.jobs[0]!.trigger), '会話が途切れた');
  assert.equal(jobStatusLabel(reviews.jobs[0]!.status), '済み');
  assert.equal(reviews.pending, 0);
  assert.equal(LOG_LIMIT, 200, '画面が頼む件数の上限と、API の limit（200）は同じ');
  assert.ok(readFileSync(new URL('../web/src/api.ts', import.meta.url), 'utf8').includes('/api/tool-calls?limit=200'));
});
