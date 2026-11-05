import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { en } from '../web/src/i18n/en.ts';
import { engineText } from '../src/shared/messages/engine.ts';
import { CONVERSATION, fakeModel, settled, startApp } from './app-setup.ts';
import type { ModelRequest } from '../src/providers/types.ts';
import type { Script } from './helpers.ts';

const isSummaryCall = (req: ModelRequest) => req.system.frozen.includes('要約係');

// 要約の呼び出しには要約を、それ以外は「道具を N 回呼んでから返事」で答える台本。要約を失敗させる回数なども決められる
function router(options: { tools: number; summaryFails?: (n: number) => boolean }) {
  let tools = 0;
  let summaries = 0;
  const calls = { summaries: [] as ModelRequest[], answers: [] as ModelRequest[] };
  const script: Script = async function* (req) {
    if (isSummaryCall(req)) {
      calls.summaries.push(req);
      summaries++;
      if (options.summaryFails?.(summaries)) throw new Error('要約に失敗');
      yield { type: 'text', delta: `- 要約 ${summaries} 回目` };
      yield { type: 'done', stop: 'end_turn' as StopReason };
      return;
    }
    calls.answers.push(req);
    if (tools < options.tools) {
      tools++;
      const call: ToolCall = { id: `call_${tools}`, name: 'file_read', arguments: { path: 'big.txt' } };
      yield { type: 'tool_call', call };
      yield { type: 'done', stop: 'tool_use' as StopReason };
      return;
    }
    yield { type: 'text', delta: '終わりました' };
    yield { type: 'done', stop: 'end_turn' as StopReason };
  };
  return { script, calls };
}

async function setup(t: { after: (fn: () => void) => void }, options: { tools: number; summaryFails?: (n: number) => boolean }) {
  const s = await startApp(t, { models: [fakeModel('m1', { contextLength: 32768, minContext: 4096, maxOutputTokens: 1024 })] });
  mkdirSync(s.paths.workspace, { recursive: true });
  writeFileSync(join(s.paths.workspace, 'big.txt'), 'う'.repeat(2000));
  const r = router(options);
  s.adapter().scripts.push(...Array.from({ length: 80 }, () => r.script));
  // 古い発言がたくさんある会話（小さい発言を何十も）
  for (let i = 0; i < 30; i++) {
    s.app.conversations.append(CONVERSATION, { role: 'user', content: `質問${i} ${'い'.repeat(300)}` });
    s.app.conversations.append(CONVERSATION, { role: 'assistant', content: `答え${i} ${'え'.repeat(300)}` });
  }
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  const run = async () => {
    const outcome = s.app.engine.send(CONVERSATION, '調べて');
    assert.ok(outcome.ok, JSON.stringify(outcome));
    await settled(s.app, outcome.runId);
    return outcome.runId;
  };
  return { s, r, events, run };
}

test('1 回の返事の中でも、外す発言が増えたら要約を重ねる（前の要約に足して 1 つに書き直す）', async t => {
  const { s, r, events, run } = await setup(t, { tools: 6 });
  const runId = await run();
  assert.equal(s.app.runs.get(runId)!.ok, 1);
  assert.ok(r.calls.summaries.length >= 2, `要約の呼び出しが ${r.calls.summaries.length} 回しかない`);
  assert.doesNotMatch((r.calls.summaries[0]!.messages[0] as { content: string }).content, /これまでの要約（これに足して/u, '1 回目は前の要約が無い');
  assert.match((r.calls.summaries[1]!.messages[0] as { content: string }).content, /これまでの要約（これに足して[\s\S]*要約 1 回目/u, '2 回目は前の要約に足す');
  const upto = s.app.conversations.get(CONVERSATION)!.summary_upto!;
  assert.ok(upto > 0);
  assert.match(s.app.conversations.get(CONVERSATION)!.summary!, /要約 \d 回目/u);
  assert.ok(JSON.parse(s.app.runs.get(runId)!.flags).includes('compacted'));
  void events;
});

