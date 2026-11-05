import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { ApiError, type ModelView, type Probe } from '../web/src/api.ts';
import {
  approvalFraction, chatTime, contextCardOf, firstLine, formatCountdown, isNearBottom, isRenameWithoutTitle, modelNameOf, renameTitleOf, resolveRunModels,
  runOverflowOf, SLASH_COMMANDS, sendFailureOf, slashMatches, toolIcon, TOOL_ICONS, toolInputSummary,
} from '../web/src/chat-logic.ts';
import { en } from '../web/src/i18n/en.ts';
import { setLanguagePreference, setTimezone } from '../web/src/i18n/index.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { isMemoryUndone, undoMemoryEvent } from '../web/src/memory-undo.ts';

const reset = () => { setLanguagePreference('ja'); setTimezone('Asia/Tokyo'); };
afterEach(reset);

const probe = (patch: Partial<Probe> = {}): Probe => ({
  modelId: 'm', status: 'too_small', server: 'ollama', declared: 8192, measured: 8192, modelMax: 32768, effective: 8192, required: 17260,
  message: 'too small', checkedAt: 1, ...patch,
});
const model = (id: string, patch: Partial<ModelView> = {}): ModelView => ({
  id, label: id, provider: 'p', model: `${id}-name`, minContext: 4096, maxOutputTokens: 512, inChat: true, probe: null, ...patch,
});

test('contextCardOf: 送る前の 409 の problems と、モデルの確認結果（probe）をつなげて数字を出す', () => {
  const body = {
    error: 'context_overflow', errorKind: 'context_overflow', errorMessage: '使えるモデルがないため送信しませんでした',
    detail: { reason: 'server_ctx_too_small', hint: '全体の直し方' },
    problems: [
      { modelId: 'down', status: 'unreachable', message: '接続できません' },
      { modelId: 'small', status: 'too_small', message: '長さが足りません', hint: 'このモデルの直し方' },
    ],
  };
  const card = contextCardOf(body, [model('down'), model('small', { probe: probe({ effective: 2048, required: 17260, declared: 2048, measured: undefined as unknown as number, modelMax: 32768 }) })]);
  assert.ok(card);
  assert.equal(card.modelId, 'small', '長さの問題ではないモデル（接続できない）は飛ばす');
  assert.equal(card.message, '長さが足りません');
  assert.equal(card.hint, 'このモデルの直し方', 'problems[].hint を優先する');
  assert.deepEqual(card.numbers, { effective: 2048, required: 17260, declared: 2048, measured: null, modelMax: 32768 });
});

test('contextCardOf: probe が無いモデルは数字なし、hint は detail.hint に戻る。context_overflow 以外は null', () => {
  const body = { errorKind: 'context_overflow', errorMessage: '本文', detail: { hint: '全体の直し方' }, problems: [{ modelId: 'gone', status: 'unknown', message: '分からない' }] };
  const card = contextCardOf(body, []);
  assert.ok(card);
  assert.deepEqual(card.numbers, { effective: null, required: null, declared: null, measured: null, modelMax: null });
  assert.equal(card.hint, '全体の直し方');
  assert.equal(contextCardOf({ errorKind: 'provider_error', problems: [] }, []), null);
  assert.equal(contextCardOf(null, []), null);
  assert.equal(contextCardOf('x', []), null);
  const noProblems = contextCardOf({ error: 'context_overflow', errorMessage: '本文だけ' }, []);
  assert.equal(noProblems?.message, '本文だけ', 'problems が無いときはサーバーの本文を出す');
});

test('sendFailureOf: ApiError の 409 は context と見分け、ApiError 以外は渡された代わりの文にする', () => {
  const overflow = sendFailureOf(new ApiError(409, { error: 'context_overflow', errorKind: 'context_overflow', errorMessage: 'ダメ', detail: { hint: '直す' } }), 'x');
  assert.deepEqual({ message: overflow.message, hint: overflow.hint, context: overflow.context }, { message: 'ダメ', hint: '直す', context: true });
  const busy = sendFailureOf(new ApiError(409, { error: 'busy', message: '返事中' }), 'x');
  assert.deepEqual({ message: busy.message, hint: busy.hint, context: busy.context }, { message: '返事中', hint: null, context: false });
  const network = sendFailureOf(new TypeError('fetch failed'), '送れませんでした');
  assert.deepEqual({ message: network.message, hint: network.hint, context: network.context }, { message: '送れませんでした', hint: null, context: false });
});

test('runOverflowOf: 途中で収まらなくなった失敗だけ、来た 2 つの数字を返す', () => {
  assert.deepEqual(runOverflowOf({ errorKind: 'context_overflow', measured: 18488, required: 76539 }), { available: 18488, required: 76539 });
  assert.equal(runOverflowOf({ errorKind: 'context_overflow', measured: 18488 }), null, '片方しか無いときは数字の札にしない');
  assert.equal(runOverflowOf({ errorKind: 'provider_error', measured: 1, required: 2 }), null);
  assert.equal(runOverflowOf({}), null);
});

