import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { serverHostProblem } from '../src/shared/url.ts';
import { WebAuth } from '../src/web/auth.ts';
import { ServerHost, serverChange } from '../src/web/server-host.ts';
import { createWebServer } from '../src/web/server.ts';
import { FakeAdapter, tempDir, testConfig, type Script } from './helpers.ts';

// 段 9（A4）: 画面から、サーバーの設定（待ち受けと認証）を、プロセスを止めずに入れ替える。POST /api/server/apply

type Server4 = AppConfig['server'];

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

const TAILNET = 'clive.tail1234.ts.net';

interface Reply { status: number; body: any }
function send(port: number, path: string, options: { host?: string; method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({ host: options.host ?? '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...options.headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let body: any = text; try { body = JSON.parse(text); } catch { } resolve({ status: res.statusCode ?? 0, body }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function start(t: { after: (fn: () => void | Promise<void>) => void }, mutate: (server: Server4) => void = () => undefined, options: { scripts?: Script[] } = {}) {
  const port = await freePort();
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  config.server = { host: '127.0.0.1', port, origins: [], tailscaleLogins: [] };
  mutate(config.server);
  writeFileSync(paths.config, JSON.stringify(config));
  const logs: string[] = [];
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: line => logs.push(line), adapterOverride: p => { adapter = new FakeAdapter(p, adapter?.scripts ?? options.scripts ?? []); return adapter; } });
  await app.status.probeAll(app.config());
  const web = createWebServer(app);
  await web.listen();
  t.after(() => { web.close(); app.close(); });
  const local = (p: number) => ({ Origin: `http://127.0.0.1:${p}` });
  // いまの待ち受け（入れ替えたあとは新しいほう）の手元から押す
  const apply = (body: unknown = {}) => { const p = (web.server.address() as AddressInfo).port; return send(p, '/api/server/apply', { method: 'POST', headers: local(p), body }); };
  // 設定ファイル（= いまの設定）の server だけを書き換える。画面で保存したのと同じ
  const change = async (patch: Partial<Server4>) => { const current = app.config(); await app.applyConfig({ ...current, server: { ...current.server, ...patch } }, { probe: false }); };
  return { app, web, port, logs, apply, change, local, adapter: () => adapter };
}

const listening = (server: Server) => server.listening;
async function refused(port: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try { await send(port, '/api/health'); } catch { return true; }
    await new Promise(r => setTimeout(r, 30));
  }
  return false;
}

test('serverHostProblem: ループバック以外の host は断る（起動と反映が同じ検査を使う）', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '127.0.0.2']) assert.equal(serverHostProblem(host), undefined, host);
  for (const host of ['0.0.0.0', '192.168.1.5', '::', 'example.com']) assert.match(serverHostProblem(host) ?? '', /ループバック/u, host);
});

test('serverChange: 待ち受け（host・port）と認証（origins・tailscaleLogins）のどちらが違うかを見る。同じなら何も変わらない', () => {
  const base: Server4 = { host: '127.0.0.1', port: 4777, origins: ['https://a.example'], tailscaleLogins: ['me@example.com'] };
  assert.deepEqual(serverChange(base, structuredClone(base)), { listen: false, auth: false });
  assert.deepEqual(serverChange(base, { ...base, port: 4778 }), { listen: true, auth: false });
  assert.deepEqual(serverChange(base, { ...base, host: 'localhost' }), { listen: true, auth: false });
  assert.deepEqual(serverChange(base, { ...base, origins: [] }), { listen: false, auth: true });
  assert.deepEqual(serverChange(base, { ...base, tailscaleLogins: [] }), { listen: false, auth: true });
  assert.deepEqual(serverChange(base, { ...base, port: 1, origins: [] }), { listen: true, auth: true });
  assert.deepEqual(serverChange(base, { ...base, origins: ['https://a.example', 'https://b.example'] }), { listen: false, auth: true }, '順番だけの違いも、再起動の要否と同じく「違う」');
});

