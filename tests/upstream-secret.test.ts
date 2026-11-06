import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import { resolvePaths } from '../src/paths.ts';
import { classifyAnthropicError } from '../src/providers/anthropic.ts';
import { classifyHttpFailure, readSnippet, upstreamText } from '../src/providers/http.ts';
import { redactSecrets } from '../src/shared/redaction.ts';
import { startApp } from './app-setup.ts';
import { fail, tempDir, testConfig } from './helpers.ts';

// 相手のサーバーが API キーをそのまま返してきたとき、実行の記録に鍵の断片が残らない。
// 伏せる処理は、空白をそろえて 200 文字に切る「前」に、生の本文に対して行う（切ったあとでは、境目をまたいだ鍵に一致しない）。
// 鍵の途中の空白（2 つ以上・改行）は、並びが変わっていても同じ鍵として伏せる

// 鍵らしい形（sk- など）だと、伏せ字の処理に隠れて漏れを見逃すので、どの形にも当たらない文字列を使う
const KEY = 'Zk3qP9xW7mB2vN8cLd5Tq1';
const SPACED = 'Zk3qP9xW  7mB2vN8c  Ld5Tq1';

// secret の 8 文字以上の連続（空白は 1 つにそろえて数える）が text に残っていれば、その断片
function leak(text: string, secret: string, size = 8): string | undefined {
  const flat = (value: string) => value.replace(/\s+/gu, ' ');
  const haystack = flat(text);
  const needle = flat(secret);
  for (let i = 0; i + size <= needle.length; i++) {
    const piece = needle.slice(i, i + size);
    if (haystack.includes(piece)) return piece;
  }
  return undefined;
}

test('伏せ字（redactSecrets）: 鍵の空白は、並びが変わっていても（2 つ・1 つ・改行・タブ）同じ鍵として伏せる。JSON の中の書き方（\\ と "）でも伏せる', () => {
  for (const echoed of [SPACED, 'Zk3qP9xW 7mB2vN8c Ld5Tq1', 'Zk3qP9xW\n7mB2vN8c\t\tLd5Tq1']) {
    assert.equal(redactSecrets(`echo ${echoed} end`, [SPACED]), 'echo [REDACTED] end', JSON.stringify(echoed));
  }
  const odd = 'ab"cd\\ef gh/ij';
  assert.equal(redactSecrets(`plain ${odd} json ${JSON.stringify(odd)}`, [odd]), 'plain [REDACTED] json "[REDACTED]"');
  assert.equal(redactSecrets('longer-secret-value and secret', ['secret', 'longer-secret-value']), '[REDACTED] and [REDACTED]', '長い鍵を先に伏せる');
  assert.equal(redactSecrets('no secrets here', []), 'no secrets here');
});

test('提供元が失敗の本文を拾うところ: 鍵が 200 文字の境目をまたいでいても、鍵の空白が詰められていても、鍵の断片を残さない', async () => {
  for (const [secret, echoed] of [[KEY, KEY], [SPACED, SPACED], [SPACED, 'Zk3qP9xW 7mB2vN8c Ld5Tq1']] as const) {
    const body = `${'x '.repeat(95)}${echoed} and more text after the key`;
    const error = classifyHttpFailure(401, body, undefined, [secret]);
    assert.equal(leak(upstreamText(error.upstream ?? '', []), secret), undefined, `HTTP 失敗: ${JSON.stringify(echoed)}`);
    const unexpected = classifyAnthropicError(new Error(body), new AbortController().signal, [secret]);
    assert.equal(leak(upstreamText(unexpected.upstream ?? '', []), secret), undefined, `想定外のエラー: ${JSON.stringify(echoed)}`);
  }
  // 本文を読む時点（2000 文字の切り取りの前）でも伏せる: 切り取りの境目に鍵がまたがっても断片が残らない
  const padded = `${' '.repeat(1990)}${KEY}`;
  const snippet = await readSnippet(new Response(padded, { status: 400 }), [KEY]);
  assert.equal(leak(snippet, KEY), undefined);
  const json = await readSnippet(new Response(JSON.stringify({ error: { message: `${'y'.repeat(1500)} ${KEY}` } }), { status: 400 }), [KEY]);
  assert.equal(leak(json, KEY), undefined, 'JSON の本文');
});

