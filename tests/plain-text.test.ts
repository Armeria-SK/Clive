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

test('plainLine: 絵文字を半分に割らずに max 文字に切る', () => {
  assert.equal(plainLine('あいうえお', 3), 'あいう');
  assert.equal(plainLine('😀😀', 1), '😀');
});

test('plainBlock: 改行は残し 3 つ以上続く改行は 2 つにする', () => {
  assert.equal(plainBlock('a\r\nb\n\n\n\nc', 100), 'a\nb\n\nc');
});

test('plainBlock: 制御文字を空白に、向きを変える文字を消す', () => {
  assert.equal(plainBlock('a\u0007b', 100), 'a b');
  assert.equal(plainBlock('x‮\ny', 100), 'x\ny');
});
