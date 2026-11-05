import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { ApiError, type ModelView, type Probe } from '../web/src/api.ts';
import {
  advanceApprovalGate, APPROVAL_ENTER_GRACE_MS, approvalEnterAllowed, approvalFraction, chatTime, createDecisionTracker, contextCardOf, enterApprovalId, firstLine, liveRenderDelay, replyTurns, formatCountdown, isNearBottom, isRenameWithoutTitle, joinsToolRun, newConversationId, renameTitleOf,
  restartApprovalGate, runOverflowOf, SLASH_COMMANDS, sendFailureOf, sendTarget, slashMatches, TextThrottle, toolIcon, TOOL_ICONS, toolInputSummary,
} from '../web/src/chat-logic.ts';
import { decideApproval } from '../web/src/approval-decide.ts';
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
  assert.equal(noProblems?.hint, null);
  assert.equal(noProblems?.numbers.required, null, 'problems が無ければ数字も無い（札の本文は sendFailureOf の message を使う）');
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
  assert.match(en['notice.compacted'](1), /^Summarized 1 older message \(/u);
  assert.match(en['notice.compacted'](4), /^Summarized 4 older messages \(/u);
  assert.match(en['notice.compacted'](4), /originals are kept/u, '原文が残っていることを伝える');
  assert.match(ja['notice.compacted'](4), /^古い発言 4 件を要約しました（原文は残っていて、.*探せます）$/u);
  assert.equal(en['chat.pdfPages'](1), 'PDF, 1 page');
  assert.equal(en['approval.position'](1, 2), '1 / 2');
});

test('liveRenderDelay: 短い返事は届くたびに描き、長い返事は長さに比例して間引く（上限 1 秒）', () => {
  assert.equal(liveRenderDelay(0), 0);
  assert.equal(liveRenderDelay(2999), 0, '3,000 文字までは、これまでどおり届くたびに描く');
  assert.equal(liveRenderDelay(3000), 30);
  assert.equal(liveRenderDelay(10_000), 100);
  assert.equal(liveRenderDelay(50_000), 500);
  assert.equal(liveRenderDelay(1_000_000), 1000, '上限は 1 秒');
  const lengths = [3000, 6000, 12_000, 25_000, 50_000, 100_000];
  const delays = lengths.map(liveRenderDelay);
  assert.ok(delays.every((d, i) => i === 0 || d >= delays[i - 1]!), '長いほど間隔は広い（縮まない）');
});

test('replyTurns: 1 回の返事（同じ runId）は見出し 1 つ。中間の文は見出しなしで続き、コピーは最後の文に 1 つ（その回の文を全部まとめる）', () => {
  const m = (id: number, role: string, runId: string | null, text = '') => ({ id, role, runId, text });
  const one = [
    m(1, 'user', null, '調べて'), m(2, 'assistant', 'r1', '調べます。'), m(3, 'tool', 'r1'), m(4, 'assistant', 'r1', '原因がほぼ確定しました。'), m(5, 'tool', 'r1'), m(6, 'assistant', 'r1', '以上です。'),
  ];
  const turns = replyTurns(one);
  assert.deepEqual([2, 4, 6].map(id => turns.get(id)?.head), [true, false, false], '見出しは最初の文だけ');
  assert.deepEqual([2, 4, 6].map(id => turns.get(id)?.copyText), [null, null, '調べます。\n\n原因がほぼ確定しました。\n\n以上です。'], 'コピーは最後に 1 つ');
  assert.equal(turns.has(1) || turns.has(3), false, '発言と道具の行は対象外');

  const live = replyTurns(one, 'r1');
  assert.deepEqual([2, 4, 6].map(id => live.get(id)?.head), [true, false, false]);
  assert.equal(live.get(6)?.copyText, null, 'まだ続いている最中の返事には、コピーを付けない');
  assert.equal(replyTurns(one, 'other').get(6)?.copyText !== null, true, '別の実行が動いていても関係ない');

  const two = replyTurns([...one, m(7, 'user', null, 'ありがとう'), m(8, 'assistant', 'r2', 'どういたしまして')]);
  assert.equal(two.get(8)?.head, true, '次の発言のあとは、新しい返事');
  assert.equal(two.get(8)?.copyText, 'どういたしまして');
  assert.equal(two.get(2)?.head, true);

  const mixed = replyTurns([m(1, 'assistant', 'r1', 'a'), m(2, 'assistant', 'r2', 'b'), m(3, 'assistant', null, 'c'), m(4, 'assistant', null, 'd')]);
  assert.deepEqual([1, 2, 3, 4].map(id => mixed.get(id)?.head), [true, true, true, true], '別の runId・runId の無い文は、それぞれが 1 回の返事');
  assert.deepEqual([1, 2, 3, 4].map(id => mixed.get(id)?.copyText), ['a', 'b', 'c', 'd']);
});

