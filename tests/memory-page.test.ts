import assert from 'node:assert/strict';
import { test } from 'node:test';
import { en } from '../web/src/i18n/en.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { actionKey, actorKey, BOOK_TAB_KEY, canUndo, MEMORY_TABS, memoryRef, originKey, roleKey, TAB_KEY } from '../web/src/memory-page.ts';
import { usageFraction, usageIsHigh } from '../web/src/usage.ts';

test('使用量: 0〜1 に収め、上限が 0 以下なら 0', () => {
  assert.equal(usageFraction(0, 100), 0);
  assert.equal(usageFraction(50, 100), 0.5);
  assert.equal(usageFraction(150, 100), 1, '上限を超えても 1');
  assert.equal(usageFraction(-5, 100), 0);
  assert.equal(usageFraction(10, 0), 0);
  assert.equal(usageFraction(10, -1), 0);
});

test('使用量: 8 割を「超えた」ときだけ高い（ちょうど 8 割は高くない）', () => {
  assert.equal(usageIsHigh(80, 100), false);
  assert.equal(usageIsHigh(81, 100), true);
  assert.equal(usageIsHigh(100, 100), true);
  assert.equal(usageIsHigh(0, 100), false);
  assert.equal(usageIsHigh(50, 0), false, '上限が 0 なら高いとは言わない');
});

test('記憶の値の読み替え: 出どころ・変更の種類・やった人・発言の役。知らない値は読み替えない', () => {
  assert.equal(originKey('user'), 'memory.origin.user');
  assert.equal(originKey('review'), 'memory.origin.review');
  assert.equal(originKey('clive'), 'memory.origin.clive');
  assert.equal(originKey('something-new'), 'memory.origin.clive', '知らない出どころは Clive が会話の中で覚えたものとして扱う');
  assert.deepEqual(['create', 'update', 'forget', 'restore'].map(actionKey), ['memory.action.create', 'memory.action.update', 'memory.action.forget', 'memory.action.restore']);
  assert.equal(actionKey('merge'), undefined);
  assert.deepEqual(['clive', 'user', 'review'].map(actorKey), ['memory.actor.clive', 'memory.actor.user', 'memory.actor.review']);
  assert.equal(actorKey('robot'), undefined);
  assert.deepEqual(['user', 'assistant', 'tool'].map(roleKey), ['memory.role.user', 'memory.role.assistant', 'memory.role.tool']);
  assert.equal(roleKey('system'), undefined);
});

test('取り消せる変更: まだ取り消していない、復元ではないものだけ', () => {
  assert.equal(canUndo({ action: 'create', undone_at: null }), true);
  assert.equal(canUndo({ action: 'update', undone_at: null }), true);
  assert.equal(canUndo({ action: 'forget', undone_at: null }), true);
  assert.equal(canUndo({ action: 'restore', undone_at: null }), false, '復元は取り消せない');
  assert.equal(canUndo({ action: 'create', undone_at: 1_700_000_000_000 }), false, '取り消し済み');
});

test('記憶の呼び名: ユーザーの本は u、メモの本は n', () => {
  assert.equal(memoryRef({ book: 'user', id: 12 }), '[u12]');
  assert.equal(memoryRef({ book: 'notes', id: 3 }), '[n3]');
});

test('切り替え: 3 つ（ユーザーについて・メモと教訓・会話を探す）で、どれにも名前がある', () => {
  assert.deepEqual([...MEMORY_TABS], ['user', 'notes', 'search']);
  assert.deepEqual(Object.keys(TAB_KEY).sort(), [...MEMORY_TABS].sort());
  assert.deepEqual(Object.keys(BOOK_TAB_KEY).sort(), ['notes', 'user']);
  for (const tab of MEMORY_TABS) assert.ok(TAB_KEY[tab] in ja && TAB_KEY[tab] in en, tab);
});

test('辞書: 記憶のページの文字は ja と en の両方にあり、en は ja の写しではない', () => {
  const keys = Object.keys(ja).filter(k => k.startsWith('memory.'));
  assert.ok(keys.length >= 45, `${keys.length} 件しか読めていない`);
  const sameInBoth = new Set(['memory.actor.clive', 'memory.role.assistant']);
  for (const key of keys) {
    const jaEntry = (ja as Record<string, unknown>)[key];
    const enEntry = (en as Record<string, unknown>)[key];
    assert.equal(typeof enEntry, typeof jaEntry, key);
    if (typeof jaEntry === 'string' && !sameInBoth.has(key)) assert.notEqual(enEntry, jaEntry, `${key}: 訳し忘れ`);
  }
  for (const key of ['memory.origin.user', 'memory.origin.review', 'memory.origin.clive', 'memory.action.create', 'memory.actor.user', 'memory.role.tool']) {
    assert.ok(key in ja && key in en, key);
  }
});

test('辞書: 差し込みの文は、引数を入れた形で読める', () => {
  const jaLine = (ja['memory.event.line'] as (a: string, b: string, c: string) => string)('10:15', 'あなた', '削除');
  assert.equal(jaLine, '10:15 あなたが削除');
  const enLine = (en['memory.event.line'] as (a: string, b: string, c: string) => string)('10:15', 'you', 'deleted');
  assert.equal(enLine, '10:15 deleted by you');
  assert.equal((ja['memory.size'] as (a: string) => string)('1,240'), '文字数 1,240 字');
  assert.equal((en['memory.size'] as (a: string) => string)('1,240'), '1,240 chars');
  assert.equal((ja['memory.context'] as (a: string, b: string) => string)('3,200', '7,348'), '会話に入る量 約 3,200 / 7,348 トークン');
  assert.equal((en['memory.context'] as (a: string, b: string) => string)('3,200', '7,348'), 'In a conversation: about 3,200 / 7,348 tokens');
  assert.equal((ja['memory.over'] as (a: string) => string)('3'), '3 件は会話に入りません。必要なときは Clive が memory_search で探します');
  assert.equal((en['memory.over'] as (a: string) => string)('3'), '3 will not fit in a conversation. Clive looks them up with memory_search when needed');
});