test('お知らせは 1 回の実行で 1 回ずつ。件数は最後の数（要約した件数は実行の合計）に更新する', async t => {
  const { s, r, events, run } = await setup(t, { tools: 6 });
  await run();
  const compactions = events.filter((e): e is Extract<RunEvent, { type: 'compaction' }> => e.type === 'compaction');
  assert.ok(compactions.length >= 2, '要約が重なった');
  const totals = compactions.map(e => e.summarized);
  assert.deepEqual(totals, [...totals].sort((a, b) => a - b), '件数は増えていく（実行の合計）');
  assert.ok(new Set(totals).size === totals.length, '同じ件数のお知らせを繰り返さない');
  const trims = events.filter(e => e.type === 'warning' && e.code === 'context_trimmed').map(e => (e as { params?: { count?: number } }).params!.count);
  assert.equal(new Set(trims).size, trims.length, '「外しました」は同じ件数を繰り返さない');
  const messages = s.app.conversations.messages(CONVERSATION);
  const summarized = (s.app.conversations.get(CONVERSATION)!.summary_upto!);
  assert.equal(totals.at(-1), messages.filter(m => m.id <= summarized).length, '最後のお知らせの件数 = この実行で要約した発言の合計');
  void r;
});

test('要約に失敗したら、その実行のあいだは外すだけに戻す（要約を呼び続けない）。失敗のお知らせは 1 回', async t => {
  const { s, r, events, run } = await setup(t, { tools: 6, summaryFails: n => n >= 2 });
  const runId = await run();
  assert.equal(s.app.runs.get(runId)!.ok, 1, '要約に失敗しても実行は続く');
  assert.equal(r.calls.summaries.length, 2, '1 回目は成功・2 回目は失敗。その後は呼ばない');
  assert.equal(events.filter(e => e.type === 'warning' && e.code === 'compaction_failed').length, 1);
  assert.ok(events.some(e => e.type === 'warning' && e.code === 'context_trimmed'), '外すだけで続けた');
});

test('要約を重ねる回数には上限がある（1 回の実行で 5 回まで）。上限のあとは外すだけで、無限に繰り返さない', async t => {
  const { s, r, run } = await setup(t, { tools: 8 });
  const runId = await run();
  assert.equal(s.app.runs.get(runId)!.ok, 1);
  assert.equal(r.calls.summaries.length, 5, '上限まで使い切って止まる');
});

test('要約を重ねた実行でも、実行が終われば次の実行でまた要約できる（上限は実行ごと）', async t => {
  const { s, r, run } = await setup(t, { tools: 4 });
  await run();
  const first = r.calls.summaries.length;
  assert.ok(first >= 1);
  for (let i = 0; i < 40; i++) s.app.conversations.append(CONVERSATION, { role: 'user', content: `追加${i} ${'お'.repeat(400)}` });
  await run();
  assert.ok(r.calls.summaries.length > first, '2 回目の実行でも要約を呼べる');
});

test('要約を読む API: GET /api/conversations/:id/summary は要約と、どこまでの発言を要約したかを返す。要約が無ければ null', async t => {
  const { s, run } = await setup(t, { tools: 3 });
  const none = await s.json('/api/conversations/aaaaaaaa-0000-4000-8000-0000000000ff/summary', 'GET');
  assert.equal(none.status, 404);
  const fresh = await s.json('/api/conversations', 'POST', { title: '空' });
  const empty = await s.json(`/api/conversations/${fresh.body.conversation.id}/summary`, 'GET');
  assert.deepEqual({ status: empty.status, summary: empty.body.summary, upto: empty.body.upto }, { status: 200, summary: null, upto: null });
  await run();
  const got = await s.json(`/api/conversations/${CONVERSATION}/summary`, 'GET');
  assert.equal(got.status, 200);
  assert.match(got.body.summary, /要約 \d 回目/u);
  assert.equal(got.body.upto, s.app.conversations.get(CONVERSATION)!.summary_upto);
  assert.ok(got.body.summarizedMessages > 0, '要約した発言の件数');
  const listed = (await s.json('/api/conversations', 'GET')).body.conversations.find((c: { id: string }) => c.id === CONVERSATION);
  assert.equal(listed.has_summary, true, '一覧には要約の全文でなく、あるかどうかだけを返す');
  assert.ok(!('summary' in listed));
  assert.ok(!('snapshot' in listed), '一覧に固定の system の全文を載せない');
});

test('文: 要約したお知らせは「要約は会話のメニューから読める」「原文は過去の会話を探すで探せる」を分けて書く', () => {
  const sentence = engineText('ja', 'warn.compacted', { count: 5 });
  assert.match(sentence, /5 件/u);
  assert.match(sentence, /メニュー/u);
  assert.match(sentence, /過去の会話を探す/u);
  assert.match(ja['notice.compacted'](5), /メニュー.*過去の会話を探す/u);
  assert.match(en['notice.compacted'](5), /menu/iu);
  assert.match(engineText('en', 'warn.compacted', { count: 5 }), /menu/iu);
});