test('enterApprovalId: Enter で許可できるのは先頭の札だけ。コードを動かす確かめ（onceOnly）は、ボタンを押すまで許可しない', () => {
  assert.equal(enterApprovalId([]), null);
  assert.equal(enterApprovalId([{ id: 'a', onceOnly: false }, { id: 'b', onceOnly: true }]), 'a');
  assert.equal(enterApprovalId([{ id: 'b', onceOnly: true }, { id: 'a', onceOnly: false }]), null, '先頭がコードの確かめなら、後ろの札も Enter で許可しない');
});

test('approvalEnterAllowed: 空の Enter での承認は、表示している札の id が合い、出てから 1 秒たったあとだけ', () => {
  let gate = advanceApprovalGate({ id: null, since: 0 }, 'a', 10_000);
  assert.equal(approvalEnterAllowed(gate, 'a', 10_000 + APPROVAL_ENTER_GRACE_MS - 1), false, '出たばかりの札は、連打の Enter で承認されない');
  assert.equal(approvalEnterAllowed(gate, 'a', 10_000 + APPROVAL_ENTER_GRACE_MS), true);
  assert.equal(approvalEnterAllowed(gate, 'b', 99_999), false, '表示している札と違う id には効かない');
  assert.equal(approvalEnterAllowed(gate, null, 99_999), false, '札が無いとき');
  gate = advanceApprovalGate(gate, 'a', 50_000);
  assert.equal(gate.since, 10_000, '同じ札のままなら、出た時刻は変えない');
  gate = advanceApprovalGate(gate, 'b', 60_000);
  assert.deepEqual(gate, { id: 'b', since: 60_000 }, '先頭の札が替わったら、数え直す');
  assert.equal(approvalEnterAllowed(gate, 'b', 60_500), false, '前の札を承認した直後に次の札が出ても、すぐには承認されない');
  assert.equal(approvalEnterAllowed(gate, 'a', 70_000), false, '古い札の id では通らない');
  gate = advanceApprovalGate(gate, null, 80_000);
  assert.equal(approvalEnterAllowed(gate, 'b', 90_000), false);
});

test('createDecisionTracker: 同じ札への決定は、終わるまで 1 回だけ。失敗したら送り直せる', () => {
  const tracker = createDecisionTracker();
  assert.equal(tracker.has('x'), false);
  assert.equal(tracker.start('x'), true);
  assert.equal(tracker.start('x'), false, '2 回目は受けない');
  assert.equal(tracker.start('y'), true, '別の札には効く');
  assert.equal(tracker.has('x'), true);
  tracker.release('x');
  assert.equal(tracker.start('x'), true, '失敗して戻したあとは、もう一度送れる');
});

test('decideApproval: Enter と札のボタンが同じ札に同時に決定を送っても、サーバーへは 1 回だけ', async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${String(url)} ${String(init?.body)}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    return String(url).includes('/bad') ? Response.json({ error: 'nope' }, { status: 500 }) : Response.json({ ok: true });
  }) as typeof fetch;
  try {
    const [first, second, other] = await Promise.all([decideApproval('ok1', 'once'), decideApproval('ok1', 'deny'), decideApproval('ok2', 'conversation')]);
    assert.deepEqual([first, second, other], [true, false, true], '同じ札の 2 つ目は送らない（404 の知らせにならない）');
    assert.equal(await decideApproval('ok1', 'once'), false, '送れたあとも、札が消えるまでは送らない');
    assert.deepEqual(calls, ['/api/approvals/ok1 {"decision":"once"}', '/api/approvals/ok2 {"decision":"conversation"}']);
    await assert.rejects(decideApproval('bad1', 'once'));
    await assert.rejects(decideApproval('bad1', 'once'), '失敗したときは受け付けを戻すので、もう一度送れる');
    assert.equal(calls.filter(c => c.includes('/bad1')).length, 2);
  } finally { globalThis.fetch = original; }
});

