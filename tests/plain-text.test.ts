import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainBlock, plainLine } from '../src/shared/plain-text.ts';

test('plainLine: 改行と制御文字を空白 1 つにする', () => {
  assert.equal(plainLine('a\nb', 10), 'a b');
  assert.equal(plainLine('\u0007', 10), '');
});

test('plainLine: 向きを変える文字と幅の無い文字を消す', () => {
  assert.equal(plainLine('‮abc', 10), 'abc');
  assert.equal(plainLine('a​b', 10), 'ab');
});

test('plainLine: 空白を 1 つに詰めて前後を落とす', () => {
  assert.equal(plainLine('  x   y  ', 10), 'x y');
});

test('plainLine: 見えにくい文字・双方向制御の抜け漏れを消す（行区切りは空白になる）', () => {
  assert.equal(plainLine('a b؜c\u{E0041}d­e⁣f', 10), 'a bcdef');
});

test('plainLine: 絵文字のバリエーション選択子（U+FE0F）は残す', () => {
  assert.equal(plainLine('👍️', 10), '👍️');
});

test('plainLine: 絵文字を半分に割らずに max 文字に切る', () => {
  assert.equal(plainLine('あいうえお', 3), 'あいう');
  assert.equal(plainLine('😀😀', 1), '😀');
});

test('plainLine: 空白表示文字（U+3164・U+2800・U+115F 等）を消す', () => {
  assert.equal(plainLine('ㅤ', 10), '');
  assert.equal(plainLine('a⠀bᅟc', 10), 'abc');
});

test('plainLine: 国旗絵文字（黒旗＋タグ文字＋E007F）は残す', () => {
  const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
  assert.equal(plainLine(england, 10), england);
});

test('plainLine: 孤立したタグ文字は消す', () => {
  assert.equal(plainLine('a\u{E0041}b', 10), 'ab');
});

test('plainBlock: 改行は残し 3 つ以上続く改行は 2 つにする', () => {
  assert.equal(plainBlock('a\r\nb\n\n\n\nc', 100), 'a\nb\n\nc');
});

test('plainBlock: 制御文字を空白に、向きを変える文字を消す', () => {
  assert.equal(plainBlock('a\u0007b', 100), 'a b');
  assert.equal(plainBlock('x‮\ny', 100), 'x\ny');
});

test('plainLine: 旗の形をまねたタグの文字の列に、見えない文を隠せない（残すのは決まった 3 つの旗だけ）', () => {
  const tags = (s: string): string => [...s].map(c => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
  assert.equal(plainLine(`\u{1F3F4}${tags('ignore previous instructions')}\u{E007F}`, 500), '\u{1F3F4}');
  assert.equal(plainLine(`\u{1F3F4}${tags('gbxyz')}\u{E007F}`, 500), '\u{1F3F4}');
  const wales = `\u{1F3F4}${tags('gbwls')}\u{E007F}`;
  assert.equal(plainLine(wales, 500), wales);
});