test('WebAuth.check: 通ったときは、手元（ループバック）の要求か・Tailscale のログイン名も返す', () => {
  const auth = new WebAuth(['http://127.0.0.1:4777', `https://${TAILNET}`], ['me@example.com']);
  const req = (headers: Record<string, string>, method = 'GET') => ({ headers, method } as unknown as IncomingMessage);
  assert.deepEqual(auth.check(req({ host: '127.0.0.1:4777' })), { ok: true, origin: 'http://127.0.0.1:4777', local: true });
  assert.deepEqual(auth.check(req({ host: TAILNET, 'tailscale-user-login': 'Me@Example.com' })), { ok: true, origin: `https://${TAILNET}`, local: false, login: 'Me@Example.com' });
});

test('A4: 反映するものが無ければ 409（nothing_to_apply）。何も変えない', async t => {
  const s = await start(t);
  const before = s.web.server;
  const reply = await s.apply();
  assert.equal(reply.status, 409);
  assert.equal(reply.body.error, 'nothing_to_apply');
  assert.equal(reply.body.code, 'http.nothing_to_apply');
  assert.equal(s.web.server, before);
});

test('A4: origins・ログイン名だけ変えたときは、待ち受けはそのままで認証だけを入れ替える。応答のあとは、新しい認証で受け付ける', async t => {
  const s = await start(t);
  const before = s.web.server;
  const closed = await send(s.port, '/api/health', { headers: { Host: TAILNET, 'Tailscale-User-Login': 'me@example.com' } });
  assert.equal(closed.status, 403, '足す前は、Tailscale の要求は入れない');
  await s.change({ origins: [`https://${TAILNET}`], tailscaleLogins: ['me@example.com'] });
  assert.equal(s.app.restartRequired(), true);
  const reply = await s.apply();
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.deepEqual(reply.body.applied, { listen: false, auth: true });
  assert.equal(reply.body.url, null, 'ポートが変わらなければ、移る先はない');
  assert.equal(reply.body.restartRequired, false);
  assert.equal(s.web.server, before, '待ち受けは入れ替えない');
  assert.equal(s.app.restartRequired(), false);
  assert.deepEqual(s.app.bootServer.origins, [`https://${TAILNET}`]);
  const open = await send(s.port, '/api/health', { headers: { Host: TAILNET, 'Tailscale-User-Login': 'me@example.com' } });
  assert.equal(open.status, 200);
  assert.equal((await send(s.port, '/api/health', { headers: { Host: TAILNET, 'Tailscale-User-Login': 'stranger@example.com' } })).status, 403, '一覧に無いログイン名は入れない');
});

test('A4: ポートを変えたら、新しいポートで待ち受けを始めてから古い待ち受けを閉じる。応答には新しい URL が入り、手元からは force なしで押せる（いつも締め出しになる罠に落ちない）', async t => {
  const s = await start(t);
  const next = await freePort();
  await s.change({ port: next });
  const reply = await s.apply();
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.deepEqual(reply.body.applied, { listen: true, auth: false });
  assert.equal(reply.body.url, `http://127.0.0.1:${next}/`);
  assert.equal((s.web.server.address() as AddressInfo).port, next, 'いまの待ち受けは新しいほう');
  assert.equal(s.app.bootServer.port, next);
  assert.equal(s.app.restartRequired(), false);
  assert.equal((await send(next, '/api/health', { headers: s.local(next) })).status, 200, '新しいポートで受け付ける');
  assert.equal(await refused(s.port), true, '古いポートは閉じる');
  assert.equal((await send(next, '/api/server/apply', { method: 'POST', headers: s.local(next), body: {} })).body.error, 'nothing_to_apply', '入れ替えたあとは、新しい値が「いま動いているもの」');
  assert.ok(s.logs.some(line => /\[INFO\].*サーバーの設定を反映/u.test(line) && /この PC/u.test(line)), `押した人を 1 行残す: ${s.logs.join(' | ')}`);
});

test('A4: 新しいポートで待ち受けを始められなければ、古いままにして 409（listen_failed）。何も入れ替えない', async t => {
  const s = await start(t);
  const taken = await freePort();
  const squatter = createServer();
  await new Promise<void>(resolve => squatter.listen(taken, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => squatter.close(() => resolve())));
  await s.change({ port: taken });
  const before = s.web.server;
  const reply = await s.apply();
  assert.equal(reply.status, 409);
  assert.equal(reply.body.error, 'listen_failed');
  assert.equal(reply.body.code, 'http.listen_failed');
  assert.match(reply.body.params.errno, /EADDRINUSE/u);
  assert.equal(s.web.server, before);
  assert.equal(s.app.bootServer.port, s.port);
  assert.equal(s.app.restartRequired(), true, 'まだ反映されていないので、帯は残る');
  assert.equal((await send(s.port, '/api/health', { headers: s.local(s.port) })).status, 200, '古い待ち受けはそのまま動いている');
});

