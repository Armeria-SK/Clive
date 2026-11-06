import assert from 'node:assert/strict';
import fs, { mkdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { zipWrite } from '../src/shared/zip.ts';
import { ApprovalBroker, approvalPublic } from '../src/tools/approvals.ts';
import { DOC_MAX_BYTES, docRead } from '../src/tools/builtin/docs.ts';
import { xlsxBytes } from '../src/tools/builtin/table-core.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// tests/file-search.test.ts の setup を写したもの。registry には docRead だけ
function setup(t: { after: (fn: () => void) => void }, mutate: (c: AppConfig) => void = () => undefined) {
  const paths: AppPaths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(join(paths.data, 'reference'), { recursive: true });
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }, { path: 'reference', mode: 'read' }];
  mutate(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const events: RunEvent[] = [];
  const approvals = new ApprovalBroker(db, e => events.push(e.type === 'requested'
    ? { type: 'approval.requested', runId: e.view.runId, conversationId: e.view.conversationId, approval: approvalPublic(e.view) }
    : { type: 'approval.resolved', runId: e.view.runId, conversationId: e.view.conversationId, approvalId: e.view.id, outcome: e.outcome }));
  const registry = new ToolRegistry().register(docRead);
  const policy = buildPolicy(parsed, paths);
  const controller = new AbortController();
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: controller.signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const call = (args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name: 'doc_read', arguments: args }, c, { registry, approvals, db, emit: e => events.push(e), conversationAutoRead: () => false });
  return { paths, ctx, call, events };
}

// tests/uploads.test.ts の tinyPdf を写したもの（その試験を import すると、あちらの試験も動いてしまうため）
function tinyPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 10 100 Td (${text}) Tj ET`;
  return Buffer.from([
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${content.length} >> stream`, content, 'endstream endobj',
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    'trailer << /Root 1 0 R >>', '%%EOF', '',
  ].join('\n'), 'latin1');
}

const CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
const zipOf = (documentXml: string): Buffer => zipWrite([
  { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
  { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
]);
const para = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const docxBytes = (...texts: string[]): Buffer => zipOf(`<w:document><w:body>${texts.map(para).join('')}</w:body></w:document>`);
const CFB_HEAD = Buffer.from('D0CF11E0A1B11AE1', 'hex');
const JAPANESE = /[\u3000-\u9fff\uff00-\uffef]/u;

function put(s: ReturnType<typeof setup>, name: string, data: Buffer | string): void {
  const file = join(s.paths.workspace, name);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, data);
}

test('doc_read: pdf・docx・xlsx の本文を文字で返す', async t => {
  const s = setup(t);
  put(s, 'a.pdf', tinyPdf('Hello PDF'));
  put(s, 'a.docx', docxBytes('first line', 'second line'));
  put(s, 'a.xlsx', xlsxBytes([['name', 'count'], ['apple', 3]]).bytes);
  const pdf = await s.call({ path: 'a.pdf' });
  assert.equal(pdf.decision, 'allow');
  assert.ok(!pdf.output.isError);
  assert.match(pdf.output.content, /Hello PDF/u);
  const docx = await s.call({ path: 'a.docx' });
  assert.equal(docx.decision, 'allow');
  assert.equal(docx.output.content, 'first line\nsecond line');
  const xlsx = await s.call({ path: 'a.xlsx' });
  assert.equal(xlsx.decision, 'allow');
  assert.equal(xlsx.output.content, '[シート: Sheet1]\nname\tcount\napple\t3');
});

test('doc_read: 拡張子は大文字でも読む', async t => {
  const s = setup(t);
  put(s, 'UP.DOCX', docxBytes('upper'));
  const out = await s.call({ path: 'UP.DOCX' });
  assert.equal(out.output.content, 'upper');
});

test('doc_read: offset と limit で一部だけ読み、続きは file.more の文で知らせる', async t => {
  const s = setup(t);
  put(s, 'a.docx', docxBytes('one', 'two', 'three'));
  const out = await s.call({ path: 'a.docx', offset: 2, limit: 1 });
  assert.equal(out.output.content, 'two\n\n[3 行中 2〜2 行目。続きは offset=3 で読めます]');
  const last = await s.call({ path: 'a.docx', offset: 3, limit: 5 });
  assert.equal(last.output.content, 'three');
});

test('doc_read: 拡張子と中身が合わないものは断る', async t => {
  const s = setup(t);
  put(s, 'a.txt', 'plain');
  put(s, 'old.xls', Buffer.concat([CFB_HEAD, Buffer.alloc(64)]));
  put(s, 'fake.docx', 'this is only text');
  put(s, 'x.pdf', 'not a pdf');
  put(s, 'locked.docx', Buffer.concat([CFB_HEAD, Buffer.alloc(64)]));
  put(s, 'real.docx', docxBytes('text'));
  put(s, 'wrong.pdf', docxBytes('text'));
  const unsupported = await s.call({ path: 'a.txt' });
  assert.equal(unsupported.output.isError, true);
  assert.match(unsupported.output.content, /読める形は \.pdf \.docx \.xlsx だけです: a\.txt/u);
  const xls = await s.call({ path: 'old.xls' });
  assert.equal(xls.output.isError, true);
  assert.match(xls.output.content, /読める形は/u);
  const fake = await s.call({ path: 'fake.docx' });
  assert.equal(fake.output.isError, true);
  assert.match(fake.output.content, /拡張子（\.docx）と中身の形が合いません: fake\.docx/u);
  const locked = await s.call({ path: 'locked.docx' });
  assert.equal(locked.output.isError, true);
  assert.match(locked.output.content, /パスワード付きか、古い形式/u);
  const pdf = await s.call({ path: 'x.pdf' });
  assert.equal(pdf.output.isError, true);
  assert.match(pdf.output.content, /拡張子（\.pdf）と中身の形が合いません: x\.pdf/u);
  const wrong = await s.call({ path: 'wrong.pdf' });
  assert.equal(wrong.output.isError, true);
  assert.match(wrong.output.content, /拡張子（\.pdf）と中身の形が合いません/u);
});

test('doc_read: 無い・フォルダ・壊れた・文字の無いファイルはエラーの文で返す', async t => {
  const s = setup(t);
  mkdirSync(join(s.paths.workspace, 'dir.pdf'));
  put(s, 'broken.docx', Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.from('junk junk junk')]));
  put(s, 'blank.docx', docxBytes());
  put(s, 'nogap.docx', zipWrite([{ name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') }]));
  const missing = await s.call({ path: 'missing.pdf' });
  assert.equal(missing.output.isError, true);
  assert.match(missing.output.content, /ファイルがありません: missing\.pdf/u);
  const dir = await s.call({ path: 'dir.pdf' });
  assert.equal(dir.output.isError, true);
  assert.match(dir.output.content, /フォルダです: dir\.pdf/u);
  const broken = await s.call({ path: 'broken.docx' });
  assert.equal(broken.output.isError, true);
  assert.match(broken.output.content, /壊れたファイルのようです（damaged）/u);
  const blank = await s.call({ path: 'blank.docx' });
  assert.equal(blank.output.isError, true);
  assert.match(blank.output.content, /文字が見つかりませんでした: blank\.docx/u);
  const nogap = await s.call({ path: 'nogap.docx' });
  assert.equal(nogap.output.isError, true);
  assert.match(nogap.output.content, /壊れたファイルのようです（word\/document\.xml）/u);
});

test('doc_read: 大きさの上限は、読む前に stat で確かめる（中身は読まない）', async t => {
  const s = setup(t);
  put(s, 'big.pdf', Buffer.alloc(DOC_MAX_BYTES + 1));
  put(s, 'edge.pdf', Buffer.alloc(DOC_MAX_BYTES));
  const out = await s.call({ path: 'big.pdf' });
  assert.equal(out.decision, 'allow');
  assert.equal(out.output.isError, true);
  assert.match(out.output.content, /大きすぎるファイルです（20,971,521 バイト。20,971,520 バイトまで）/u);
  const edge = await s.call({ path: 'edge.pdf' });
  assert.match(edge.output.content, /拡張子（\.pdf）と中身の形が合いません/u, '上限ちょうどは大きさでは断らず、中身まで進む');
});

test('doc_read: 圧縮率の高い項目（ZIP 爆弾）は展開せずに断る', async t => {
  const s = setup(t);
  put(s, 'bomb.docx', zipOf(`<w:document>${' '.repeat(2_000_000)}</w:document>`));
  const out = await s.call({ path: 'bomb.docx' });
  assert.equal(out.output.isError, true);
  assert.match(out.output.content, /展開すると大きすぎるため読みません（ratio）/u);
});

test('doc_read: DOCTYPE 入りの docx は読まない', async t => {
  const s = setup(t);
  put(s, 'dtd.docx', zipOf(`<!DOCTYPE w:document [<!ENTITY x "y">]><w:document><w:body>${para('&x;')}</w:body></w:document>`));
  const out = await s.call({ path: 'dtd.docx' });
  assert.equal(out.output.isError, true);
  assert.match(out.output.content, /文書型宣言（DOCTYPE）か実体の宣言を含むため読みません/u);
});

test('doc_read: 長い文書は 200,000 文字で打ち切り、そう書き添える（docx も pdf も）', async t => {
  const s = setup(t);
  put(s, 'long.docx', docxBytes(...Array.from({ length: 1000 }, () => 'a'.repeat(250))));
  put(s, 'short.docx', docxBytes('short'));
  put(s, 'long.pdf', tinyPdf('b'.repeat(250_000)));
  const docx = await s.call({ path: 'long.docx', limit: 1 });
  assert.ok(docx.output.content.endsWith('[長いため、取り出した文字を 200,000 文字で打ち切りました]'));
  // PDF の見本は 1 行しかないので、パイプラインの出力の切り詰めを通さず、execute を直接呼ぶ
  const pdf = await docRead.execute({ path: 'long.pdf', limit: 1 }, s.ctx);
  assert.ok(pdf.content.endsWith('[長いため、取り出した文字を 200,000 文字で打ち切りました]'));
  assert.ok(pdf.content.length > 200_000);
  const short = await s.call({ path: 'short.docx' });
  assert.doesNotMatch(short.output.content, /打ち切り/u);
});

test('doc_read: 作業フォルダの外・秘密・禁止の場所は断り、読むだけのフォルダは読める', async t => {
  const s = setup(t, c => { c.tools.deny = ['workspace/locked']; });
  put(s, 'secrets/a.docx', docxBytes('secret text'));
  put(s, 'locked/a.docx', docxBytes('locked text'));
  writeFileSync(join(s.paths.data, 'outside.pdf'), tinyPdf('Outside text'));
  writeFileSync(join(s.paths.data, 'reference', 'r.docx'), docxBytes('reference text'));
  const outside = await s.call({ path: '../outside.pdf' });
  assert.equal(outside.decision, 'deny');
  assert.doesNotMatch(outside.output.content, /Outside text/u);
  const secret = await s.call({ path: 'secrets/a.docx' });
  assert.equal(secret.decision, 'deny');
  assert.doesNotMatch(secret.output.content, /secret text/u);
  const locked = await s.call({ path: 'locked/a.docx' });
  assert.equal(locked.decision, 'deny');
  assert.doesNotMatch(locked.output.content, /locked text/u);
  const reference = await s.call({ path: join(s.paths.data, 'reference', 'r.docx') });
  assert.equal(reference.decision, 'allow');
  assert.equal(reference.output.content, 'reference text');
});

test('doc_read: execute を直接呼んでも、外のパスは読まない', async t => {
  const s = setup(t);
  writeFileSync(join(s.paths.data, 'outside.pdf'), tinyPdf('Outside text'));
  const out = await docRead.execute({ path: '../outside.pdf' }, s.ctx);
  assert.equal(out.isError, true);
  assert.doesNotMatch(out.content, /Outside text/u);
});

test('doc_read: 読めずに投げられた失敗は、パスを含む message を出さずコードだけ返す', async t => {
  const s = setup(t);
  put(s, 'unreadable.pdf', tinyPdf('x'));
  const original = fs.readFileSync;
  const spy = mock.method(fs, 'readFileSync', ((path: unknown, ...rest: unknown[]) => {
    if (String(path).endsWith('unreadable.pdf')) throw Object.assign(new Error("EACCES: permission denied, open 'C:\\hidden-place\\unreadable.pdf'"), { code: 'EACCES' });
    return (original as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  try {
    const out = await s.call({ path: 'unreadable.pdf' });
    assert.equal(out.output.isError, true);
    assert.equal(out.output.content, '失敗しました: EACCES');
    assert.doesNotMatch(out.output.content, /hidden-place/u);
    assert.equal(spy.mock.callCount() > 0, true);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('doc_read: 英語の設定では、結果にも失敗の文にも日本語が出ない', async t => {
  const s = setup(t, c => { c.language = 'en'; });
  mkdirSync(join(s.paths.workspace, 'dir.pdf'));
  put(s, 'a.xlsx', xlsxBytes([['name', 'count'], ['apple', 3]]).bytes);
  put(s, 'a.docx', docxBytes('one', 'two', 'three'));
  put(s, 'long.docx', docxBytes(...Array.from({ length: 1000 }, () => 'a'.repeat(250))));
  put(s, 'a.txt', 'plain');
  put(s, 'fake.docx', 'only text');
  put(s, 'locked.docx', Buffer.concat([CFB_HEAD, Buffer.alloc(64)]));
  put(s, 'broken.docx', Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.from('junk junk junk')]));
  put(s, 'blank.docx', docxBytes());
  put(s, 'big.pdf', Buffer.alloc(DOC_MAX_BYTES + 1));
  put(s, 'bomb.docx', zipOf(`<w:document>${' '.repeat(2_000_000)}</w:document>`));
  put(s, 'dtd.docx', zipOf('<!DOCTYPE w:document><w:document/>'));
  const results = [
    await s.call({ path: 'a.xlsx' }), await s.call({ path: 'a.docx', offset: 2, limit: 1 }), await s.call({ path: 'long.docx', limit: 1 }),
    await s.call({ path: 'a.txt' }), await s.call({ path: 'fake.docx' }), await s.call({ path: 'locked.docx' }), await s.call({ path: 'broken.docx' }),
    await s.call({ path: 'blank.docx' }), await s.call({ path: 'big.pdf' }), await s.call({ path: 'bomb.docx' }), await s.call({ path: 'dtd.docx' }),
    await s.call({ path: 'missing.pdf' }), await s.call({ path: 'dir.pdf' }),
  ];
  for (const r of results) {
    assert.ok(r.output.content.length > 0);
    assert.doesNotMatch(r.output.content, JAPANESE, r.output.content);
  }
  assert.equal(results[0]!.output.content, '[Sheet: Sheet1]\nname\tcount\napple\t3');
  assert.match(results[1]!.output.content, /\[Lines 2 to 2 of 3\. Read on with offset=3\]/u);
  assert.match(results[2]!.output.content, /\[Because it is long, the extracted text was cut off at 200,000 characters\]$/u);
});
