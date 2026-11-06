import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { csvText, startsLikeFormula } from '../src/tools/builtin/table-core.ts';

test('表: startsLikeFormula は式の始まりを見る', () => {
  for (const t of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx', '\uFF1D1']) {
    assert.equal(startsLikeFormula(t), true, `true: ${JSON.stringify(t)}`);
  }
  for (const t of ['a=1', '', ' =1', '1-2']) {
    assert.equal(startsLikeFormula(t), false, `false: ${JSON.stringify(t)}`);
  }
});

test('表: csvText は式を無害化して引用符を逃す', () => {
  const { text, neutralized } = csvText([
    ['=HYPERLINK("http://evil","x")', 1, null],
    ['a,b', 'he said "hi"', -5],
  ]);
  assert.equal(text, '\uFEFF' + '"\'=HYPERLINK(""http://evil"",""x"")",1,\r\n"a,b","he said ""hi""",-5\r\n');
  assert.equal(neutralized, 1, '数の -5 は無害化しない');
});

test('表: 文字の -5 は先頭に ' + "'" + ' が付く', () => {
  const { text, neutralized } = csvText([['-5']]);
  assert.equal(text, '\uFEFF' + "'" + '-5\r\n');
  assert.equal(neutralized, 1);
});

test('表: 改行を含むセルは囲われる', () => {
  const { text } = csvText([['a\nb']]);
  assert.equal(text, '\uFEFF' + '"a\nb"\r\n');
});

test('表: タブのセルは ' + "'" + ' が付いて囲われない', () => {
  const { text, neutralized } = csvText([['\tx']]);
  assert.equal(text, '\uFEFF' + "'" + '\tx\r\n');
  assert.equal(neutralized, 1);
});

test('表: 先頭 3 バイトは BOM', () => {
  const { text } = csvText([['a']]);
  assert.equal(Buffer.from(text, 'utf8').subarray(0, 3).toString('hex'), 'efbbbf');
});

test('表: 有限でない数は投げる', () => {
  assert.throws(() => csvText([[Infinity]]));
});