test('A4: ループバックでない host は 409（host_not_loopback）。何も入れ替えない', async t => {
  const s = await start(t);
  await s.change({ host: '0.0.0.0' });
  const before = s.web.server;
  const reply = await s.apply();
  assert.equal(reply.status, 409);
  assert.equal(reply.body.code, 'http.host_not_loopback');
  assert.equal(reply.body.params.host, '0.0.0.0');
  assert.equal(s.web.server, before);
  assert.equal(s.app.bootServer.host, '127.0.0.1');
});

test('A4: 新しい設定では受け付けを組み立てられない（http の origin など）ときは 409（bad_server）。何も入れ替えない', async t => {
  const s = await start(t);
  await s.change({ origins: ['http://192.168.1.2:4777'] });
  const reply = await s.apply();
  assert.equal(reply.status, 409);
  assert.equal(reply.body.code, 'http.bad_server');
  assert.deepEqual(s.app.bootServer.origins, []);
});

test('A4: 締め出しの確かめ（Tailscale）: ポートが変わる・自分のログイン名を外す・自分の origin を外す、は 409（would_lock_out）。force: true を付けたときだけ進む', async t => {
  const login = 'me@example.com';
  const s = await start(t, server => { server.origins = [`https://${TAILNET}`]; server.tailscaleLogins = [login, 'you@example.com']; });
  const asMe = (body: unknown) => send(s.port, '/api/server/apply', { method: 'POST', headers: { Host: TAILNET, Origin: `https://${TAILNET}`, 'Tailscale-User-Login': login }, body });
  assert.equal((await send(s.port, '/api/health', { headers: { Host: TAILNET, 'Tailscale-User-Login': login } })).status, 200, '前提: Tailscale から入れている');

  const nextPort = await freePort();
  await s.change({ port: nextPort });
  const port = await asMe({});
  assert.equal(port.status, 409);
  assert.equal(port.body.error, 'would_lock_out');
  assert.equal(port.body.code, 'http.lockout_port');
  assert.equal(s.app.bootServer.port, s.port, '断ったときは何も変えない');
  await s.change({ port: s.port });

  await s.change({ tailscaleLogins: ['you@example.com'] });
  const gone = await asMe({});
  assert.equal(gone.status, 409);
  assert.equal(gone.body.code, 'http.lockout_login');
  assert.equal(gone.body.params.login, login);
  assert.deepEqual(s.app.bootServer.tailscaleLogins, [login, 'you@example.com']);
  await s.change({ tailscaleLogins: [login, 'you@example.com'] });

  await s.change({ origins: [] });
  const origin = await asMe({});
  assert.equal(origin.status, 409);
  assert.equal(origin.body.code, 'http.lockout_origin');

  const forced = await asMe({ force: true });
  assert.equal(forced.status, 200, JSON.stringify(forced.body));
  assert.deepEqual(forced.body.applied, { listen: false, auth: true });
  assert.equal(s.app.restartRequired(), false);
  assert.equal((await send(s.port, '/api/health', { headers: { Host: TAILNET, 'Tailscale-User-Login': login } })).status, 403, 'force で進めたので、もう入れない');

  assert.equal((await send(s.port, '/api/server/apply', { method: 'POST', headers: { ...s.local(s.port) }, body: { force: 'yes' } })).status, 400, 'force は true か false だけ');
});

test('A4: 手元（この PC）から押したときは、ログイン名や Tailscale の origin を外しても締め出しにならない（手元は新しい設定でも入れる）', async t => {
  const s = await start(t, server => { server.origins = [`https://${TAILNET}`]; server.tailscaleLogins = ['me@example.com']; });
  await s.change({ origins: [], tailscaleLogins: [] });
  const reply = await s.apply();
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal((await send(s.port, '/api/health', { headers: { Host: TAILNET, 'Tailscale-User-Login': 'me@example.com' } })).status, 403);
  assert.equal((await send(s.port, '/api/health', { headers: s.local(s.port) })).status, 200);
});