test('実行の記録: 失敗の本文が鍵を返してきても、200 文字の境目をまたいでも、空白が詰められていても、鍵の断片は engine_runs にも /api/runs にも残らない（FakeAdapter 形）', async t => {
  const shapes: Array<[string, string, (secret: string, echoed: string) => Error]> = [
    ['HTTP の失敗（本文が長い）', KEY, (_secret, echoed) => classifyHttpFailure(401, `${'x'.repeat(190)}${echoed} and more`)],
    ['HTTP の失敗（鍵に空白が 2 つ）', SPACED, (_secret, echoed) => classifyHttpFailure(401, `${'x'.repeat(185)}${echoed} and more`)],
    ['想定外のエラー（長い）', KEY, (_secret, echoed) => new Error(`${'x'.repeat(190)}${echoed}`)],
    ['想定外のエラー（鍵に空白）', SPACED, (_secret, echoed) => new Error(`${'x'.repeat(190)}${echoed}`)],
  ];
  for (const [label, secret, make] of shapes) {
    for (const echoed of secret === SPACED ? [SPACED, 'Zk3qP9xW 7mB2vN8c Ld5Tq1'] : [secret]) {
      const s = await startApp(t, { env: { FAKE_KEY: secret } });
      s.adapter().scripts.push(fail(make(secret, echoed)), fail(make(secret, echoed)));
      const outcome = s.app.engine.send('c1', 'hi');
      assert.ok(outcome.ok);
      await s.app.engine.wait(outcome.runId);
      const row = s.app.runs.get(outcome.runId)!;
      assert.equal(row.ok, 0, `${label}: 前提: 失敗している`);
      assert.match(row.error_message ?? '', /x{20}/u, `${label}: 前提: 本文の一部は実行の記録に残る`);
      assert.equal(leak(row.error_message ?? '', secret), undefined, `${label} (${JSON.stringify(echoed)}): error_message に鍵の断片`);
      const all = JSON.stringify(s.app.db.prepare('SELECT * FROM engine_runs').all());
      assert.equal(leak(all, secret), undefined, `${label}: engine_runs 全体`);
      const api = await (await s.api('/api/runs')).text();
      assert.equal(leak(api, secret), undefined, `${label}: GET /api/runs`);
    }
  }
});

test('実行の記録（本物の提供元の窓口）: サーバーが本文に鍵を返しても、境目をまたいでも、空白が詰められていても、断片は残らない', async t => {
  for (const [secret, echoed] of [[KEY, KEY], [SPACED, SPACED], [SPACED, 'Zk3qP9xW 7mB2vN8c Ld5Tq1']] as const) {
    const dir = tempDir(t);
    const paths = { ...resolvePaths(dir), env: join(dir, '.env') };
    mkdirSync(paths.data, { recursive: true });
    const config = testConfig();
    config.providers = [{ id: 'svc', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'SVC_KEY', maxParallel: 1, timeoutMs: 10_000 }];
    config.models = [{ id: 'm', provider: 'svc', model: 'x-name', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
    config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
    config.memory.review = false;
    writeFileSync(paths.config, JSON.stringify(config));
    const message = `${'z'.repeat(185)}${echoed} ${'tail '.repeat(20)}`;
    const fetchStub: typeof fetch = async input => {
      const url = String(input);
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'x-name', max_model_len: 65536 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ error: { message } }), { status: 400, headers: { 'content-type': 'application/json' } });
    };
    const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, env: { SVC_KEY: secret }, fetch: fetchStub });
    t.after(() => app.close());
    await app.status.probeAll(app.config());
    const outcome = app.engine.send('c1', 'hi');
    assert.ok(outcome.ok);
    await app.engine.wait(outcome.runId);
    const row = app.runs.get(outcome.runId)!;
    assert.equal(row.ok, 0);
    assert.match(row.error_message ?? '', /z{20}/u, '前提: 本文の一部は実行の記録に残る');
    assert.equal(leak(row.error_message ?? '', secret), undefined, `error_message に鍵の断片 ${JSON.stringify(echoed)}`);
    assert.equal(leak(JSON.stringify(app.db.prepare('SELECT * FROM engine_runs').all()), secret), undefined, 'engine_runs 全体');
  }
});
