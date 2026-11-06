import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { columnName, csvText, startsLikeFormula, xlsxBytes, xmlEscape } from '../src/tools/builtin/table-core.ts';
import { openZip } from '../src/shared/zip.ts';
import { xlsxText } from '../src/shared/office-text.ts';

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

test('表: columnName は列番号を文字にする', () => {
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(25), 'Z');
  assert.equal(columnName(26), 'AA');
  assert.equal(columnName(51), 'AZ');
  assert.equal(columnName(52), 'BA');
  assert.equal(columnName(701), 'ZZ');
  assert.equal(columnName(702), 'AAA');
  assert.equal(columnName(16383), 'XFD');
});

test('表: xmlEscape は特殊文字を逃し入れられない文字を落とす', () => {
  assert.equal(xmlEscape('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
  const dropped = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(0xFFFE) + String.fromCharCode(0xD800) + 'c';
  assert.equal(xmlEscape(dropped), 'abc');
  assert.equal(xmlEscape('a\tb\nc'), 'a\tb\nc');
});

test('表: xlsxBytes の往復は xlsxText で読める', () => {
  const { bytes, neutralized } = xlsxBytes([
    ['名前', '数'],
    ['りんご', 3],
    ['=1+1', null, -2.5],
  ]);
  assert.equal(neutralized, 1, '=1+1 のセルを無害化');
  const opened = openZip(bytes);
  assert.equal(opened.ok, true);
  const result = xlsxText(opened.zip, 'ja');
  assert.equal(result.ok, true);
  const text = result.ok ? result.text : '';
  assert.ok(text.includes('名前\t数'), '1 行目');
  assert.ok(text.includes('りんご\t3'), '2 行目');
  assert.ok(text.includes('=1+1\t\t-2.5'), '3 行目');
});

test('表: xlsx の式は見かけを変えず quotePrefix で無害化する', () => {
  const { bytes } = xlsxBytes([['=1+1']]);
  const opened = openZip(bytes);
  assert.equal(opened.ok, true);
  const sheet = opened.zip.read('xl/worksheets/sheet1.xml');
  assert.equal(sheet.ok, true);
  const sheetXml = sheet.ok ? sheet.data.toString('utf8') : '';
  assert.ok(!sheetXml.includes('<f>'), '式要素を書かない');
  assert.ok(sheetXml.includes('s="1"'), 'quotePrefix の書式を付ける');
  assert.ok(!sheetXml.includes("'=1+1"), '先頭に ' + "'" + ' を足さない');
  const styles = opened.zip.read('xl/styles.xml');
  assert.equal(styles.ok, true);
  assert.ok(styles.ok && styles.data.toString('utf8').includes('quotePrefix="1"'), '書式に quotePrefix がある');
});

test('表: 制御文字を含むセルは落として読める', () => {
  const { bytes } = xlsxBytes([['a' + String.fromCharCode(1) + 'b']]);
  const opened = openZip(bytes);
  assert.equal(opened.ok, true);
  const result = xlsxText(opened.zip, 'ja');
  assert.equal(result.ok, true, 'damaged にならない');
  const text = result.ok ? result.text : '';
  assert.ok(text.includes('ab'), '制御文字は落ちる');
  assert.ok(!text.includes(String.fromCharCode(1)), '制御文字は読めない');
});

test('表: xlsxBytes は同じ入力で同じバイトを返す', () => {
  const rows = [['a', 1], ['=x', null]];
  assert.ok(Buffer.compare(xlsxBytes(rows).bytes, xlsxBytes(rows).bytes) === 0);
});
