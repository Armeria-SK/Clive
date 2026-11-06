import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebAuth } from '../src/web/auth.ts';
import { serveStatic } from '../src/web/static.ts';
import { tempDir } from './helpers.ts';

// 段 9（A4）の審査で、同じサイトの別のポート（別の 127.0.0.1 / localhost のポートのページ、同じ ts.net の別のホスト）からの最上位の移動を通す例外は、
// そのページから Clive を開いて #/ の経路を操作できる（承認ボタンの上に重ねて押させる・二度押させるなど）ため、外した。
// ポートを変えたあとの移動は、画面が新しい URL を見せて、持ち主がアドレス欄に入力・貼り付けて開く（ブラウザは Sec-Fetch-Site: none を送る）

const TAILNET = 'box.tail1234.ts.net';
const local = new WebAuth(['http://127.0.0.1:4800', 'http://localhost:4800'], []);
const tailnet = new WebAuth([`https://${TAILNET}`], []);
const NAVIGATE = { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const request = (headers: Record<string, string>, method = 'GET', url = '/') => ({ headers, method, url } as unknown as IncomingMessage);
const localReq = (headers: Record<string, string>, method = 'GET', url = '/') => request({ host: '127.0.0.1:4800', ...headers }, method, url);
const tailnetReq = (headers: Record<string, string>, method = 'GET', url = '/') => request({ host: TAILNET, 'tailscale-user-login': 'me@example.com', ...headers }, method, url);
const reasonOf = (verdict: ReturnType<WebAuth['check']>) => (verdict.ok ? 'ok' : verdict.reason);

test('同じサイトの別のポート・別のホストからの最上位の移動（navigate / document の GET）も断る: この PC でも Tailscale でも、画面でも部品でも', () => {
  for (const url of ['/', '/#/settings', '/#/c/abc', '/assets/index-abc.js?x=1', '/api/settings']) {
    assert.equal(reasonOf(local.check(localReq(NAVIGATE, 'GET', url))), 'cross_site', `この PC: ${url}`);
    assert.equal(reasonOf(local.check(request({ host: 'localhost:4800', ...NAVIGATE }, 'GET', url))), 'cross_site', `localhost: ${url}`);
    assert.equal(reasonOf(tailnet.check(tailnetReq(NAVIGATE, 'GET', url))), 'cross_site', `ts.net（同じ tailnet の別のホスト）: ${url}`);
  }
});

test('同じサイトからの要求は、移動でも fetch でも iframe でも書き込みでも、すべて断る（HEAD も）', () => {
  const cases: Array<[string, (origin: string) => Record<string, string>, string]> = [
    ['fetch', () => ({ ...NAVIGATE, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }), 'GET'],
    ['iframe', () => ({ ...NAVIGATE, 'sec-fetch-dest': 'iframe' }), 'GET'],
    ['部品を直接取る', () => ({ ...NAVIGATE, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' }), 'GET'],
    ['印が足りない', () => ({ 'sec-fetch-site': 'same-site' }), 'GET'],
    ['HEAD', () => NAVIGATE, 'HEAD'],
    ['書き込み（Origin は正しい）', origin => ({ ...NAVIGATE, origin }), 'POST'],
  ];
  for (const [name, headers, method] of cases) {
    assert.equal(reasonOf(local.check(localReq(headers('http://127.0.0.1:4800'), method))), 'cross_site', name);
    assert.equal(reasonOf(tailnet.check(tailnetReq(headers(`https://${TAILNET}`), method))), 'cross_site', `ts.net: ${name}`);
  }
  assert.equal(reasonOf(local.check(localReq({ ...NAVIGATE, 'sec-fetch-site': 'cross-site' }))), 'cross_site', '別のサイトからの移動');
  assert.equal(reasonOf(local.check(request({ host: 'evil.example:4800', ...NAVIGATE }))), 'host', 'Host の確かめは、そのまま先に断る');
});

test('持ち主がアドレス欄に入力・貼り付けて開く移動（Sec-Fetch-Site: none）と、同じオリジンの要求は通る', () => {
  const typed = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  assert.equal(local.check(localReq(typed)).ok, true, '入力・貼り付け');
  assert.equal(local.check(localReq(typed, 'GET', '/#/settings')).ok, true);
  assert.equal(tailnet.check(tailnetReq(typed)).ok, true, 'ts.net でも同じ');
  assert.equal(local.check(localReq({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, 'GET', '/api/settings')).ok, true, '同じオリジンの fetch');
  assert.equal(local.check(localReq({})).ok, true, '印の無い要求（curl など）は、今までどおり Host と Origin だけで確かめる');
});

test('画面（HTML）の応答には Cross-Origin-Opener-Policy: same-origin を付ける（ほかのページから window.open で開かれても、開いたページから操作できない）。部品（JS など）には付けない', async t => {
  const dist = join(tempDir(t), 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Clive</title>');
  writeFileSync(join(dist, 'assets', 'app.js'), '1');
  const built = createServer((req, res) => { if (!serveStatic(dist, req, res)) res.writeHead(404).end(); });
  const unbuilt = createServer((req, res) => { if (!serveStatic(join(dist, 'nothing'), req, res)) res.writeHead(404).end(); });
  for (const server of [built, unbuilt]) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.close(); server.closeAllConnections(); }); }
  const get = async (server: typeof built, path: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
  for (const path of ['/', '/index.html', '/settings']) {
    const response = await get(built, path);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', path);
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin', `画面: ${path}`);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', '今までの守りも残る');
  }
  const notBuilt = await get(unbuilt, '/');
  assert.equal(notBuilt.headers.get('cross-origin-opener-policy'), 'same-origin', 'まだビルドされていないときの案内ページにも付ける');
  const script = await get(built, '/assets/app.js');
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(script.headers.get('cross-origin-opener-policy'), null);
});
