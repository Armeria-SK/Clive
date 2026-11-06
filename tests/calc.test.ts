import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, formatNumber, type CalcResult } from '../src/tools/builtin/calc-core.ts';

const ok = (expression: string): number => {
  const result = evaluate(expression);
  assert.equal(result.ok, true, expression);
  return (result as Extract<CalcResult, { ok: true }>).value;
};

const fail = (expression: string, code: string): void => {
  const result = evaluate(expression);
  assert.equal(result.ok, false, expression);
  assert.equal((result as Extract<CalcResult, { ok: false }>).code, code, expression);
};

test('計算: 四則とべき乗・余り', () => {
  assert.equal(ok('1+2*3'), 7);
  assert.equal(ok('2^3^2'), 512, 'べき乗は右結合');
  assert.equal(ok('-2^2'), -4, 'べき乗は符号より先に結ぶ');
  assert.equal(ok('(1+2)*3'), 9);
  assert.equal(ok('10 % 3'), 1);
});

test('計算: 関数・定数・丸め', () => {
  assert.equal(ok('sqrt(16)'), 4);
  assert.equal(ok('round(1.005,2)'), 1.01);
  assert.equal(ok('max(1,5,3)'), 5);
  assert.equal(ok('pi'), Math.PI);
});

test('計算: 表示は余計な桁を落とす', () => {
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
});

test('計算: 失敗のコード', () => {
  fail('1/0', 'not_finite');
  fail('foo(1)', 'unknown_name');
  fail('constructor', 'unknown_name');
  fail('2 +', 'syntax');
  fail('(1', 'syntax');
  fail('round(1,1.5)', 'bad_args');
  fail('1+'.repeat(300), 'too_long');
  fail('('.repeat(100) + '1' + ')'.repeat(100), 'too_deep');
});