test('restartApprovalGate: 見ていない間に出た札も、画面に戻ってから 1 秒は Enter で承認されない', () => {
  const arrived = advanceApprovalGate({ id: null, since: 0 }, 'a', 1_000);
  assert.equal(approvalEnterAllowed(arrived, 'a', 1_000 + 5 * 60_000), true, '何もしなければ、時間がたてば Enter が効く');
  const returned = restartApprovalGate(arrived, 1_000 + 5 * 60_000);
  assert.equal(returned.id, 'a', '札は同じまま、数え直すだけ');
  assert.equal(approvalEnterAllowed(returned, 'a', 1_000 + 5 * 60_000), false, '戻った直後の Enter は効かない');
  assert.equal(approvalEnterAllowed(returned, 'a', 1_000 + 5 * 60_000 + APPROVAL_ENTER_GRACE_MS - 1), false);
  assert.equal(approvalEnterAllowed(returned, 'a', 1_000 + 5 * 60_000 + APPROVAL_ENTER_GRACE_MS), true);
  assert.deepEqual(restartApprovalGate({ id: null, since: 5 }, 9), { id: null, since: 9 }, '札が無いときも壊れない');
});

test('sendFailureOf: 「使えるモデルがない」の 409 は、problems の行を、同じ状態のモデルの確認（コード付き）から画面の言語で組み立て直す', async () => {
  const { errorProbeText } = await import('../src/providers/context.ts');
  const { providerError } = await import('../src/providers/types.ts');
  const { engineText } = await import('../src/shared/messages/engine.ts');
  const served = errorProbeText(providerError('provider_error', 'probe.ollama_unreachable', { base: 'http://127.0.0.1:11434' }), 'ja');
  const unreachable = probe({ modelId: 'local', status: 'unreachable', message: served.message, ...(served.messageCode ? { messageCode: served.messageCode } : {}), ...(served.messageParams ? { messageParams: served.messageParams as Record<string, string | number> } : {}) });
  const body = {
    error: 'provider_error', errorKind: 'provider_error', errorCode: 'engine.no_usable',
    errorMessage: engineText('ja', 'no_usable', { lines: engineText('ja', 'problem.line', { id: 'local', message: served.message, hintPart: '' }) }),
    problems: [{ modelId: 'local', status: 'unreachable', message: served.message }],
  };
  const models = [model('local', { probe: unreachable })];
  const expectedEn = engineText('en', 'no_usable', { lines: engineText('en', 'problem.line', { id: 'local', message: errorProbeText(providerError('provider_error', 'probe.ollama_unreachable', { base: 'http://127.0.0.1:11434' }), 'en').message, hintPart: '' }) });

  setLanguagePreference('en');
  assert.equal(sendFailureOf(new ApiError(409, body), 'x', models).message, expectedEn, 'en の画面では、サーバーが ja で書いていても英語');
  assert.notEqual(sendFailureOf(new ApiError(409, body), 'x', models).message, body.errorMessage);
  setLanguagePreference('ja');
  assert.equal(sendFailureOf(new ApiError(409, body), 'x', models).message, body.errorMessage, 'ja ならサーバーの文と同じ');

  setLanguagePreference('en');
  assert.equal(sendFailureOf(new ApiError(409, body), 'x', []).message.includes('Nothing was sent'), true, 'モデルの確認が無くても、問題の文はサーバーのままで枠は英語');
  const stale = [model('local', { probe: { ...unreachable, status: 'ok' } })];
  assert.equal(sendFailureOf(new ApiError(409, body), 'x', stale).message.includes(served.message), true, '状態が違う確認は使わず、サーバーの行のまま');
  const withHint = { ...body, problems: [{ modelId: 'local', status: 'unreachable', message: served.message, hint: '直し方' }] };
  assert.equal(sendFailureOf(new ApiError(409, withHint), 'x', models).message.includes('(直し方)'), true, 'hint は付く（英語の括弧）');
  const none = { ...body, problems: [] };
  assert.equal(sendFailureOf(new ApiError(409, none), 'x', models).message, engineText('en', 'no_usable', { lines: engineText('en', 'problem.none') }));
  const other = { error: 'busy', errorMessage: '忙しい', errorCode: 'engine.send.busy' };
  assert.equal(sendFailureOf(new ApiError(409, other), 'x', models).message, engineText('en', 'send.busy'), 'ほかのコードは ApiError の訳のまま');
  const coded = { ...body, problems: [{ modelId: 'local', status: 'unreachable', message: served.message, messageCode: served.messageCode, messageParams: served.messageParams }] };
  assert.equal(sendFailureOf(new ApiError(409, coded), 'x', []).message, expectedEn, 'problems 自身にコードが付いていれば、モデルの一覧が無くても英語');
  const wrongStatus = { models: [model('local', { probe: { ...unreachable, status: 'ok', messageCode: 'provider.probe.unknown' } })] };
  assert.equal(sendFailureOf(new ApiError(409, coded), 'x', wrongStatus.models).message, expectedEn, 'コードがあれば、モデルの一覧の状態には頼らない');
  const otherWithProblems = { ...body, errorCode: 'engine.send.busy', problems: body.problems };
  assert.equal(sendFailureOf(new ApiError(409, otherWithProblems), 'x', models).message, engineText('en', 'send.busy'), 'problems があっても、「使えるモデルがない」以外のコードは組み立て直さない');
  const unknown = { ...body, problems: [{ nope: true }] };
  assert.equal(sendFailureOf(new ApiError(409, unknown), 'x', models).message, new ApiError(409, unknown).message);
});

