import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import { CONTEXT_FILL_RATIO, MEMORY_BUDGET_RATIO } from '../src/engine/chat.ts';
import type { ModelConfig } from '../src/config/schema.ts';
import { resolvePaths } from '../src/paths.ts';
import { WebAuth } from '../src/web/auth.ts';
import { createWebServer } from '../src/web/server.ts';
import { FakeAdapter, reply, tempDir, testConfig } from './helpers.ts';

const req = (headers: Record<string, string>, method = 'GET') => ({ headers, method } as unknown as IncomingMessage);

test('認証: Host・Origin・Sec-Fetch-Site・Tailscale を確かめる', () => {
  const auth = new WebAuth(['http://127.0.0.1:4777', 'https://clive.tail1234.ts.net'], ['me@example.com']);
  assert.equal(auth.check(req({ host: '127.0.0.1:4777' })).ok, true);
  assert.equal(auth.check(req({ host: 'evil.example:4777' })).ok, false, 'DNS リバインディング');
  assert.equal(auth.check(req({ host: '127.0.0.1:4777', origin: 'http://evil.example' })).ok, false);
  assert.equal(auth.check(req({ host: '127.0.0.1:4777' }, 'POST')).ok, false, '書き込みには Origin が要る');
  assert.equal(auth.check(req({ host: '127.0.0.1:4777', origin: 'http://127.0.0.1:4777' }, 'POST')).ok, true);
  assert.equal(auth.check(req({ host: '127.0.0.1:4777', 'sec-fetch-site': 'cross-site' })).ok, false);
  assert.equal(auth.check(req({ host: 'clive.tail1234.ts.net' })).ok, false, 'Tailscale のヘッダが無い');
  assert.equal(auth.check(req({ host: 'clive.tail1234.ts.net', 'tailscale-user-login': 'someone@else.com' })).ok, false);
  assert.equal(auth.check(req({ host: 'clive.tail1234.ts.net', 'tailscale-user-login': 'me@example.com' })).ok, true);
  assert.throws(() => new WebAuth(['http://192.168.1.2:4777']), /https/);
});

async function startApp(t: { after: (fn: () => void | Promise<void>) => void }, models?: ModelConfig[]) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FAKE_KEY', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = models ?? [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: config.models.map(m => m.id), background: [], retriesPerModel: 0 };
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined,
    adapterOverride: provider => (adapter = new FakeAdapter(provider)),
  });
  await app.status.probeAll(app.config());
  const web = createWebServer(app);
  // テストではランダムなポートで待ち受けるので、その origin を許可する
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const port = (web.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  web.setOrigins([origin]);
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); app.close(); });
  const api = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, {
    ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Origin: origin, ...init.headers },
  });
  return { app, web, adapter: () => adapter, origin, api, port };
}

async function readEvents(origin: string, until: (e: any) => boolean, timeoutMs = 3000): Promise<any[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(`${origin}/api/events?after=0`, { signal: controller.signal });
  const events: any[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, i); buffer = buffer.slice(i + 2);
        const name = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (name === 'run' && data) {
          const e = JSON.parse(data); events.push(e);
          if (until(e)) return events;
        }
      }
    }
  } finally { clearTimeout(timer); controller.abort(); }
  return events;
}

