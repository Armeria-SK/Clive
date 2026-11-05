import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig, ModelConfig } from '../src/config/schema.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { CONTEXT_FILL_RATIO, MEMORY_BUDGET_RATIO } from '../src/engine/chat.ts';
import { estimateTextTokens } from '../src/engine/tokens.ts';
import { bookPressureText } from '../src/memory/review.ts';
import { MemoryError, MemoryStore, planBooks, renderBooks, type Memory } from '../src/memory/store.ts';
import { resolvePaths } from '../src/paths.ts';
import { storeText } from '../src/shared/messages/stores.ts';
import { FakeAdapter, reply, tempDir, testConfig } from './helpers.ts';

const DAY = 86_400_000;
const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;

function store() {
  const db = openDatabase(':memory:', MIGRATIONS);
  let now = 1_000;
  return { db, memory: new MemoryStore(db, () => now++) };
}

const mem = (id: number, book: 'user' | 'notes', content: string, updatedAt: number): Memory => ({
  id, book, content, status: 'active', origin: 'chat', source_conversation_id: null, source_message_id: null, created_at: id, updated_at: updatedAt,
});

function smallestBudgetShowing(memories: readonly Memory[], count: number, language: 'ja' | 'en' = 'ja'): number {
  for (let budget = 0; budget < 100_000; budget++) if (planBooks(memories, language, budget).shown.length >= count) return budget;
  throw new Error('入る予算が見つかりません');
}

// ── 保存は断らない ──

test('記憶: 本の大きさに上限は無く、保存は断らない。1 件 600 文字の上限だけが残る', () => {
  const { memory } = store();
  for (let i = 0; i < 40; i++) memory.save({ book: 'user', content: `${String(i).padStart(3, '0')}${'あ'.repeat(550)}`, actor: 'clive' });
  assert.equal(memory.used('user'), 40 * 553, '以前の上限（ユーザーについて 2,000 文字）を大きく超えても保存できる');
  const first = memory.list('user')[0]!;
  assert.doesNotThrow(() => memory.update(first.id, 'x'.repeat(600), 'clive'), '書き直しも断らない');
  assert.throws(() => memory.save({ book: 'notes', content: 'y'.repeat(601), actor: 'clive' }), (e: unknown) => e instanceof MemoryError && e.code === 'memory.too_long');
  const { eventId } = memory.forget(first.id, 'user');
  assert.doesNotThrow(() => memory.undo(eventId), '消したものを戻すときも、大きさでは断らない');
  assert.equal(Object.keys(storeText.tables.ja).some(key => key.includes('over_cap')), false, '上限のエラーの文は表に無い');
  assert.equal(Object.keys(storeText.tables.en).some(key => key.includes('over_cap')), false);
});

// ── 会話に入れる量の予算 ──

test('renderBooks: 予算が無ければ全部入る（今までの出力のまま）。予算を渡さない呼び出しも同じ', () => {
  const memories = [mem(1, 'user', '紅茶が好き', 100), mem(2, 'notes', '返事は短く', 200)];
  const text = renderBooks(memories);
  assert.equal(text, '# 覚えていること（記憶）\n\n## ユーザーについての記憶\n- [u1] 紅茶が好き\n\n## Clive のメモと教訓\n- [n2] 返事は短く');
  assert.equal(renderBooks(memories, 'ja', undefined), text);
  assert.equal(planBooks(memories, 'ja').omitted.length, 0);
});

