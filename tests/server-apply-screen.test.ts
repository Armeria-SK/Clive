import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError, type ServerApplyResult } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { setLanguagePreference } from '../web/src/i18n/index.ts';
import { applyFailure, applyStep } from '../web/src/settings/server-apply.ts';
import { errorBodyText } from '../web/src/server-text.ts';

// 段 9（A4）: 設定の「再起動する」の、画面を使わない部分（反映したあとの動き・失敗の読み分け・辞書）

afterEach(() => setLanguagePreference('auto'));

const result = (over: Partial<ServerApplyResult>): ServerApplyResult => ({ applied: { listen: false, auth: true }, server: { host: '127.0.0.1', port: 4777 }, url: null, restartRequired: false, ...over });

test('applyStep: ポートが変わった（url がある）ときは、新しいアドレスへ移り、いま開いている画面の場所（#/settings など）も持っていく。それ以外はその場で済む', () => {
  assert.deepEqual(applyStep(result({ applied: { listen: true, auth: false }, url: 'http://127.0.0.1:4800/' }), '#/settings'), { kind: 'move', to: 'http://127.0.0.1:4800/#/settings' });
  assert.deepEqual(applyStep(result({ url: 'http://127.0.0.1:4800' }), ''), { kind: 'move', to: 'http://127.0.0.1:4800/' }, '末尾の / があっても無くても同じ');
  assert.deepEqual(applyStep(result({}), '#/settings'), { kind: 'stay', restartRequired: false });
  assert.deepEqual(applyStep(result({ restartRequired: true }), ''), { kind: 'stay', restartRequired: true }, '反映したあとに設定がまた変わっていれば、帯は残る');
});

test('applyFailure: 締め出しの確かめ（409 would_lock_out）は理由つきの確かめ、nothing_to_apply は「もう反映済み」、ほかは失敗', () => {
  const lock = applyFailure(new ApiError(409, { error: 'would_lock_out', code: 'http.lockout_port', message: '待ち受ける場所が変わるので…' }));
  assert.equal(lock.kind, 'lockout');
  assert.match((lock as { message: string }).message, /Tailscale/u);
  assert.deepEqual(applyFailure(new ApiError(409, { error: 'nothing_to_apply', code: 'http.nothing_to_apply', message: 'x' })), { kind: 'nothing' });
  for (const [status, error] of [[409, 'listen_failed'], [409, 'busy'], [409, 'invalid_server'], [403, 'forbidden'], [500, 'internal']] as const) {
    assert.equal(applyFailure(new ApiError(status, { error, message: 'x' })).kind, 'failed', `${status} ${error}`);
  }
  assert.deepEqual(applyFailure(new TypeError('Failed to fetch')), { kind: 'failed', message: null }, '通信が切れたとき');
  assert.equal(applyFailure(new ApiError(400, { error: 'would_lock_out', message: 'x' })).kind, 'failed', '409 以外は、確かめにしない');
});

test('辞書: 再起動の文は ja と en にあり、サーバーの理由（締め出し・待ち受けの失敗など）のコードは、画面の言語に訳せる', () => {
  for (const key of ['settings.restart.button', 'settings.restart.busy', 'settings.restart.done', 'settings.restart.already', 'settings.restart.failed', 'settings.restart.lockoutTitle', 'settings.restart.lockoutNote', 'settings.restart.lockoutCancel', 'settings.restart.lockoutDo'] as const) {
    assert.equal(typeof ja[key], 'string', key);
    assert.equal(typeof en[key], 'string', key);
  }
  const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;
  const cases: Array<[string, Record<string, string | number> | undefined]> = [
    ['http.nothing_to_apply', undefined], ['http.apply_busy', undefined], ['http.host_not_loopback', { host: '0.0.0.0' }], ['http.bad_server', undefined],
    ['http.listen_failed', { host: '127.0.0.1', port: 4800, errno: 'EADDRINUSE' }], ['http.lockout_port', undefined], ['http.lockout_address', { address: '127.0.0.1' }],
    ['http.lockout_origin', { origin: 'http://127.0.0.1:4800' }], ['http.lockout_login', { login: 'me@example.com' }],
  ];
  for (const [code, params] of cases) {
    setLanguagePreference('en');
    const english = errorBodyText({ code, params }, 'en');
    assert.ok(english && !CJK.test(english), `${code}: 英語に訳せる（${english}）`);
    const japanese = errorBodyText({ code, params }, 'ja');
    assert.ok(japanese && CJK.test(japanese), `${code}: 日本語に訳せる`);
    for (const value of Object.values(params ?? {})) assert.ok(english.includes(String(value)) && japanese.includes(String(value)), `${code}: 値 ${value} が入る`);
  }
});
