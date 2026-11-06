import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_RESULT_RATIO, toolResultTokens } from '../src/engine/context-budget.ts';
import { ContextOverflow, fitMessages, groupExchanges, irreducibleEstimate } from '../src/engine/fit.ts';
import { estimateRequest, estimateTextTokens, prefixLength, SAFETY_MARGIN } from '../src/engine/tokens.ts';
import type { ChatMessage, ToolSpec } from '../src/engine/types.ts';

const tools: ToolSpec[] = [{ name: 'file_read', description: 'x'.repeat(400), inputSchema: { type: 'object' } }];
const exchange = (question: string, answer: string): ChatMessage[] => [{ role: 'user', content: question }, { role: 'assistant', content: answer }];

// ── prefixLength: 結果を切る長さは、estimateTextTokens と同じ数え方 ──

test('prefixLength: 英数字は 3.5 文字 1 トークン、日本語は 1 文字 1 トークンで数える', () => {
  assert.equal(prefixLength('a'.repeat(1000), 10_000, 100), 350);
  assert.equal(prefixLength('あ'.repeat(1000), 10_000, 100), 100);
  assert.equal(prefixLength('ab'.repeat(500), 10_000, Infinity), 1000, 'トークンの上限が無ければ全部');
  assert.equal(prefixLength('abc', 10_000, 100), 3, '短ければ全部');
});

test('prefixLength: 文字数の上限にも従い、先に達した方で止まる。上限は 0 でもよい', () => {
  assert.equal(prefixLength('a'.repeat(1000), 200, 10_000), 200);
  assert.equal(prefixLength('a'.repeat(1000), 10_000, 0), 0);
  assert.equal(prefixLength('あ'.repeat(1000), 50, 10_000), 50);
});

test('prefixLength: 切った先頭の見積もりは上限以下で、あと 1 文字足すと上限を超える（英数字・日本語・混ざった文）', () => {
  const mixed = Array.from({ length: 400 }, (_, i) => (i % 3 === 0 ? `第${i}回の議事録 ` : `file${i}.js\n`)).join('');
  for (const text of ['a'.repeat(5000), 'あ'.repeat(5000), mixed]) {
    for (const budget of [1, 7, 100, 777]) {
      const n = prefixLength(text, 100_000, budget);
      assert.ok(estimateTextTokens(text.slice(0, n)) <= budget, `${budget}: ${n}`);
      assert.ok(estimateTextTokens(text.slice(0, n + 1)) > budget, `${budget}: ${n} にもう 1 文字足すと超える`);
    }
  }
});

test('prefixLength: 2 単位の文字（サロゲートペア）の途中では切らない', () => {
  const emoji = '😀'.repeat(50);
  for (const maxChars of [1, 2, 3, 11, 12]) {
    const n = prefixLength(emoji, maxChars, 10_000);
    assert.equal(n % 2, 0, `${maxChars} 単位まで → ${n}`);
    assert.ok(n <= maxChars);
    assert.equal(emoji.slice(0, n), '😀'.repeat(n / 2), '壊れた文字が先頭に残らない');
  }
});

// ── toolResultTokens: 結果 1 つに許す量は、削れない分を引いた余裕から決まる ──

test('toolResultTokens: 余裕（available − 削れない分）の TOOL_RESULT_RATIO を、見積もりの単位（補正と安全率を割り戻す）で返す', () => {
  const room = 8000;
  assert.equal(toolResultTokens(14_540, 14_540 - room), Math.floor((room * TOOL_RESULT_RATIO) / SAFETY_MARGIN));
  assert.equal(toolResultTokens(14_540, 14_540 - room, 2), Math.floor((room * TOOL_RESULT_RATIO) / (2 * SAFETY_MARGIN)), '補正が大きい（見積もりが実際より小さく出る）モデルでは、その分少なく');
});

