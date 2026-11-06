import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OFFICE_TEXT_MAX, docxText, officeKind, xlsxText } from '../src/shared/office-text.ts';
import type { OfficeText } from '../src/shared/office-text.ts';
import { openZip, zipWrite } from '../src/shared/zip.ts';
import type { ZipArchive, ZipLimits } from '../src/shared/zip.ts';

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

test('docxText: タブ位置の定義（w:tabs の中の w:tab）はタブ文字にしない', () => {
  const text = docxText(makeZip(doc('<w:p><w:r><w:t>前</w:t></w:r></w:p><w:p><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs></w:pPr><w:r><w:t>見出し</w:t><w:tab/><w:t>3</w:t></w:r></w:p>')));
  assert.ok(text.ok);
  assert.equal(text.text, '前\n見出し\t3');
});

test('docxText: 小さな文字が大量に並んでも、足した文字の数で上限を守る', () => {
  let body = '';
  for (let i = 0; i < 40_000; i++) body += `<w:p><w:r><w:t>${String(i).padStart(10, 'x')}</w:t></w:r></w:p>`;
  const text = docxText(makeZip(doc(body)));
  assert.ok(text.ok);
  assert.equal(text.truncated, true);
  assert.ok(text.text.length <= OFFICE_TEXT_MAX, `length ${text.text.length}`);
});

const SHEET_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const LOOSE: Partial<ZipLimits> = { ratioFloor: 1 << 30 };

function xlsxZip(files: Record<string, string>, limits: Partial<ZipLimits> = {}): ZipArchive {
  const opened = openZip(zipWrite([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    ...Object.entries(files).map(([name, text]) => ({ name, data: Buffer.from(text, 'utf8') })),
  ]), limits);
  assert.ok(opened.ok, opened.ok ? '' : opened.reason);
  return opened.zip;
}

const workbookXml = (sheets: ReadonlyArray<readonly [string, string]>): string =>
  `<workbook ${SHEET_NS}><sheets>${sheets.map(([name, id], n) => `<sheet name="${name}" sheetId="${n + 1}" r:id="${id}"/>`).join('')}</sheets></workbook>`;
