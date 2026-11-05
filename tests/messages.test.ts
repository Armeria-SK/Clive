import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CATALOGS } from '../src/shared/messages/index.ts';

const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/gu)].map(m => m[1]!).sort();

test('メッセージの表: 日本語と英語のキーが同じで、差し込みの名前も同じ', () => {
  for (const [domain, catalog] of Object.entries(CATALOGS)) {
    const { ja, en } = catalog.tables;
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ja).sort(), `${domain}: キーが同じ`);
    assert.equal(catalog.domain, domain);
    for (const key of Object.keys(ja)) {
      assert.deepEqual(placeholders((en as Record<string, string>)[key]!), placeholders((ja as Record<string, string>)[key]!), `${domain}.${key}: 差し込み`);
    }
  }
});

test('メッセージの表: 英語の文に日本語が混ざらない', () => {
  for (const [domain, catalog] of Object.entries(CATALOGS)) {
    for (const [key, text] of Object.entries(catalog.tables.en)) {
      assert.doesNotMatch(text as string, CJK, `${domain}.${key}`);
    }
  }
});

test('メッセージの表: 日本語の文は、段階 12b の前の出力と一字も違わない（tests/fixtures/messages-ja.json）', () => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/messages-ja.json', import.meta.url), 'utf8')) as Record<string, Record<string, string>>;
  const actual = Object.fromEntries(Object.entries(CATALOGS).map(([domain, catalog]) => [domain, catalog.tables.ja]));
  assert.deepEqual(actual, expected);
});