test('toolResultTokens: 固定の分（system・道具の仕様）が大きいほど、結果に許す量は小さくなる。余裕が無くても最低限は許す', () => {
  const available = 14_540;
  const amounts = [3000, 5800, 8000, 11_000, 14_000].map(fixed => toolResultTokens(available, fixed));
  for (let i = 1; i < amounts.length; i++) assert.ok(amounts[i]! <= amounts[i - 1]!, `固定 ${i}: ${amounts.join(' ')}`);
  assert.ok(amounts[0]! > amounts[2]!);
  assert.equal(toolResultTokens(available, available), toolResultTokens(available, available + 5000), '入りきらないほど大きくても、余裕は 0 として最低限');
  assert.ok(toolResultTokens(available, available) >= 500, '最低限は英数字で約 2,000 文字');
});

test('toolResultTokens: 結果を積んでいくと、1 つずつ小さくなり、何度積んでも使える量を超えない', () => {
  const available = 14_540;
  let used = 5_800;
  const taken: number[] = [];
  for (let i = 0; i < 6; i++) {
    const tokens = toolResultTokens(available, used);
    taken.push(tokens);
    used += Math.ceil((tokens + 12) * SAFETY_MARGIN);
    assert.ok(used < available, `${i + 1} 個目まで積んでも ${used} < ${available}`);
  }
  assert.ok(taken[0]! > taken[1]! && taken[1]! > taken[2]!, taken.join(' '));
});

// ── fit.ts: 削れない分と、古いやり取りの削り方 ──

test('irreducibleEstimate: 最後のやり取り 1 つ（user の発言から後）と system・道具の仕様だけを数える。古いやり取りは数えない', () => {
  const old = [...exchange('古い質問'.repeat(500), '古い答え'.repeat(500)), ...exchange('もう一つ前', 'はい')];
  const current: ChatMessage[] = [{ role: 'user', content: '今の質問' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'file_read', arguments: { path: 'a.txt' } }] }, { role: 'tool', toolCallId: 'c1', name: 'file_read', content: 'a'.repeat(3500) }];
  const alone = irreducibleEstimate({ system: 'S', messages: current, tools });
  assert.deepEqual(alone, estimateRequest('S', current, tools));
  assert.deepEqual(irreducibleEstimate({ system: 'S', messages: [...old, ...current], tools }), alone, '古い分は増やしても同じ');
  assert.deepEqual(irreducibleEstimate({ system: 'S', messages: [], tools }), estimateRequest('S', [], tools), '発言が無くても数えられる');
  assert.ok(irreducibleEstimate({ system: 'S', messages: current, tools, factor: 1.5 }).tokens > alone.tokens, '補正は掛かる');
});

test('fitMessages: 古いやり取りは外し、1 つしか残らなくなっても入らなければ ContextOverflow。その数は irreducibleEstimate と同じ', () => {
  const history = [...exchange('一つ目'.repeat(300), '答え'.repeat(300)), ...exchange('二つ目'.repeat(300), '答え'.repeat(300)), ...exchange('今の', 'はい')];
  const base = { system: 'S', tools };
  const all = estimateRequest('S', history, tools).tokens;
  const kept = fitMessages({ ...base, messages: history, available: all });
  assert.equal(kept.removed, 0, '入るなら何も外さない');
  const trimmed = fitMessages({ ...base, messages: history, available: irreducibleEstimate({ system: 'S', messages: history, tools }).tokens + 50 });
  assert.equal(trimmed.removed, history.length - 2, '古い 2 つのやり取りが外れ、いまのやり取りが残る');
  assert.equal(groupExchanges(trimmed.messages).length, 1);
  const floor = irreducibleEstimate({ system: 'S', messages: history, tools }).tokens;
  assert.throws(() => fitMessages({ ...base, messages: history, available: floor - 1 }), (e: unknown) => e instanceof ContextOverflow && e.required === floor && e.available === floor - 1, '入りきらないとき報告する数は、削れない分と同じ');
});