test('A4: 手元の要求でも、待ち受ける場所（host）が変わって、いまのアドレスで開けなくなるときは 409（lockout_address）。force で進める', async t => {
  const s = await start(t);
  await s.change({ host: '127.0.0.2' });
  const reply = await s.apply();
  assert.equal(reply.status, 409);
  assert.equal(reply.body.code, 'http.lockout_address');
  assert.equal(reply.body.params.address, '127.0.0.1');
  assert.equal(s.app.bootServer.host, '127.0.0.1');
  if (process.platform === 'darwin') return;
  const forced = await s.apply({ force: true });
  assert.equal(forced.status, 200, JSON.stringify(forced.body));
  assert.equal((s.web.server.address() as AddressInfo).address, '127.0.0.2');
  assert.equal(await refused(s.port), true, '古い場所（127.0.0.1）は閉じる');
  assert.equal((await send(s.port, '/api/health', { host: '127.0.0.2', headers: { Host: `127.0.0.1:${s.port}` } })).status, 200, '新しい場所（127.0.0.2）が受け付ける');
});

test('A4: 同時に反映できるのは 1 つだけ（実行中に押されたら 409 busy）。終われば、また押せる', async t => {
  const running: Server4 = { host: '127.0.0.1', port: await freePort(), origins: [], tailscaleLogins: [] };
  let accepted: Server4 | undefined;
  class Slow extends Server { override listen(...args: any[]): this { setTimeout(() => super.listen(...(args as [number, string, () => void])), 150); return this; } }
  const slow = new ServerHost({ running, create: () => new Slow(), closeStreams: () => undefined, accept: s => { accepted = s; }, log: () => undefined });
  const request1 = { headers: { host: `127.0.0.1:${running.port}`, origin: `http://127.0.0.1:${running.port}` } };
  const next: Server4 = { ...running, port: await freePort() };
  const first = slow.apply(request1, next, false);
  const second = await slow.apply(request1, next, false);
  assert.deepEqual(second.ok === false && second.failure.code, 'busy');
  const done = await first;
  assert.equal(done.ok, true);
  assert.deepEqual(accepted, next);
  t.after(() => slow.close());
  const again = await slow.apply({ headers: { host: `127.0.0.1:${next.port}`, origin: `http://127.0.0.1:${next.port}` } }, next, false);
  assert.deepEqual(again.ok === false && again.failure.code, 'nothing_to_apply');
});

test('A4: 待ち受けの場所は、いま動いているものとして覚えている設定（running）から決める（認証・「違いがあるか」の比べ先と食い違わない）。場所を渡せるのは試験用', async t => {
  const running: Server4 = { host: '127.0.0.1', port: await freePort(), origins: [], tailscaleLogins: [] };
  const make = () => new ServerHost({ running, create: () => createServer(), closeStreams: () => undefined, accept: () => undefined, log: () => undefined });
  const byDefault = make();
  t.after(() => byDefault.close());
  await byDefault.listen();
  assert.equal((byDefault.server.address() as AddressInfo).port, running.port, '何も渡さなければ running の port');
  assert.equal((byDefault.server.address() as AddressInfo).address, running.host);
  const overridden = make();
  t.after(() => overridden.close());
  await overridden.listen({ host: '127.0.0.1', port: 0 });
  const other = (overridden.server.address() as AddressInfo).port;
  assert.ok(other > 0 && other !== running.port, '試験用に渡せば、その場所（空いているポート）で始める');
});