test('modelNameOf / resolveRunModels: 返事ごとのモデル名は、実行の記録の model を優先し、なければ設定の id から引く', () => {
  const models = [model('a'), model('b')];
  assert.equal(modelNameOf(models, 'a'), 'a-name');
  assert.equal(modelNameOf(models, 'removed'), 'removed', '設定から消えたモデルは id のまま');
  assert.equal(modelNameOf(models, null), null);
  const rows = [
    { id: 'r1', model_id: 'a', model: 'served-name', started_at: 1 },
    { id: 'r2', model_id: 'b', started_at: 2 },
    { id: 'r3', model_id: null, model: null, started_at: 3 },
  ];
  const { found, missing } = resolveRunModels(rows, ['r1', 'r2', 'r3', 'r-old'], models);
  assert.deepEqual([...found], [['r1', 'served-name'], ['r2', 'b-name']]);
  assert.deepEqual(missing, ['r-old'], '記録に無い（500 件より古い）ものだけが missing。終わっていない実行は missing にしない');
});

test('slashMatches: 先頭の / のあとの 1 語を前方一致で候補にする。rename と archive も入っている', () => {
  assert.equal(slashMatches('/').length, SLASH_COMMANDS.length);
  assert.deepEqual(slashMatches('/ta').map(c => c.name), ['task', 'tasks']);
  assert.deepEqual(slashMatches('/TASKS').map(c => c.name), ['tasks'], '大文字小文字は見ない');
  assert.deepEqual(slashMatches('/ren').map(c => c.name), ['rename']);
  assert.deepEqual(slashMatches('/archive').map(c => c.name), ['archive']);
  assert.deepEqual(slashMatches('/nothing'), []);
  assert.deepEqual(slashMatches('/rename 題'), [], '空白のあとは引数なので候補を出さない');
  assert.deepEqual(slashMatches('hello /new'), []);
  assert.deepEqual(slashMatches('xnew'), [], '先頭が / でなければ、2 文字目以降が一致しても候補にしない');
  assert.deepEqual(slashMatches(''), []);
});

test('slash の説明文は、全コマンドぶん ja と en の両方にある', () => {
  assert.deepEqual(SLASH_COMMANDS.map(c => c.name), ['new', 'task', 'tasks', 'skills', 'log', 'memory', 'stop', 'rename', 'archive']);
  for (const command of SLASH_COMMANDS) {
    assert.ok(ja[command.desc].length > 0, `ja: ${command.desc}`);
    assert.ok(en[command.desc].length > 0, `en: ${command.desc}`);
  }
});

test('renameTitleOf / isRenameWithoutTitle: /rename のあとの題だけを取り出す', () => {
  assert.equal(renameTitleOf('/rename 新しい題'), '新しい題');
  assert.equal(renameTitleOf('  /rename   前後の空白は除く  '), '前後の空白は除く');
  assert.equal(renameTitleOf('/rename 改行を\n含む題'), '改行を\n含む題');
  assert.equal(renameTitleOf('/rename'), null);
  assert.equal(renameTitleOf('/rename   '), null);
  assert.equal(renameTitleOf('/renameX 題'), null, '別のコマンド名は拾わない');
  assert.equal(renameTitleOf('普通の発言 /rename 題'), null);
  assert.equal(renameTitleOf(`/rename ${'a'.repeat(500)}`)?.length, 200, 'サーバーの上限（200 字）に切る');
  assert.equal(isRenameWithoutTitle('/rename'), true);
  assert.equal(isRenameWithoutTitle('/rename '), true);
  assert.equal(isRenameWithoutTitle('/rename x'), false);
});

test('toolIcon: 組み込みの道具 24 個すべてに絵があり、知らない道具は terminal', () => {
  const names = builtinTools().map(t => t.name).sort();
  assert.equal(names.length, 24);
  assert.deepEqual(Object.keys(TOOL_ICONS).sort(), names, '道具を足したり消したりしたら、絵の表も直す');
  assert.equal(toolIcon('file_read'), 'file');
  assert.equal(toolIcon('shell_run'), 'terminal');
  assert.equal(toolIcon('web_search'), 'search');
  assert.equal(toolIcon('some_new_tool'), 'terminal');
  assert.equal(toolIcon(undefined), 'terminal');
});