test('joinsToolRun: 続けて並ぶ道具の行（実行中の道具を含む）は前の行とくっつく。間に返事・発言・注記が入れば分かれる', () => {
  assert.deepEqual(joinsToolRun(['user', 'tool', 'tool', 'run', 'assistant', 'tool']), [false, false, true, true, false, false]);
  assert.deepEqual(joinsToolRun(['tool', 'tool', 'tool']), [false, true, true], '先頭の行は何ともくっつかない');
  assert.deepEqual(joinsToolRun(['tool', 'note', 'tool']), [false, false, false], '注記を挟めば別のまとまり');
  assert.deepEqual(joinsToolRun(['assistant', 'think', 'fail']), [false, false, false], '道具の行でないものはくっつかない');
  assert.deepEqual(joinsToolRun([]), []);
});

test('sendFailureOf: モデルが 1 つも無い 409（problems が空）だけ noModels になり、「モデルを設定する」案内を出せる', () => {
  const none = { error: 'provider_error', errorKind: 'provider_error', errorCode: 'engine.no_usable', errorMessage: '使えるモデルがないため送信しませんでした', problems: [] };
  assert.equal(sendFailureOf(new ApiError(409, none), 'x', []).noModels, true);
  const broken = { ...none, problems: [{ modelId: 'local', status: 'unreachable', message: '接続できません' }] };
  assert.equal(sendFailureOf(new ApiError(409, broken), 'x', []).noModels, false, 'モデルがあるけれど使えないときは、設定を開くだけ');
  assert.equal(sendFailureOf(new ApiError(409, { error: 'busy', errorCode: 'engine.send.busy', problems: [] }), 'x', []).noModels, false);
  assert.equal(sendFailureOf(new Error('x'), 'x', []).noModels, false);
});