test('A4: 流れを閉じるのは入れ替えた瞬間の 1 回だけ。古い待ち受けが閉じ終わっても、新しい待ち受けの流れは閉じない（流れを待ち受けの閉じる動きに結び付けない）', async t => {
  const running: Server4 = { host: '127.0.0.1', port: await freePort(), origins: [], tailscaleLogins: [] };
  const servers: Server[] = [];
  let closedStreams = 0;
  const host = new ServerHost({ running, create: () => { const s = createServer(); servers.push(s); return s; }, closeStreams: () => { closedStreams++; }, accept: () => undefined, log: () => undefined });
  t.after(() => host.close());
  await host.listen();
  const next: Server4 = { ...running, port: await freePort() };
  const outcome = await host.apply({ headers: { host: `127.0.0.1:${running.port}`, origin: `http://127.0.0.1:${running.port}` } }, next, false);
  assert.equal(outcome.ok, true);
  assert.equal(closedStreams, 1, '入れ替えた瞬間に 1 回');
  assert.ok(outcome.ok);
  outcome.retire();
  const [old] = servers;
  await Promise.race([once(old!, 'close'), new Promise((_, reject) => setTimeout(() => reject(new Error('古い待ち受けが閉じ終わらない')), 3000))]);
  assert.equal(old!.listening, false);
  assert.equal(closedStreams, 1, '古い待ち受けが閉じ終わっても、流れは閉じない');
  assert.equal(servers[1]!.listening, true);
  host.close();
  assert.equal(closedStreams, 2, '終了のときだけ、もう 1 回');
});

test('A4: 認証が変わったら、開いている SSE を全部閉じる（繋ぎ直せば新しい認証で確かめ直される）。待ち受けを入れ替えたあとも、新しい待ち受けの流れは閉じない', async t => {
  const s = await start(t);
  const readUntilEnd = async (port: number) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/events?after=0`);
    const reader = res.body!.getReader();
    const ended = (async () => { for (;;) { const { done } = await reader.read(); if (done) return true; } })();
    return { reader, ended, res };
  };
  const stream = await readUntilEnd(s.port);
  await s.change({ origins: [`https://${TAILNET}`] });
  assert.equal((await s.apply()).status, 200);
  assert.equal(await Promise.race([stream.ended, new Promise(r => setTimeout(() => r('open'), 2000))]), true, '認証を入れ替えたら、開いていた流れは終わる');

  // 待ち受けの入れ替え: 新しい待ち受けで開いた流れは、古い待ち受けが閉じても生きていて、出来事を受け取り続ける
  const next = await freePort();
  await s.change({ port: next });
  const oldStream = await readUntilEnd(s.port);
  assert.equal((await s.apply()).status, 200);
  assert.equal(await Promise.race([oldStream.ended, new Promise(r => setTimeout(() => r('open'), 2000))]), true, '古い待ち受けの流れも閉じる');
  const fresh = await fetch(`http://127.0.0.1:${next}/api/events?after=0`);
  const reader = fresh.body!.getReader();
  assert.equal(await refused(s.port), true);
  s.app.bus.publish({ type: 'notification', notification: { id: 1, kind: 'info', title: 'after swap', body: null, link: null, read: 0, created_at: Date.now() } as never });
  let seen = '';
  const decoder = new TextDecoder();
  for (let i = 0; i < 20 && !seen.includes('after swap'); i++) {
    const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>(r => setTimeout(() => r({ done: true, value: undefined }), 1000))]);
    if (chunk.value) seen += decoder.decode(chunk.value);
    if (chunk.done && !chunk.value) break;
  }
  assert.match(seen, /after swap/u, '古い待ち受けが閉じたあとも、新しい待ち受けの流れは出来事を受け取る');
  await reader.cancel();
});

test('A4: 動いている返事は途切れない。反映しても会話の実行・保存は止まらず、そのまま終わる', async t => {
  let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slowReply: Script = async function* () {
    yield { type: 'text', delta: '前半 ' };
    started();
    await gate;
    yield { type: 'text', delta: '後半' };
    yield { type: 'done', stop: 'end_turn' };
  };
  const s = await start(t, () => undefined, { scripts: [slowReply] });
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  const outcome = s.app.engine.send('c1', 'こんにちは');
  assert.ok(outcome.ok);
  await begun;
  const next = await freePort();
  await s.change({ port: next });
  assert.equal((await s.apply()).status, 200);
  assert.equal(s.app.engine.activeRuns().length, 1, '反映したあとも、実行は動いている');
  release();
  const result = await s.app.engine.wait(outcome.runId)!;
  assert.ok(result.ok);
  assert.equal(s.app.conversations.messages('c1').at(-1)?.text, '前半 後半');
  assert.ok(events.some(e => e.type === 'run.end' && e.ok === true));
});

