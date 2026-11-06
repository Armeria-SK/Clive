import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { WebAuth } from '../src/web/auth.ts';

// 段 9（A4）で見つかった: ポートを変えて反映すると、古い画面（別のポート）が新しいアドレスへ移る。
// ブラウザは、同じサイトの別のポートからの移動を Sec-Fetch-Site: same-site で送るので、今までの確かめ（same-origin か none だけ）は、移動先の画面を 403 にした

const auth = new WebAuth(['http://127.0.0.1:4800'], []);
const req = (headers: Record<string, string>, method = 'GET', url = '/') => ({ headers: { host: '127.0.0.1:4800', ...headers }, method, url } as unknown as IncomingMessage);
const NAVIGATE = { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

test('同じサイトの別のポートからの最上位の移動（画面の部品を取る GET）は通す', () => {
  assert.equal(auth.check(req(NAVIGATE)).ok, true);
  assert.equal(auth.check(req(NAVIGATE, 'GET', '/assets/index-abc.js?x=1')).ok, true);
  assert.equal(auth.check(req(NAVIGATE, 'GET', '/#/settings')).ok, true);
});

test('それ以外の same-site は、今までどおり断る: API・fetch・iframe・書き込み・別のサイト・Host が違うもの', () => {
  const rejected = (headers: Record<string, string>, method = 'GET', url = '/') => { const r = auth.check(req(headers, method, url)); return r.ok ? 'ok' : r.reason; };
  assert.equal(rejected(NAVIGATE, 'GET', '/api/settings'), 'cross_site', 'API は移動でも通さない');
  assert.equal(rejected(NAVIGATE, 'GET', '/API/settings'), 'cross_site');
  assert.equal(rejected(NAVIGATE, 'GET', '/api'), 'cross_site');
  assert.equal(rejected({ ...NAVIGATE, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }), 'cross_site', 'fetch');
  assert.equal(rejected({ ...NAVIGATE, 'sec-fetch-dest': 'iframe' }), 'cross_site', '埋め込み');
  assert.equal(rejected({ ...NAVIGATE, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' }), 'cross_site', '別のポートのページが部品を直接取る');
  assert.equal(rejected({ 'sec-fetch-site': 'same-site' }), 'cross_site', '印が足りない');
  assert.equal(rejected({ ...NAVIGATE, 'sec-fetch-site': 'cross-site' }), 'cross_site', '別のサイトからの移動');
  assert.equal(rejected({ ...NAVIGATE, origin: 'http://127.0.0.1:4800' }, 'POST'), 'cross_site', '書き込み');
  assert.equal(rejected({ ...NAVIGATE, host: 'evil.example:4800' }), 'host', 'Host の確かめは、移動でも通る');
});