const relsXml = (rels: ReadonlyArray<readonly [string, string] | readonly [string, string, string]>): string =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map(([id, target, mode]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`).join('')}</Relationships>`;
const sheetXml = (rows: string): string => `<worksheet ${SHEET_NS}><sheetData>${rows}</sheetData></worksheet>`;
const sstXml = (items: string): string => `<sst ${SHEET_NS}>${items}</sst>`;
const inline = (ref: string, text: string): string => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const bare = (text: string): string => `<c t="inlineStr"><is><t>${text}</t></is></c>`;

function oneSheet(rows: string, extra: Record<string, string> = {}, limits: Partial<ZipLimits> = {}): ZipArchive {
  return xlsxZip({
    'xl/workbook.xml': workbookXml([['Sheet1', 'rId1']]),
    'xl/_rels/workbook.xml.rels': relsXml([['rId1', 'worksheets/sheet1.xml']]),
    'xl/worksheets/sheet1.xml': sheetXml(rows),
    ...extra,
  }, limits);
}

function textOf(result: OfficeText): string {
  assert.ok(result.ok, JSON.stringify(result));
  return result.text;
}

function reasonOf(result: OfficeText): string {
  assert.equal(result.ok, false);
  return result.ok ? '' : result.reason;
}

test('xlsxText: シートの順と見出し。共有の文字・数・inlineStr・b・str・e が出て、式は覚えている値だけ', () => {
  const zip = xlsxZip({
    'xl/workbook.xml': workbookXml([['売上', 'rId1'], ['メモ', 'rId2']]),
    'xl/_rels/workbook.xml.rels': relsXml([['rId1', 'worksheets/sheet1.xml'], ['rId2', 'worksheets/sheet2.xml']]),
    'xl/sharedStrings.xml': sstXml('<si><t>商品</t></si><si><t>注意</t></si>'),
    'xl/worksheets/sheet1.xml': sheetXml(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>3</v></c><c r="C1"><f>HYPERLINK("http://x","y")</f><v>y</v></c></row>'
      + `<row r="2">${inline('A2', '直接')}<c r="B2" t="b"><v>1</v></c><c r="C2" t="b"><v>0</v></c><c r="D2" t="str"><v>x</v></c><c r="E2" t="e"><v>#DIV/0!</v></c></row>`),
    'xl/worksheets/sheet2.xml': sheetXml('<row r="1"><c r="A1" t="s"><v>1</v></c></row>'),
  });
  const result = xlsxText(zip, 'ja');
  assert.equal(textOf(result), '[シート: 売上]\n商品\t3\ty\n直接\tTRUE\tFALSE\tx\t#DIV/0!\n\n[シート: メモ]\n注意');
  assert.equal(result.ok && result.truncated, false);
  assert.ok(!textOf(result).includes('HYPERLINK'));
});

test('xlsxText: 式だけで覚えている値の無いセルは空で、式の文字は出ない', () => {
  const text = textOf(xlsxText(oneSheet(`<row><c r="A1"><f>SUM(B1:B9)</f></c><c r="B1" t="str"><f>"secret"&amp;A9</f></c>${inline('C1', '本')}</row>`), 'ja'));
  assert.equal(text, '[シート: Sheet1]\n\t\t本');
});

test('xlsxText: ふりがな（rPh）は足さない。リッチな文字は連結する', () => {
  const zip = oneSheet(
    `<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>大阪</t><rPh sb="0" eb="2"><t>オオサカ</t></rPh></is></c></row>`,
    { 'xl/sharedStrings.xml': sstXml('<si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/></si><si><r><t>A</t></r><r><rPr><b/></rPr><t>B</t></r></si>') },
  );
  assert.equal(textOf(xlsxText(zip, 'ja')), '[シート: Sheet1]\n東京\tAB\t大阪');
});

test('xlsxText: 列のすき間はタブで埋め、r の無いセルは順に詰め、列の順に並べる', () => {
  assert.equal(textOf(xlsxText(oneSheet(`<row>${inline('A1', '値')}${inline('C1', '値')}</row>`), 'ja')), '[シート: Sheet1]\n値\t\t値');
  assert.equal(textOf(xlsxText(oneSheet(`<row>${bare('a')}${bare('b')}${bare('c')}</row>`), 'ja')), '[シート: Sheet1]\na\tb\tc');
  assert.equal(textOf(xlsxText(oneSheet(`<row>${inline('C1', 'c')}${inline('A1', 'a')}</row>`), 'ja')), '[シート: Sheet1]\na\t\tc');
  assert.equal(textOf(xlsxText(oneSheet(`<row>${inline('C2', 'c')}${bare('d')}</row>`), 'ja')), '[シート: Sheet1]\n\t\tc\td');
});

test('xlsxText: 読めない・大きすぎる r は前のセルの次の列。後ろの空のセルはタブにしない', () => {
  const rows = `<row>${inline('XFE1', 'a')}${inline('ZZZ1', 'b')}${inline('AAAA1', 'c')}${inline('A', 'd')}${inline('1', 'e')}${inline('ab-1', 'f')}</row>`;
  assert.equal(textOf(xlsxText(oneSheet(rows), 'ja')), '[シート: Sheet1]\na\tb\tc\td\te\tf');
  assert.equal(textOf(xlsxText(oneSheet(`<row>${inline('A1', 'x')}<c r="B1" s="3"/><c r="C1"><v></v></c></row>`), 'ja')), '[シート: Sheet1]\nx');
});

test('xlsxText: 空の行は出さず、行の番号のすき間に空の行を作らない', () => {
  const rows = `<row r="1">${inline('A1', 'a')}</row><row r="2"/><row r="3"><c r="A3"/></row><row r="5">${inline('A5', 'b')}</row><row r="1048576">${inline('A1048576', 'z')}</row>`;
  assert.equal(textOf(xlsxText(oneSheet(rows), 'ja')), '[シート: Sheet1]\na\nb\nz');
});

test('xlsxText: XFD1 のセル 1 つでも落ちず、出力は上限以下', () => {
  const text = textOf(xlsxText(oneSheet(`<row>${inline('XFD1', '端')}</row>`), 'ja'));
  assert.equal(text, `[シート: Sheet1]\n${'\t'.repeat(16_383)}端`);
  assert.ok(text.length <= OFFICE_TEXT_MAX);
});

test('xlsxText: 遠いセルと長い文字が重なっても、1 行は上限で打ち切る', () => {
  const big = 'あ'.repeat(150_000);
  const result = xlsxText(oneSheet(`<row>${inline('XFD1', big)}${inline('A1', big)}${inline('B1', big)}</row>`, {}, LOOSE), 'ja');
  assert.ok(result.ok);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= OFFICE_TEXT_MAX, `length ${result.text.length}`);
});

test('xlsxText: 同じ長い共有の文字を何度も指しても、上限で止まる', () => {
  const cells = Array.from({ length: 2000 }, (_, n) => `<c r="A${n + 1}" t="s"><v>0</v></c>`).join('');
  const result = xlsxText(oneSheet(`<row>${cells}</row>`, { 'xl/sharedStrings.xml': sstXml(`<si><t>${'い'.repeat(150_000)}</t></si>`) }, LOOSE), 'ja');
  assert.ok(result.ok);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= OFFICE_TEXT_MAX, `length ${result.text.length}`);
});