test('API: 発言を送ると返事が SSE で流れ、保存される', async t => {
  const s = await startApp(t);
  const created = await (await s.api('/api/conversations', { method: 'POST', body: '{}' })).json() as any;
  const id = created.conversation.id;
  s.adapter().scripts.push(reply('こんにちは、Clive です'));
  const listening = readEvents(s.origin, e => e.type === 'run.end');
  await new Promise(r => setTimeout(r, 50));
  const sent = await s.api(`/api/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'やあ' }) });
  assert.equal(sent.status, 202);
  const events = await listening;
  assert.equal(events.filter(e => e.type === 'text.delta').map(e => e.text).join(''), 'こんにちは、Clive です');
  assert.equal(events.at(-1).ok, true);
  const history = await (await s.api(`/api/conversations/${id}/messages`)).json() as any;
  assert.deepEqual(history.messages.map((m: any) => m.role), ['user', 'assistant']);
  const runs = await (await s.api('/api/runs')).json() as any;
  assert.equal(runs.runs[0].ok, 1);
});

test('API: 使えるモデルが無ければ 409 で理由と直し方を返し、発言は保存しない', async t => {
  const s = await startApp(t, [{ id: 'small', provider: 'fake', model: 'x', contextLength: 4096, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }]);
  const sent = await s.api('/api/conversations/c1/messages', { method: 'POST', body: JSON.stringify({ text: 'やあ' }) });
  assert.equal(sent.status, 409);
  const body = await sent.json() as any;
  assert.equal(body.errorKind, 'context_overflow');
  assert.match(body.errorMessage, /送信しませんでした/);
  const models = await (await s.api('/api/models')).json() as any;
  assert.equal(models.models[0].probe.status, 'too_small');
  assert.equal(s.app.conversations.messages('c1').length, 0);
  assert.equal(s.app.conversations.get('c1'), undefined, '断った送信は、空の会話を残さない');
  const created = await s.api('/api/conversations/c9/messages', { method: 'POST', body: JSON.stringify({ text: 'もう一度' }) });
  assert.equal(created.status, 409);
  assert.deepEqual(s.app.conversations.list(), []);
});

test('API: 設定の検証エラーは 400 で場所を返し、API キーの値は返さない', async t => {
  process.env.FAKE_KEY = 'super-secret-value';
  t.after(() => { delete process.env.FAKE_KEY; });
  const s = await startApp(t);
  const view = await (await s.api('/api/settings')).json() as any;
  assert.deepEqual(view.apiKeys, { FAKE_KEY: true });
  assert.equal(JSON.stringify(view).includes('super-secret-value'), false);
  const bad = await s.api('/api/settings', { method: 'PUT', body: JSON.stringify({ config: { ...view.config, routing: { ...view.config.routing, chat: ['nope'] } } }) });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as any).problems.join('\n'), /routing\.chat/);
  const next = { ...view.config, timezone: 'UTC' };
  const ok = await s.api('/api/settings', { method: 'PUT', body: JSON.stringify({ config: next }) });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as any).config.timezone, 'UTC');
});

test('API: 記憶の追加・編集・削除・取り消しと、過去の会話の検索', async t => {
  const s = await startApp(t);
  const added = await s.api('/api/memories', { method: 'POST', body: JSON.stringify({ book: 'user', content: '朝はコーヒー' }) });
  assert.equal(added.status, 201);
  const { memory } = await added.json() as any;
  assert.equal((await s.api(`/api/memories/${memory.id}`, { method: 'PATCH', body: JSON.stringify({ content: '朝は紅茶' }) })).status, 200);
  const removed = await (await s.api(`/api/memories/${memory.id}`, { method: 'DELETE' })).json() as any;
  assert.equal(((await (await s.api('/api/memories')).json()) as any).books.user.items.length, 0);
  assert.equal((await s.api(`/api/memory-events/${removed.eventId}/undo`, { method: 'POST', body: '{}' })).status, 200);
  const books = (await (await s.api('/api/memories')).json() as any).books;
  assert.equal(books.user.items[0].content, '朝は紅茶');
  assert.equal(books.user.used, '朝は紅茶'.length);
  assert.equal('max' in books.user, false, '本の大きさに上限は無い');
  for (let i = 0; i < 14; i++) {
    const saved = await s.api('/api/memories', { method: 'POST', body: JSON.stringify({ book: 'user', content: `${i}${'あ'.repeat(590)}` }) });
    assert.equal(saved.status, 201, '以前の上限（2,000 文字）を超えても保存できる');
  }
  const context = (await (await s.api('/api/memories')).json() as any).context;
  assert.equal(context.budget, Math.floor((Math.floor(65536 * CONTEXT_FILL_RATIO) - 1024) * MEMORY_BUDGET_RATIO), '会話に入れる量の予算（使えるモデルの available の 12%）');
  assert.ok(context.tokens > 8000 && context.tokens > context.budget, `全部を入れたときの見積もり: ${context.tokens}`);
  assert.ok(context.omitted >= 1, '予算を超えた分は会話に入らない');
  const tooLong = await s.api('/api/memories', { method: 'POST', body: JSON.stringify({ book: 'user', content: 'あ'.repeat(2500) }) });
  assert.equal(tooLong.status, 400);
  s.app.conversations.append('past', { role: 'user', content: 'ベクトル検索の話をしよう' });
  const hits = (await (await s.api(`/api/history?q=${encodeURIComponent('ベクトル')}`)).json() as any).hits;
  assert.equal(hits[0].conversationId, 'past');
});

test('API: ほかのサイトからの書き込みは 403', async t => {
  const s = await startApp(t);
  const res = await fetch(`${s.origin}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('API: 作っていない会話の id に最初の発言を送ると、受け付けたときだけ会話ができる（断られたときは残らない）', async t => {
  const s = await startApp(t);
  s.adapter().scripts.push(reply('はじめまして'));
  const sent = await s.api('/api/conversations/fresh1/messages', { method: 'POST', body: JSON.stringify({ text: 'はじめまして' }) });
  assert.equal(sent.status, 202);
  await s.app.engine.wait(((await sent.json()) as any).runId);
  const row = s.app.conversations.get('fresh1')!;
  assert.deepEqual([row.kind, row.title], ['chat', 'はじめまして']);
  assert.deepEqual(s.app.conversations.list().map(c => c.id), ['fresh1']);
  assert.deepEqual(s.app.conversations.messages('fresh1').map(m => m.role), ['user', 'assistant']);
  const refused = await s.api('/api/conversations/fresh2/messages', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(100_001) }) });
  assert.equal(refused.status, 400);
  assert.equal(s.app.conversations.get('fresh2'), undefined, '入力の誤りで断った送信も、会話を作らない');
});