test('toolInputSummary: 道具の入力（JSON の文字列）を 1 行にする', () => {
  assert.equal(toolInputSummary('{"command":"ls -la","timeout":5}'), 'ls -la');
  assert.equal(toolInputSummary('{"path":"/a/b.txt"}'), '/a/b.txt');
  assert.equal(toolInputSummary('{"count":3,"label":"x"}'), 'x', '決まった名前が無ければ、最初の文字列の値');
  assert.equal(toolInputSummary('{"count":3}'), '{"count":3}');
  assert.equal(toolInputSummary('"just text"'), 'just text');
  assert.equal(toolInputSummary('not json {'), 'not json {');
  assert.equal(toolInputSummary('{"command":"a\\n  b\\tc"}'), 'a b c', '改行や連続した空白は 1 つにする');
  assert.equal(toolInputSummary(`{"command":"${'x'.repeat(400)}"}`).length, 241, '長いものは 240 字で切って … を付ける');
  assert.equal(toolInputSummary(''), '');
});

test('firstLine: 結果の最初の空でない行を、長ければ切って返す', () => {
  assert.equal(firstLine('\n\n  結果です\n2 行目'), '結果です');
  assert.equal(firstLine(''), '');
  assert.equal(firstLine('x'.repeat(200)).length, 161);
});

test('approvalFraction / formatCountdown: 残り時間の線と mm:ss', () => {
  assert.equal(approvalFraction(1000 + 300_000, 1000, 600_000), 0.5);
  assert.equal(approvalFraction(5000, 1000, 600_000) < 0.01, true);
  assert.equal(approvalFraction(1000, 5000, 600_000), 0, '過ぎたら 0');
  assert.equal(approvalFraction(10_000_000, 0, 600_000), 1, '全体の長さより多く残っていても 1 まで');
  assert.equal(approvalFraction(100, 0, 0), 0, '全体の長さが分からなければ 0');
  assert.equal(formatCountdown(592_000), '09:52');
  assert.equal(formatCountdown(-5), '00:00');
});

test('chatTime: 時刻だけを、サーバーのタイムゾーンと表示の言語で 24 時間表記にする', () => {
  const at = Date.UTC(2026, 10, 5, 1, 7);
  assert.equal(chatTime(at, 'ja', 'Asia/Tokyo'), '10:07');
  assert.equal(chatTime(at, 'en', 'Asia/Tokyo'), '10:07');
  assert.equal(chatTime(at, 'en', 'America/Los_Angeles'), '17:07', '前の日の夕方（サマータイムなし）');
  assert.equal(chatTime(Date.UTC(2026, 10, 5, 15, 0), 'ja', 'Asia/Tokyo'), '00:00', '24 時ではなく 00:00');
});

test('isNearBottom: 下から 80px 以内にいるときだけ、新しい発言へ自動で追いかける', () => {
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 520 }), true);
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 500 }), false);
  assert.equal(isNearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 500 }), true, '短くて全部見えているとき');
});

test('undoMemoryEvent: 取り消しが通ったときだけ「取り消し済み」になり、同じ出来事は二度送らない', async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return String(url).includes('/9001/') ? Response.json({ ok: true }) : Response.json({ error: 'nope' }, { status: 500 });
  }) as typeof fetch;
  try {
    assert.equal(isMemoryUndone(9001), false);
    assert.equal(await undoMemoryEvent(9002), false, '失敗したときは false');
    assert.equal(isMemoryUndone(9002), false);
    assert.equal(await undoMemoryEvent(9001), true);
    assert.equal(isMemoryUndone(9001), true);
    assert.equal(await undoMemoryEvent(9001), true, '取り消し済みなら、もう一度は送らない');
    assert.deepEqual(calls, ['/api/memory-events/9002/undo', '/api/memory-events/9001/undo']);
  } finally { globalThis.fetch = original; }
});

test('辞書: 段階 5 の英語に日本語が混ざらず、関数の文は引数を使う', () => {
  const kana = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const keys = Object.keys(ja).filter(k => /^(chat|approval|slash|markdown)\.|^notice\.(compacted|stopped)$|^toast\.(undo|memoryUndo)/u.test(k));
  assert.ok(keys.length > 80, `段階 5 のキーが ${keys.length} 件しか読めていない`);
  for (const key of keys) {
    const entry = (en as Record<string, unknown>)[key];
    const out = typeof entry === 'function' ? (entry as (...a: unknown[]) => string)('x', 3) : entry;
    assert.equal(typeof out, 'string', key);
    assert.ok(!kana.test(String(out)), `${key} の英語に日本語が混ざっている: ${String(out)}`);
  }
  assert.equal(en['notice.compacted'](1), 'Summarized 1 older message');
  assert.equal(en['notice.compacted'](4), 'Summarized 4 older messages');
  assert.equal(ja['notice.compacted'](4), '古い発言 4 件を要約しました');
  assert.equal(en['chat.pdfPages'](1), 'PDF, 1 page');
  assert.equal(en['approval.position'](1, 2), '1 / 2');
});