test('newConversationId / sendTarget: 最初の発言は画面が決めた id へ送り（会話を先に作らない）、断られたあとのやり直しは同じ id を使う', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  assert.match(newConversationId(), uuid, 'ふつうの環境（randomUUID がある）');
  const insecure = { getRandomValues: (bytes: Uint8Array) => { bytes.fill(255); return bytes; } };
  assert.match(newConversationId(insecure), uuid, 'http の画面（randomUUID が無い）でも UUID v4 の形になる');
  assert.equal(newConversationId(insecure), 'ffffffff-ffff-4fff-bfff-ffffffffffff');

  let generated = 0;
  const generate = () => `new-${++generated}`;
  const existing = sendTarget('c1', null, generate);
  assert.deepEqual(existing, { id: 'c1', created: null }, 'もう会話があれば、その id へ送り、id を作らない');
  assert.equal(generated, 0);
  const first = sendTarget(null, null, generate);
  assert.deepEqual(first, { id: 'new-1', created: 'new-1' }, '最初の発言は新しい id へ');
  const retry = sendTarget(null, first.created, generate);
  assert.deepEqual(retry, { id: 'new-1', created: 'new-1' }, '断られたあとのやり直しは同じ id');
  assert.equal(generated, 1, 'やり直しでは作り直さない');
  assert.deepEqual(sendTarget('c2', 'new-1', generate), { id: 'c2', created: 'new-1' }, '会話に移ったあとは、その会話へ');
});

// 時計と待ちを差し替えて、画面の部品（useThrottledText）と同じ流れを動かす: 描く → 待ちを置く → 鳴ったら描き直す
function drive(initial: string) {
  const state = { clock: 0, redraws: 0, pending: undefined as { fn: () => void; at: number } | undefined, cancelled: 0 };
  const throttle = new TextThrottle(initial);
  const timers = {
    now: () => state.clock,
    redraw: () => { state.redraws++; },
    setTimer: (fn: () => void, ms: number) => { state.pending = { fn, at: state.clock + ms }; const mine = state.pending; return () => { if (state.pending === mine) { state.pending = undefined; state.cancelled++; } }; },
  };
  let cancel: (() => void) | undefined;
  let lastText: string | undefined;
  // 描く（届いた文で描き直す）→ 前の待ちを止めて、必要なら新しい待ちを置く
  const render = (text: string, at: number): string => {
    state.clock = at;
    const drawn = throttle.next(text, at);
    // useEffect(…, [text]) と同じ: 文が変わったときだけ、前の待ちを止めて置き直す
    if (text !== lastText) { cancel?.(); cancel = throttle.arm(text, timers); lastText = text; }
    return drawn;
  };
  // 待ちが鳴る（鳴る時刻を ms 早める・遅らせるを指定できる）
  const ring = (offset: number): void => {
    const pending = state.pending;
    assert.ok(pending, '待ちが置かれていない');
    state.pending = undefined;
    state.clock = pending.at + offset;
    pending.fn();
  };
  return { state, throttle, render, ring };
}

test('流れている文の間引き: 時計が少し早く鳴っても、届いた残りは必ず描かれる（描き残さない）', () => {
  const T1 = 'あ'.repeat(5000);
  const T2 = `${T1}${'い'.repeat(300)}`;
  for (const offset of [0, -0.4, -1, -30, 5]) {
    const d = drive('');
    assert.equal(d.render(T1, 1000), T1, '間隔が過ぎていれば、すぐ描く');
    assert.equal(d.render(T2, 1010), T1, '間隔の内に届いた分は、まだ描かない');
    assert.ok(d.state.pending, '残りを描く待ちが置かれている');
    d.ring(offset);
    assert.equal(d.state.redraws, 1, `鳴ったら描き直しを頼む（${offset} ms）`);
    // 描き直しで描く文（時計が早かった場合も、残りは描いてある）
    assert.equal(d.render(T2, d.state.clock), T2, `鳴る時刻が ${offset} ms ずれても、残りを描く`);
    assert.equal(d.state.pending, undefined, '描き終えたら、もう待ちは要らない');
  }
});

test('流れている文の間引き: 短い返事は届くたびに描き、続きが無いときは待ちを置かない。前の待ちは止める', () => {
  const d = drive('');
  assert.equal(d.render('こんにちは', 10), 'こんにちは');
  assert.equal(d.render('こんにちは、世界', 11), 'こんにちは、世界');
  assert.equal(d.state.pending, undefined);
  const long = drive('');
  const base = 'a'.repeat(4000);
  long.render(base, 1000);
  long.render(`${base}b`, 1001);
  assert.ok(long.state.pending);
  long.render(`${base}bc`, 1002);
  assert.equal(long.state.cancelled, 1, '届くたびに前の待ちを止めて置き直す');
  assert.notEqual(long.render('別の文'.repeat(2000), 1003), base, '文が前の続きでなければ、すぐ描き直す');
});