test('xlsxText: 行をたくさん足しても、合計は上限以下で truncated', () => {
  const rows = Array.from({ length: 600 }, (_, n) => `<row>${inline(`A${n + 1}`, `${n}`.padStart(4, '0') + 'う'.repeat(996))}</row>`).join('');
  const result = xlsxText(oneSheet(rows, {}, LOOSE), 'ja');
  assert.ok(result.ok);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= OFFICE_TEXT_MAX, `length ${result.text.length}`);
});

test('xlsxText: たどりの細工の Target を持つシートは飛ばされ、ほかのシートは読める', () => {
  const baitSheet = sheetXml(`<row>${inline('A1', 'SECRET')}</row>`);
  const forged: ReadonlyArray<string> = [
    '../../../etc/passwd.xml',
    '/xl/sharedStrings.xml',
    'worksheets/../../x.xml',
    '../docProps/sheet.xml',
    'worksheets/sub/s.xml',
    'worksheets/s.txt',
    '../xl/other/s.xml',
    'worksheets//s.xml',
    '/../xl/worksheets/s.xml',
    'http://example.com/xl/worksheets/s.xml',
    'sharedStrings.xml',
  ];
  const zip = xlsxZip({
    'xl/workbook.xml': workbookXml([...forged.map((_, n) => [`bad${n}`, `rF${n}`] as const), ['good', 'rOK']]),
    'xl/_rels/workbook.xml.rels': relsXml([...forged.map((target, n) => [`rF${n}`, target] as const), ['rOK', 'worksheets/ok.xml']]),
    'xl/sharedStrings.xml': sstXml(`<si><t>x</t></si>${inline('A1', 'SECRET')}`),
    'xl/worksheets/ok.xml': sheetXml(`<row>${inline('A1', 'OK')}</row>`),
    'xl/worksheets/x.xml': baitSheet,
    'x.xml': baitSheet,
    'docProps/sheet.xml': baitSheet,
    'xl/worksheets/sub/s.xml': baitSheet,
    'xl/worksheets/s.txt': baitSheet,
    'xl/other/s.xml': baitSheet,
    'xl/worksheets/s.xml': baitSheet,
  });
  const text = textOf(xlsxText(zip, 'ja'));
  assert.equal(text, '[シート: good]\nOK');
  assert.ok(!text.includes('SECRET'));
});

test('xlsxText: 全部が細工なら no_text。外のリンク（External）も使わない', () => {
  const bait = sheetXml(`<row>${inline('A1', 'SECRET')}</row>`);
  const forgedOnly = xlsxZip({
    'xl/workbook.xml': workbookXml([['a', 'r1'], ['b', 'r2'], ['c', 'r3']]),
    'xl/_rels/workbook.xml.rels': relsXml([['r1', '../../x.xml'], ['r2', '/xl/sharedStrings.xml'], ['r3', 'worksheets/s.xml', 'External']]),
    'xl/sharedStrings.xml': sstXml(inline('A1', 'SECRET')),
    'xl/worksheets/s.xml': bait,
    'x.xml': bait,
  });
  assert.equal(reasonOf(xlsxText(forgedOnly, 'ja')), 'no_text');
});

