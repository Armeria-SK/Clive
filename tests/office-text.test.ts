import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OFFICE_TEXT_MAX, docxText, officeKind } from '../src/shared/office-text.ts';
import { openZip, zipWrite } from '../src/shared/zip.ts';
import type { ZipArchive } from '../src/shared/zip.ts';

const CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';

function makeZip(documentXml: string): ZipArchive {
  const opened = openZip(zipWrite([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ]));
  assert.ok(opened.ok);
  return opened.zip;
}

const doc = (body: string): string => `<w:document><w:body>${body}</w:body></w:document>`;

test('docxText: 段落ごとに改行、タブはタブ文字', () => {
  const text = docxText(makeZip(doc('<w:p><w:r><w:t>こんにちは</w:t></w:r></w:p><w:p><w:r><w:t>二行目</w:t><w:tab/><w:t>タブ</w:t></w:r></w:p>')));
  assert.ok(text.ok);
  assert.equal(text.text, 'こんにちは\n二行目\tタブ');
  assert.equal(text.truncated, false);
});

test('docxText: フィールドの命令と消した文は出さない', () => {
  const text = docxText(makeZip(doc('<w:p><w:r><w:t>本文</w:t></w:r><w:r><w:instrText>HYPERLINK "x"</w:instrText></w:r><w:r><w:delText>消した</w:delText></w:r></w:p>')));
  assert.ok(text.ok);
  assert.equal(text.text, '本文');
});

test('docxText: 前置きが w: でなく x: でも読める', () => {
  const text = docxText(makeZip('<x:document><x:body><x:p><x:r><x:t>読み</x:t></x:r></x:p></x:body></x:document>'));
  assert.ok(text.ok);
  assert.equal(text.text, '読み');
});

test('docxText: word/document.xml が無い ZIP は damaged', () => {
  const opened = openZip(zipWrite([{ name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') }]));
  assert.ok(opened.ok);
  const text = docxText(opened.zip);
  assert.equal(text.ok, false);
  if (!text.ok) {
    assert.equal(text.reason, 'damaged');
    assert.equal(text.detail, 'word/document.xml');
  }
});

test('docxText: DOCTYPE 入りは dtd', () => {
  const text = docxText(makeZip('<!DOCTYPE w:document><w:document><w:body><w:p><w:r><w:t>あ</w:t></w:r></w:p></w:body></w:document>'));
  assert.equal(text.ok, false);
  if (!text.ok) assert.equal(text.reason, 'dtd');
});

test('docxText: w:p を閉じない XML は damaged', () => {
  const text = docxText(makeZip('<w:document><w:body><w:p><w:r><w:t>あ</w:t></w:r></w:body></w:document>'));
  assert.equal(text.ok, false);
  if (!text.ok) {
    assert.equal(text.reason, 'damaged');
    assert.equal(text.detail, 'xml');
  }
});

test('docxText: 文字の無い段落だけなら no_text', () => {
  const text = docxText(makeZip(doc('<w:p><w:r><w:t></w:t></w:r></w:p>')));
  assert.equal(text.ok, false);
  if (!text.ok) assert.equal(text.reason, 'no_text');
});

test('docxText: 上限を超えたら truncation で止める', () => {
  const text = docxText(makeZip(doc(`<w:p><w:r><w:t>${'あ'.repeat(250_000)}</w:t></w:r></w:p>`)));
  assert.ok(text.ok);
  assert.equal(text.truncated, true);
  assert.ok(text.text.length <= OFFICE_TEXT_MAX);
});

test('officeKind: 先頭のバイトで zip・cfb・other を分ける', () => {
  assert.equal(officeKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), 'zip');
  assert.equal(officeKind(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), 'cfb');
  assert.equal(officeKind(Buffer.from('%PDF-1.7')), 'other');
});