test('A4: 終了の処理は、入れ替えたあとの「いまの」待ち受けを閉じる', async t => {
  const s = await start(t);
  const next = await freePort();
  await s.change({ port: next });
  assert.equal((await s.apply()).status, 200);
  assert.equal(listening(s.web.server), true);
  s.web.close();
  assert.equal(await refused(next), true, '新しいポートの待ち受けも閉じる');
  assert.equal(listening(s.web.server), false);
});

test('A4: 書き込みの要求なので、Host・Origin・Sec-Fetch-Site の確かめを通らなければ 403（何も変えない）', async t => {
  const s = await start(t);
  await s.change({ origins: [`https://${TAILNET}`] });
  const post = (headers: Record<string, string>) => send(s.port, '/api/server/apply', { method: 'POST', headers, body: {} });
  assert.equal((await post({})).status, 403, 'Origin なし');
  assert.equal((await post({ Origin: 'http://evil.example' })).status, 403, '別のサイトの Origin');
  assert.equal((await post({ ...s.local(s.port), 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post({ Host: 'evil.example:4777', Origin: 'http://evil.example:4777' })).status, 403, 'DNS リバインディング');
  assert.equal((await post({ Host: TAILNET, Origin: `https://${TAILNET}` })).status, 403, 'Tailscale のヘッダが無い');
  assert.equal(s.app.restartRequired(), true, 'どれも反映していない');
  assert.deepEqual(s.app.bootServer.origins, []);
});

test('A4: モデルの道具（シェル）からは押せない。この PC の中のサーバーへの接続は、中身を見せて人が確かめ、拒否すれば何も起きない', async t => {
  const s = await start(t);
  const next = await freePort();
  await s.change({ port: next });
  const { runToolCall } = await import('../src/tools/pipeline.ts');
  const { buildPolicy, defaultWorkspace } = await import('../src/tools/policy.ts');
  const policy = buildPolicy(s.app.config(), s.app.paths);
  const controller = new AbortController();
  const ctx = {
    runId: 'r-apply', conversationId: 'c-apply', kind: 'chat' as const, signal: controller.signal, config: s.app.config(), paths: s.app.paths, policy,
    workspace: defaultWorkspace(policy, s.app.paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const commands = [
    `curl -X POST http://127.0.0.1:${s.port}/api/server/apply -H "Origin: http://127.0.0.1:${s.port}" -H "Content-Type: application/json" -d "{}"`,
    `curl.exe -X POST http://localhost:${s.port}/api/server/apply`,
    `node -e "fetch('http://127.0.0.1:${s.port}/api/server/apply', { method: 'POST', headers: { Origin: 'http://127.0.0.1:${s.port}' } })"`,
  ];
  for (const command of commands) {
    let finished = false;
    const asked: Array<{ onceOnly: boolean; reasons: string[] }> = [];
    const calling = runToolCall({ id: 'c', name: 'shell_run', arguments: { command } }, ctx, { registry: s.app.tools, approvals: s.app.approvals, db: s.app.db, emit: () => undefined, conversationAutoRead: () => false }).finally(() => { finished = true; });
    while (!finished) {
      const pending = s.app.approvals.pending()[0];
      if (pending) { asked.push({ onceOnly: pending.onceOnly === true, reasons: pending.reasons }); s.app.approvals.decide(pending.id, 'deny'); }
      await new Promise(r => setTimeout(r, 10));
    }
    const outcome = await calling;
    assert.equal(outcome.output.isError, true, command);
    assert.notEqual(outcome.decision, 'allow', `${command}: 確かめなしに通った`);
    // 断られるのではなく、毎回（今回だけ）の承認を求める。理由は「この PC の中のサーバー（Clive 自身を含む）につなぐ」（code.loopback）
    assert.ok(asked.length >= 1 && asked.every(a => a.onceOnly), `${command}: 今回だけの承認を求める`);
    assert.ok(asked.some(a => a.reasons.some(reason => reason.includes('この PC の中のサーバー'))), `${command}: 理由は code.loopback`);
  }
  assert.equal(s.app.restartRequired(), true, 'シェルからは反映されていない');
  assert.equal(s.app.bootServer.port, s.port);
  assert.equal(s.web.server.listening, true);
});
