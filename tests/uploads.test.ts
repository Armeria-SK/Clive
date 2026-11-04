import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { ModelConfig } from '../src/config/schema.ts';
import { defaultConfig } from '../src/config/store.ts';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { attachmentBlock, MAX_UPLOAD_BYTES, stripAttachments, UploadError } from '../src/uploads/store.ts';
import { createWebServer } from '../src/web/server.ts';
import { FakeAdapter, reply, tempDir, type Script } from './helpers.ts';

export function tinyPdf(text: string): Buffer {
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
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function toolCall(name: string, args: unknown): Script {
  return async function* () {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, model: Partial<ModelConfig> = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = defaultConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 131072, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false, ...model }];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  config.memory.review = false;
  config.tools.shell.approvalTimeoutSec = 10;
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  const events: RunEvent[] = [];
  app.bus.subscribe(e => events.push(e.event));
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); app.close(); });
  const upload = async (name: string, body: Buffer, type = 'application/octet-stream') => {
    const res = await fetch(`${origin}/api/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': type }, body: new Uint8Array(body) });
    return { status: res.status, body: await res.json() as any };
  };
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${origin}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  return { app, adapter: () => adapter, upload, post, origin, events };
}

test('添付の種類を中身で見分ける（テキスト・PDF・画像）。読めないものは断る', async t => {
  const s = await setup(t);
  const text = s.app.uploads.save({ name: 'メモ.md', mime: 'text/markdown', body: Buffer.from('# 見出し\n本文') });
  assert.deepEqual([text.kind, text.chars], ['text', 8]);
  const pdf = s.app.uploads.save({ name: 'a.pdf', mime: 'application/pdf', body: tinyPdf('Hello Clive') });
  assert.deepEqual([pdf.kind, pdf.pages], ['pdf', 1]);
  assert.equal(s.app.uploads.get(pdf.id)!.text, 'Hello Clive');
  const disguised = s.app.uploads.save({ name: 'photo.txt', mime: 'text/plain', body: PNG });
  assert.deepEqual([disguised.kind, disguised.mime], ['image', 'image/png'], '拡張子より中身を信じる');
  assert.throws(() => s.app.uploads.save({ name: 'tool.exe', mime: 'application/octet-stream', body: Buffer.from([0x4d, 0x5a, 0, 0, 1, 2]) }), UploadError);
  assert.throws(() => s.app.uploads.save({ name: '../../etc/x.txt', mime: 'text/plain', body: Buffer.alloc(0) }), /空のファイル/u);
  assert.equal(s.app.uploads.save({ name: '../../evil/x.txt', mime: 'text/plain', body: Buffer.from('a') }).name, 'x.txt', 'パスは名前だけにする');
  assert.throws(() => s.app.uploads.save({ name: 'scan.pdf', mime: 'application/pdf', body: Buffer.from('%PDF-1.4\n%%EOF') }), /PDF/u);
});

test('添付の段落は画面では隠し、名前だけを見せる', () => {
  const block = attachmentBlock({ id: 'u', name: 'a.txt', mime: 'text/plain', kind: 'text', size: 3, sha256: '', text: '中身です', pages: null, created_at: 0 });
  assert.match(block, /\[外部の内容\][\s\S]*中身です/u);
  assert.equal(stripAttachments(`読んで\n\n${block}\n\n${block}`), '読んで');
});

test('API: 添付して送ると、中身はデータとしてモデルに渡り、その実行の書き込みは承認制になる', async t => {
  const s = await setup(t);
  const up = await s.upload('議事録.pdf', tinyPdf('Meeting notes: ship on Friday'), 'application/pdf');
  assert.equal(up.status, 201);
  s.adapter().scripts.push(toolCall('file_write', { path: 'summary.md', content: 'ship on Friday' }), reply('まとめました'));
  const sent = await s.post('/api/conversations/c1/messages', { text: 'これをまとめて', attachments: [up.body.upload.id] });
  assert.equal(sent.status, 202);
  for (let i = 0; i < 300 && !s.events.some(e => e.type === 'approval.requested'); i++) await new Promise(r => setTimeout(r, 10));
  const requested = s.events.find(e => e.type === 'approval.requested') as Extract<RunEvent, { type: 'approval.requested' }>;
  assert.ok(requested, '添付を読んだ実行の書き込みは確認する');
  assert.match(requested.approval.reasons.join(' '), /添付「議事録\.pdf」/u);
  s.app.approvals.decide(requested.approval.id, 'once');
  await s.app.engine.wait(sent.body.runId);
  const toModel = String(s.adapter().calls[0]!.messages.at(-1)?.content);
  assert.match(toModel, /これをまとめて[\s\S]*<<<添付ファイル: 議事録\.pdf（PDF・1 ページ）>>>[\s\S]*ship on Friday/u);
  const view = await (await fetch(`${s.origin}/api/conversations/c1/messages`, { headers: { Origin: s.origin } })).json() as any;
  const user = view.messages.find((m: any) => m.role === 'user');
  assert.equal(user.text, 'これをまとめて');
  assert.equal(s.app.conversations.get('c1')!.title, 'これをまとめて', 'タイトルに添付の中身を入れない');
  assert.deepEqual(user.attachments.map((a: any) => [a.name, a.kind]), [['議事録.pdf', 'pdf']]);
});

test('API: 画像は画像を読めるモデルにだけ渡す。大きすぎる・知らない添付は断る', async t => {
  const s = await setup(t);
  const img = await s.upload('a.png', PNG, 'image/png');
  assert.equal(img.body.upload.kind, 'image');
  const refused = await s.post('/api/conversations/c1/messages', { text: '見て', attachments: [img.body.upload.id] });
  assert.equal(refused.status, 409);
  assert.match(refused.body.message, /画像を読めるモデル/u);
  assert.equal((await s.post('/api/conversations/c1/messages', { text: 'x', attachments: ['nope'] })).status, 400);
  assert.equal((await s.upload('big.txt', Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x61), 'text/plain')).status, 413);
});

test('API: 画像を読めるモデルなら、画像として渡す', async t => {
  const s = await setup(t, { vision: true });
  const img = await s.upload('a.png', PNG, 'image/png');
  s.adapter().scripts.push(reply('小さな画像です'));
  const sent = await s.post('/api/conversations/c1/messages', { attachments: [img.body.upload.id] });
  assert.equal(sent.status, 202);
  await s.app.engine.wait(sent.body.runId);
  const last = s.adapter().calls[0]!.messages.at(-1) as { content: string; images?: Array<{ mediaType: string; data: string }> };
  assert.equal(last.images?.[0]?.mediaType, 'image/png');
  assert.equal(Buffer.from(last.images![0]!.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(last.content, '（画像を添付しました）');
});