test('xlsxText: 根からの Target・./ と .. を含む正しいたどりは読める', () => {
  for (const target of ['/xl/worksheets/s.xml', './worksheets/s.xml', 'worksheets/./s.xml', '../xl/worksheets/s.xml', 'worksheets/s.xml']) {
    const zip = xlsxZip({
      'xl/workbook.xml': workbookXml([['n', 'r1']]),
      'xl/_rels/workbook.xml.rels': relsXml([['r1', target]]),
      'xl/worksheets/s.xml': sheetXml(`<row>${inline('A1', '読')}</row>`),
    });
    assert.equal(textOf(xlsxText(zip, 'ja')), '[シート: n]\n読', target);
  }
});

test('xlsxText: id の前置きは何でもよい。前置きの無い sheetId は id と見なさない', () => {
  const zip = xlsxZip({
    'xl/workbook.xml': `<workbook xmlns:q="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="p" sheetId="1" q:id="r1"/><sheet name="np" sheetId="r2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relsXml([['r1', 'worksheets/a.xml'], ['r2', 'worksheets/b.xml']]),
    'xl/worksheets/a.xml': sheetXml(`<row>${inline('A1', 'A')}</row>`),
    'xl/worksheets/b.xml': sheetXml(`<row>${inline('A1', 'B')}</row>`),
  });
  assert.equal(textOf(xlsxText(zip, 'ja')), '[シート: p]\nA');
});

test('xlsxText: .rels が無ければ sheet1.xml から番号順。名前の合う部品が無いシートは飛ばす', () => {
  const zip = xlsxZip({
    'xl/workbook.xml': workbookXml([['一', 'a'], ['二', 'b'], ['三', 'c']]),
    'xl/worksheets/sheet1.xml': sheetXml(`<row>${inline('A1', '1')}</row>`),
    'xl/worksheets/sheet3.xml': sheetXml(`<row>${inline('A1', '3')}</row>`),
  });
  assert.equal(textOf(xlsxText(zip, 'ja')), '[シート: 一]\n1\n\n[シート: 三]\n3');
});

test('xlsxText: 共有の文字の番号が範囲外・数でないときは空', () => {
  const rows = `<row>${['999', '-1', '1e3', 'abc', ''].map((v, n) => `<c r="${'ABCDE'[n]}1" t="s"><v>${v}</v></c>`).join('')}${inline('F1', 'z')}</row>`;
  const zip = oneSheet(rows, { 'xl/sharedStrings.xml': sstXml('<si><t>0番</t></si>') });
  assert.equal(textOf(xlsxText(zip, 'ja')), '[シート: Sheet1]\n\t\t\t\t\tz');
});

test('xlsxText: 共有の文字は 200,000 個まで。超えた分は空で、truncated', () => {
  const items = '<si><t>a</t></si>'.repeat(199_999) + '<si><t>LAST</t></si><si><t>OVER</t></si>';
  const zip = oneSheet('<row><c r="A1" t="s"><v>199999</v></c><c r="B1" t="s"><v>200000</v></c></row>', { 'xl/sharedStrings.xml': sstXml(items) }, LOOSE);
  const result = xlsxText(zip, 'ja');
  assert.equal(textOf(result), '[シート: Sheet1]\nLAST');
  assert.equal(result.ok && result.truncated, true);
  assert.equal(result.ok && result.countLimit, true, '文字数の上限ではなく、個数の上限で切れた印');
});

test('xlsxText: 読むセルの合計は 1,000,000 個まで。超えたら止めて truncated', () => {
  const over = xlsxText(oneSheet(`<row r="1">${inline('A1', 'x')}</row><row r="2">${'<c/>'.repeat(1_000_000)}</row>`, {}, LOOSE), 'ja');
  assert.equal(textOf(over), '[シート: Sheet1]\nx');
  assert.equal(over.ok && over.truncated, true);
  assert.equal(over.ok && over.countLimit, true);
  const exact = xlsxText(oneSheet(`<row r="1">${inline('A1', 'x')}</row><row r="2">${'<c/>'.repeat(999_999)}</row>`, {}, LOOSE), 'ja');
  assert.equal(textOf(exact), '[シート: Sheet1]\nx');
  assert.equal(exact.ok && exact.truncated, false);
});

test('xlsxText: シートは 256 個まで。超えた分は読まず truncated', () => {
  const ids = Array.from({ length: 257 }, (_, n) => `r${n + 1}`);
  const files: Record<string, string> = {
    'xl/workbook.xml': workbookXml(ids.map((id, n) => [`S${n + 1}`, id] as const)),
    'xl/_rels/workbook.xml.rels': relsXml(ids.map((id, n) => [id, `worksheets/s${n + 1}.xml`] as const)),
  };
  ids.forEach((_, n) => { files[`xl/worksheets/s${n + 1}.xml`] = sheetXml(`<row>${inline('A1', `v${n + 1}`)}</row>`); });
  const result = xlsxText(xlsxZip(files), 'ja');
  const text = textOf(result);
  assert.ok(text.includes('[シート: S256]\nv256'));
  assert.ok(!text.includes('S257'));
  assert.equal(result.ok && result.truncated, true);
  assert.equal(result.ok && result.countLimit, true);
});

test('xlsxText: 文字数の上限で切れたときは truncated だけで、個数の上限の印は付かない。両方に達したら文字数の方だけ', () => {
  const chars = xlsxText(oneSheet(`<row>${inline('A1', 'a'.repeat(OFFICE_TEXT_MAX + 10))}</row>`), 'ja');
  assert.equal(chars.ok && chars.truncated, true);
  assert.equal(chars.ok && chars.countLimit, undefined);
  const items = '<si><t>a</t></si>'.repeat(200_001);
  const both = xlsxText(oneSheet(`<row>${inline('A1', 'b'.repeat(OFFICE_TEXT_MAX + 10))}</row>`, { 'xl/sharedStrings.xml': sstXml(items) }, LOOSE), 'ja');
  assert.equal(both.ok && both.truncated, true);
  assert.equal(both.ok && both.countLimit, undefined);
});

test('xlsxText: xl/workbook.xml の無い ZIP は damaged', () => {
  const result = xlsxText(xlsxZip({ 'xl/worksheets/sheet1.xml': sheetXml('') }), 'ja');
  assert.equal(reasonOf(result), 'damaged');
  assert.equal(!result.ok && result.detail, 'xl/workbook.xml');
});

test('xlsxText: DOCTYPE は workbook・.rels・共有の文字・シートのどれにあっても dtd', () => {
  const base: Record<string, string> = {
    'xl/workbook.xml': workbookXml([['n', 'r1']]),
    'xl/_rels/workbook.xml.rels': relsXml([['r1', 'worksheets/s.xml']]),
    'xl/sharedStrings.xml': sstXml('<si><t>a</t></si>'),
    'xl/worksheets/s.xml': sheetXml(`<row>${inline('A1', 'a')}</row>`),
  };
  for (const name of Object.keys(base)) {
    const zip = xlsxZip({ ...base, [name]: `<!DOCTYPE x [<!ENTITY e "v">]>${base[name]}` });
    assert.equal(reasonOf(xlsxText(zip, 'ja')), 'dtd', name);
  }
});

test('xlsxText: 閉じていない XML は damaged。全部が空のシートは no_text', () => {
  assert.equal(reasonOf(xlsxText(oneSheet('<row><c r="A1">'), 'ja')), 'damaged');
  assert.equal(reasonOf(xlsxText(oneSheet('<row><c r="A1"/></row><row/>'), 'ja')), 'no_text');
});

test('xlsxText: 先頭の BOM があっても読める', () => {
  const zip = xlsxZip({
    'xl/workbook.xml': '\uFEFF' + workbookXml([['n', 'r1']]),
    'xl/_rels/workbook.xml.rels': '\uFEFF' + relsXml([['r1', 'worksheets/s.xml']]),
    'xl/sharedStrings.xml': '\uFEFF' + sstXml('<si><t>字</t></si>'),
    'xl/worksheets/s.xml': '\uFEFF' + sheetXml('<row><c r="A1" t="s"><v>0</v></c></row>'),
  });
  assert.equal(textOf(xlsxText(zip, 'ja')), '[シート: n]\n字');
});

test('xlsxText: 英語の language では見出しに日本語の文字が無い。見出しの名前の制御文字は空白にする', () => {
  const zip = xlsxZip({
    'xl/workbook.xml': workbookXml([['Sales', 'r1'], ['Bad&#10;Name', 'r2']]),
    'xl/_rels/workbook.xml.rels': relsXml([['r1', 'worksheets/a.xml'], ['r2', 'worksheets/b.xml']]),
    'xl/worksheets/a.xml': sheetXml(`<row>${inline('A1', '1')}</row>`),
    'xl/worksheets/b.xml': sheetXml(`<row>${inline('A1', '2')}</row>`),
  });
  const text = textOf(xlsxText(zip, 'en'));
  assert.equal(text, '[Sheet: Sales]\n1\n\n[Sheet: Bad Name]\n2');
  assert.ok(/^[\x20-\x7e\n]*$/.test(text));
});

test('xlsxText: 遠い列のセルが何千行あっても、出力は上限以下で truncated', () => {
  const rows = Array.from({ length: 3000 }, (_, n) => `<row>${inline(`XFD${n + 1}`, '端')}</row>`).join('');
  const result = xlsxText(oneSheet(rows), 'ja');
  assert.ok(result.ok);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= OFFICE_TEXT_MAX, `length ${result.text.length}`);
});

test('xlsxText: 同じ Id の Relationship が 2 つあれば、先の 1 つだけを見る（先が細工なら飛ばす）', () => {
  const zip = xlsxZip({
    'xl/workbook.xml': workbookXml([['n', 'r1']]),
    'xl/_rels/workbook.xml.rels': relsXml([['r1', '../../x.xml'], ['r1', 'worksheets/ok.xml']]),
    'xl/worksheets/ok.xml': sheetXml(`<row>${inline('A1', 'OK')}</row>`),
  });
  assert.equal(reasonOf(xlsxText(zip, 'ja')), 'no_text');
});

test('docxText・xlsxText: 上限の切れ目がサロゲートペアの途中なら、片割れを残さない', () => {
  const emoji = '\u{1F600}';
  const docx = docxText(makeZip(doc(`<w:p><w:r><w:t>${'a'.repeat(OFFICE_TEXT_MAX - 1)}${emoji}</w:t></w:r></w:p>`)));
  assert.ok(docx.ok);
  assert.equal(docx.truncated, true);
  assert.ok(!/[\ud800-\udbff]$/.test(docx.text));
  const prefix = '[シート: Sheet1]\n';
  const xlsx = xlsxText(oneSheet(`<row>${inline('A1', 'a'.repeat(OFFICE_TEXT_MAX - prefix.length - 1) + emoji)}</row>`), 'ja');
  assert.ok(xlsx.ok);
  assert.equal(xlsx.truncated, true);
  assert.ok(!/[\ud800-\udbff]$/.test(xlsx.text));
  assert.equal(xlsx.text.length, OFFICE_TEXT_MAX - 1);
});

test('xlsxText: v の無い b のセルは FALSE にせず空として扱う', () => {
  assert.equal(textOf(xlsxText(oneSheet(`<row><c r="A1" t="b"/><c r="B1" t="b"><v>0</v></c>${inline('C1', 'x')}</row>`), 'ja')), '[シート: Sheet1]\n\tFALSE\tx');
});

test('xlsxText: セルの文字のタブ・改行・復帰は空白にして、表の形を崩さず、偽の行や [シート: …] の見出しを作らせない', () => {
  const zip = oneSheet(
    `<row r="1">${inline('A1', 'x&#9;y')}${inline('B1', 'p&#10;q')}<c r="C1" t="s"><v>0</v></c><c r="D1" t="str"><v>m&#13;n</v></c></row>`
    + `<row r="2">${inline('A2', 'end\n[シート: 偽]\r\nfake&#9;row')}</row>`
    + `<row r="3">${inline('A3', '\n[シート: 偽]')}</row>`,
    { 'xl/sharedStrings.xml': sstXml('<si><t>s1&#10;s2</t></si>') },
  );
  const text = textOf(xlsxText(zip, 'ja'));
  assert.equal(text, '[シート: Sheet1]\nx y\tp q\ts1 s2\tm n\nend [シート: 偽]  fake row\n [シート: 偽]');
  const lines = text.split('\n');
  assert.equal(lines.length, 4, '見出し 1 行 + 行 3 つ');
  assert.deepEqual(lines.filter((line) => line.startsWith('[シート:')), ['[シート: Sheet1]']);
  assert.equal(lines[1]!.split('\t').length, 4, '1 行目は 4 つのセル');
});