test('renderBooks: 予算まで、新しく直した順に入れ、入らなかった分は「ほか N 件」の 1 行にする', () => {
  const memories = [
    mem(1, 'user', `古い事実${'あ'.repeat(40)}`, 100),
    mem(2, 'notes', `中くらい${'い'.repeat(40)}`, 200),
    mem(3, 'user', `新しい事実${'う'.repeat(40)}`, 300),
  ];
  const budget1 = smallestBudgetShowing(memories, 1);
  const one = planBooks(memories, 'ja', budget1);
  assert.deepEqual(one.shown.map(m => m.id), [3], '直したのが新しいものから入る');
  assert.deepEqual(one.omitted.map(m => m.id), [1, 2], '入らなかった分は古い順');
  assert.match(one.text, /\[u3\] 新しい事実/u);
  assert.doesNotMatch(one.text, /\[u1\]|\[n2\]/u);
  assert.ok(one.text.endsWith('（ほか 2 件。memory_search で探せます）'), one.text);
  assert.ok(estimateTextTokens(one.text) <= budget1 + 30, '予算の目安を、見出しと「ほか」の 1 行の分を除いて超えない');

  const budget2 = smallestBudgetShowing(memories, 2);
  const two = planBooks(memories, 'ja', budget2);
  assert.deepEqual(two.shown.map(m => m.id), [2, 3], '新しい 2 件。本の中の並びは今までどおり（作った順）');
  assert.match(two.text, /## ユーザーについての記憶\n- \[u3\][^\n]*\n\n## Clive のメモと教訓\n- \[n2\][^\n]*\n\n（ほか 1 件。memory_search で探せます）$/u);

  const all = planBooks(memories, 'ja', smallestBudgetShowing(memories, 3));
  assert.equal(all.omitted.length, 0);
  assert.equal(all.text, renderBooks(memories), '全部入るなら、予算なしと同じ文');
  assert.equal(all.tokens, estimateTextTokens(renderBooks(memories)), 'tokens は全部を入れたときの見積もり（予算とは関係ない）');
});

test('renderBooks: 新しい順に数えて、入らない 1 件で止める（古い小さな記憶だけが飛び越して入ることはない）', () => {
  const memories = [mem(1, 'user', '小さな古い記憶', 100), mem(2, 'user', 'あ'.repeat(500), 200)];
  const bigCost = estimateTextTokens(planBooks([memories[1]!], 'ja', 100_000).text);
  const plan = planBooks(memories, 'ja', bigCost - 5);
  assert.deepEqual(plan.shown.map(m => m.id), [], '新しい大きな記憶が入らないなら、その後ろは数えない');
  assert.deepEqual(plan.omitted.map(m => m.id), [1, 2], '入らなかった分は古い順');
  assert.match(plan.text, /^# 覚えていること（記憶）\n\n（ほか 2 件。memory_search で探せます）$/u);
  assert.equal(planBooks(memories, 'ja', 0).shown.length, 0, '予算が 0 でも壊れない');
});

test('renderBooks: 直した時刻が同じなら、あとの id が新しい。消した記憶は数えない。英語に日本語は混ざらない', () => {
  const memories = [mem(1, 'user', 'first', 100), mem(2, 'user', 'second', 100), { ...mem(3, 'user', 'forgotten', 500), status: 'forgotten' as const }];
  const plan = planBooks(memories, 'en', smallestBudgetShowing(memories, 1, 'en'));
  assert.deepEqual(plan.shown.map(m => m.id), [2]);
  assert.deepEqual(plan.omitted.map(m => m.id), [1]);
  assert.ok(plan.text.endsWith('(1 more. You can find them with memory_search)'), plan.text);
  assert.doesNotMatch(plan.text, CJK);
  assert.equal(storeText('ja', 'memory.more', { n: 3 }), '（ほか 3 件。memory_search で探せます）');
});

// ── 予算の計算（エンジン）と、会話の最初の固定 ──

async function setup(t: { after: (fn: () => void) => void }, edit: (c: AppConfig) => void = () => undefined) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [
    { id: 'fa', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 },
    { id: 'fb', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:2/v1', maxParallel: 1, timeoutMs: 10_000 },
  ];
  config.models = [model('big', 'fa', 65536)];
  config.routing = { chat: ['big'], background: ['big'], retriesPerModel: 0 };
  edit(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-05T01:00:00Z') };
  const adapters = new Map<string, FakeAdapter>();
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false,
    adapterOverride: p => { const a = new FakeAdapter(p); adapters.set(p.id, a); return a; },
  });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  const reprobe = () => app.status.probeAll(app.config());
  let serial = 0;
  const fill = (count: number, chars = 600) => {
    for (let i = 0; i < count; i++) {
      serial++;
      const { memory } = app.memory.save({ book: serial % 2 ? 'user' : 'notes', content: `${String(serial).padStart(2, '0')}${'あ'.repeat(chars - 2)}`, actor: 'user' });
      app.db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(1_000 + serial, memory.id);
    }
  };
  return { app, adapters, adapter: (id = 'fa') => adapters.get(id)!, clock, reprobe, fill, paths };
}

const model = (id: string, provider: string, contextLength: number | undefined, over: Partial<ModelConfig> = {}): ModelConfig => ({
  id, provider, model: id, ...(contextLength === undefined ? {} : { contextLength }), minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false, ...over,
});

// 容量が書かれていない（Anthropic）モデルで、確認の結果にも長さが無い場合
const anthropicWithoutLength = (c: AppConfig) => {
  c.providers = [{ id: 'fa', kind: 'anthropic', maxParallel: 1, timeoutMs: 10_000 }];
  c.models = [model('nolen', 'fa', undefined)];
  c.routing = { chat: ['nolen'], background: ['nolen'], retriesPerModel: 0 };
};

const availableOf = (contextLength: number, maxOutputTokens = 1024) => Math.floor(contextLength * CONTEXT_FILL_RATIO) - maxOutputTokens;

test('記憶の予算: チャットと裏方で使えるモデルの、いちばん小さい available の 12%', async t => {
  const s = await setup(t, c => { c.models = [model('big', 'fa', 65536), model('small', 'fb', 20_000)]; });
  assert.equal(MEMORY_BUDGET_RATIO, 0.12);
  assert.equal(s.app.engine.memoryBudget(), Math.floor(availableOf(65536) * 0.12), 'チャットも裏方も大きいモデルだけ');

  const config = s.app.config();
  config.routing = { chat: ['big'], background: ['small'], retriesPerModel: 0 };
  await s.app.applyConfig(config);
  assert.equal(s.app.engine.memoryBudget(), Math.floor(availableOf(20_000) * 0.12), '裏方に小さいモデルがあれば、そちらに合わせる');

  config.routing = { chat: ['small'], background: [], retriesPerModel: 0 };
  await s.app.applyConfig(config);
  assert.equal(s.app.engine.memoryBudget(), Math.floor(availableOf(20_000) * 0.12), '裏方が空ならチャットと同じ');

  config.routing = { chat: [], background: [], retriesPerModel: 0 };
  await s.app.applyConfig(config);
  assert.equal(s.app.engine.memoryBudget(), Math.floor(availableOf(20_000) * 0.12), '順番が空なら設定のモデル全部で見る');
});

test('記憶の予算: 使えないモデルは数えない。使えるモデルが無い・容量が分からない・モデルが 0 個なら、予算なし（0 にはならない）', async t => {
  const s = await setup(t, c => { c.models = [model('big', 'fa', 65536), model('small', 'fb', 20_000)]; c.routing = { chat: ['big'], background: ['small'], retriesPerModel: 0 }; });
  s.adapter('fb').probeResult = { status: 'unreachable', message: 'x' };
  await s.reprobe();
  assert.equal(s.app.engine.memoryBudget(), Math.floor(availableOf(65536) * 0.12), '確認が通らなかったモデルは数えない');

  s.adapter('fa').probeResult = { status: 'unreachable', message: 'x' };
  await s.reprobe();
  assert.equal(s.app.engine.memoryBudget(), undefined, '使えるモデルが 1 つも無ければ予算なし');

  const unknown = await setup(t, anthropicWithoutLength);
  unknown.adapter('fa').probeResult = { effective: undefined as unknown as number };
  await unknown.reprobe();
  assert.equal(unknown.app.status.usable('nolen'), true);
  assert.equal(unknown.app.engine.memoryBudget(), undefined, '容量が分からないモデルだけなら、0 の予算で全部を切り落とさず、予算なし');

  const none = await setup(t, c => { c.models = []; c.routing = { chat: [], background: [], retriesPerModel: 0 }; });
  assert.equal(none.app.engine.memoryBudget(), undefined, 'モデルが 0 個なら予算なし');
});

test('会話の最初に固定する system には、予算まで（新しく直した順）の記憶が入り、「ほか N 件」の 1 行が付く', async t => {
  const s = await setup(t, c => { c.models = [model('big', 'fa', 20_000)]; });
  s.fill(6);
  const budget = s.app.engine.memoryBudget()!;
  assert.equal(budget, Math.floor(availableOf(20_000) * 0.12));
  const plan = planBooks(s.app.memory.list(), 'ja', budget);
  assert.ok(plan.shown.length >= 1 && plan.omitted.length >= 1, `予算で切れる量にしてある: shown=${plan.shown.length} omitted=${plan.omitted.length}`);

  s.adapter().scripts.push(reply('はい'));
  const sent = s.app.engine.send('c1', 'やあ');
  assert.ok(sent.ok);
  await s.app.engine.wait(sent.runId);
  const frozen = s.adapter().calls[0]!.system.frozen;
  for (const m of plan.shown) assert.ok(frozen.includes(`[${m.book === 'user' ? 'u' : 'n'}${m.id}] `), `入るはずの記憶 ${m.id}`);
  for (const m of plan.omitted) assert.ok(!frozen.includes(`[${m.book === 'user' ? 'u' : 'n'}${m.id}] `), `入らないはずの記憶 ${m.id}`);
  assert.ok(frozen.includes(`（ほか ${plan.omitted.length} 件。memory_search で探せます）`));
  const newest = s.app.memory.list().reduce((a, b) => (b.updated_at > a.updated_at ? b : a));
  assert.ok(plan.shown.some(m => m.id === newest.id), 'いちばん新しく直したものは必ず入る');

  s.fill(1);
  s.adapter().scripts.push(reply('はい'));
  const again = s.app.engine.send('c1', 'もう一度');
  assert.ok(again.ok);
  await s.app.engine.wait(again.runId);
  assert.equal(s.adapter().calls[1]!.system.frozen, frozen, 'すでに固定した会話の system は、あとで記憶や予算が変わっても変わらない');
});

test('baseTokens: 記憶は予算までしか数えない（以前の上限の見込みは足さない）', async t => {
  const s = await setup(t, c => { c.models = [model('big', 'fa', 20_000)]; });
  const empty = s.app.baseTokens();
  s.fill(8);
  const budget = s.app.engine.memoryBudget()!;
  const grown = s.app.baseTokens() - empty;
  assert.ok(grown > 0, '記憶が増えれば base も増える');
  assert.ok(grown <= budget + 40, `増える分は予算（${budget}）を超えない: ${grown}`);
});

// ── 整理の振り返り ──

const bookFullJobs = (s: Awaited<ReturnType<typeof setup>>) => s.app.reviews.list().filter(j => j.trigger === 'book_full');

test('整理の振り返り: 記憶が予算を超えたら 1 日 1 回だけ book_full を積む（dedupKey は book:all:<日>）。超えなければ積まない', async t => {
  const s = await setup(t, c => { c.models = [model('big', 'fa', 20_000)]; });
  await s.app.worker.tick();
  s.fill(1);
  assert.equal(await s.app.worker.tick(), 'idle', '予算に収まっているあいだは何も積まない');
  assert.equal(bookFullJobs(s).length, 0);

  s.fill(6);
  s.adapter().scripts.push(reply('変更なし'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const day = Math.floor(s.clock.now / DAY);
  assert.deepEqual(bookFullJobs(s).map(j => j.dedup_key), [`book:all:${day}`]);
  const calls = s.adapter().calls.length;
  for (let i = 0; i < 3; i++) { s.clock.now += 60_000; assert.equal(await s.app.worker.tick(), 'idle', '同じ日には二度積まない'); }
  assert.equal(s.adapter().calls.length, calls);

  s.clock.now += DAY;
  s.adapter().scripts.push(reply('変更なし'));
  assert.equal(await s.app.worker.tick(), 'ran', '次の日にまだ超えていれば、もう一度');
  assert.deepEqual(bookFullJobs(s).map(j => j.dedup_key).sort(), [`book:all:${day}`, `book:all:${day + 1}`]);
});

test('整理の振り返り: チャットと裏方のうち小さい方で測る。モデルが 0 個・予算なしでは積まない', async t => {
  const s = await setup(t, c => { c.models = [model('big', 'fa', 65536), model('small', 'fb', 20_000)]; });
  await s.app.worker.tick();
  s.fill(4);
  const big = s.app.engine.memoryBudget()!;
  assert.ok(estimateTextTokens(renderBooks(s.app.memory.list())) < big, '大きいモデルだけなら収まる量');
  assert.equal(await s.app.worker.tick(), 'idle');
  assert.equal(bookFullJobs(s).length, 0);

  const config = s.app.config();
  config.routing = { chat: ['big'], background: ['small'], retriesPerModel: 0 };
  await s.app.applyConfig(config);
  s.adapter('fb').scripts.push(reply('変更なし'));
  assert.equal(await s.app.worker.tick(), 'ran', '裏方の小さいモデルには収まらないので積む');
  assert.equal(bookFullJobs(s).length, 1);

  const zero = await setup(t, c => { c.models = []; c.routing = { chat: [], background: [], retriesPerModel: 0 }; });
  zero.fill(8);
  for (let i = 0; i < 2; i++) assert.equal(await zero.app.worker.tick(), 'no_model');
  assert.equal(bookFullJobs(zero).length, 0, 'モデルが 0 個では積まない');

  const unknown = await setup(t, anthropicWithoutLength);
  unknown.adapter('fa').probeResult = { effective: undefined as unknown as number };
  await unknown.reprobe();
  unknown.fill(8);
  await unknown.app.worker.tick();
  assert.equal(bookFullJobs(unknown).length, 0, '予算なしでは積まない');
});

test('整理の振り返り: 依頼文は、会話に入りきらない記憶を古い順に挙げ、挙げる量にも予算がある', async t => {
  const s = await setup(t, c => { c.models = [model('big', 'fa', 20_000)]; });
  await s.app.worker.tick();
  s.fill(6);
  const budget = s.app.engine.memoryBudget()!;
  const plan = planBooks(s.app.memory.list(), 'ja', budget);
  s.adapter().scripts.push(reply('変更なし'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const prompt = String(s.adapter().calls.at(-1)!.messages.at(-1)?.content);
  assert.match(prompt, /きっかけ: 記憶が大きくなった/u);
  assert.match(prompt, /# 記憶の量\n記憶の合計は約 \d+ トークンで、会話に入れる量の目安（約 \d+ トークン）を超えています/u);
  const listed = [...prompt.matchAll(/^- \[[un](\d+)\] /gmu)].map(m => Number(m[1]));
  assert.ok(plan.omitted.length >= 2, '挙げる対象が複数ある量にしてある');
  assert.deepEqual(listed, plan.omitted.map(m => m.id), '入りきらない記憶だけを、古い順に（会話に入っている記憶は挙げない）');
  assert.ok(listed.every((id, i) => i === 0 || listed[i - 1]! < id), '古い順');
});

test('bookPressureText: 会話に入りきらない記憶を古い順に挙げ、挙げる量は予算まで。残りは「ほか N 件」（日本語・英語）', () => {
  const outside = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, book: (i % 2 ? 'notes' : 'user') as 'user' | 'notes', content: `${String(i + 1).padStart(2, '0')}${'あ'.repeat(98)}` }));
  const ja = bookPressureText({ tokens: 9000, budget: 500, outside }, 'ja');
  const lines = ja.split('\n');
  assert.equal(lines[0], '記憶の合計は約 9000 トークンで、会話に入れる量の目安（約 500 トークン）を超えています。会話に入りきらない記憶が 50 件あります。重なりをまとめ、古いものを減らすことを優先する');
  assert.equal(lines[1], '会話に入りきらない記憶（古い順）:');
  const items = lines.filter(l => l.startsWith('- ['));
  assert.ok(items.length >= 3 && items.length <= 5, `予算 500 トークンで 100 字ずつ: ${items.length} 件`);
  assert.ok(items[0]!.startsWith('- [u1] 01'), '古い方から');
  assert.ok(items[1]!.startsWith('- [n2] 02'));
  assert.equal(lines.at(-1), `…（ほか ${50 - items.length} 件）`);
  assert.ok(estimateTextTokens(items.join('\n')) <= 500, '挙げる分は予算に収まる');

  const en = bookPressureText({ tokens: 9000, budget: 500, outside: outside.slice(0, 2).map(m => ({ ...m, content: `fact ${m.id}` })) }, 'en');
  assert.doesNotMatch(en, CJK);
  assert.match(en, /^Memory totals about 9000 tokens, over the guideline for what goes into a conversation \(about 500 tokens\)\. 2 memories do not fit in a conversation\./u);
  assert.ok(!en.includes('more)'), '全部挙げられたときは「ほか」を付けない');
});
