import Anthropic from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { classifyAnthropicError } from '../src/providers/anthropic.ts';
import { classifyHttpFailure } from '../src/providers/http.ts';
import { OllamaAdapter } from '../src/providers/ollama.ts';
import { OpenAiCompatibleAdapter } from '../src/providers/openai-compatible.ts';
import { providerError } from '../src/providers/types.ts';
import { fail, fakeServer, FakeAdapter, tempDir, testConfig } from './helpers.ts';

// 相手のサーバーが返した本文（Python の traceback・内部のパス・モデル名など）は、どの画面にも出さない。
// 利用者に見える文は短い文だけで、本文は実行ログ（engine_runs.error_message）にだけ残す

const BODY = 'Traceback (most recent call last): File "/srv/app/handler.py", line 12, in run ValueError: internal-model-xyz at /home/ops/secret';
const LEAK = /Traceback|ValueError|internal-model-xyz|\/home\/ops/u;

test('HTTP の失敗: 文にも、文に添える値にも、相手のサーバーの本文は入らない。本文は upstream にだけ残る', () => {
  const bodies = [BODY, `{"error":{"message":"${BODY.replaceAll('"', "'")}"}}`];
  for (const body of bodies) {
    for (const status of [400, 401, 403, 404, 408, 409, 429, 500, 503]) {
      const error = classifyHttpFailure(status, body);
      for (const text of [error.message, error.text('ja'), error.text('en'), JSON.stringify(error.params)]) assert.doesNotMatch(text, LEAK, `HTTP ${status}: ${text}`);
      assert.equal('suffix' in error.params, false, `HTTP ${status}: suffix が残っている`);
      assert.match(error.upstream ?? '', /Traceback/u, `HTTP ${status}: 実行ログ用の本文が残っていない`);
      assert.ok((error.upstream ?? '').length <= 300, '長い本文は切る');
    }
    const overflow = classifyHttpFailure(400, `maximum context length exceeded ${body}`);
    assert.equal(overflow.kind, 'context_overflow');
    for (const text of [overflow.message, overflow.text('en'), JSON.stringify(overflow.params)]) assert.doesNotMatch(text, LEAK);
  }
  assert.equal(classifyHttpFailure(401, 'bad key').text('ja'), '認証に失敗しました（HTTP 401）');
  assert.equal(classifyHttpFailure(503, '').text('en'), 'The provider reported an error (HTTP 503)');
  assert.equal(classifyHttpFailure(400, 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 rejected').upstream?.includes('abcdefghijklmnopqrstuvwxyz0123456789'), false, '本文の秘密は、実行ログ用にも伏せる');
  assert.equal(classifyHttpFailure(400, '').upstream, undefined);
});

test('Anthropic: 想定外のエラーも、API のエラーも、本文を文に入れない', () => {
  const signal = new AbortController().signal;
  const unexpected = classifyAnthropicError(new Error(BODY), signal);
  assert.equal(unexpected.code, 'unexpected');
  for (const text of [unexpected.message, unexpected.text('en'), JSON.stringify(unexpected.params)]) assert.doesNotMatch(text, LEAK);
  assert.match(unexpected.upstream ?? '', /Traceback/u);
  const api = classifyAnthropicError(new Anthropic.APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: BODY } }, BODY, new Headers()), signal);
  for (const text of [api.message, api.text('en'), JSON.stringify(api.params)]) assert.doesNotMatch(text, LEAK);
  assert.match(api.upstream ?? '', /Traceback/u);
});

const provider = (url: string): ProviderConfig => ({ id: 'p', kind: 'openai_compatible', baseUrl: `${url}/v1`, maxParallel: 1, timeoutMs: 10_000 });
const model: ModelConfig = { id: 'm', provider: 'p', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false };

test('モデルの確認: 相手のサーバーが 500 や 400 で本文を返しても、確認の結果の文にも値にも本文は入らない', async t => {
  for (const status of [400, 401, 404, 500]) {
    const server = await fakeServer((_req, _body, res) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(BODY); });
    t.after(() => server.close());
    const compat = await new OpenAiCompatibleAdapter(provider(server.url), {}).probe(model, 65536, 'ja');
    const ollama = await new OllamaAdapter({ id: 'o', kind: 'ollama', baseUrl: server.url, maxParallel: 1, timeoutMs: 10_000 }, {}).probe(model, 65536, 'ja');
    for (const result of [compat, ollama]) assert.doesNotMatch(JSON.stringify(result), LEAK, `HTTP ${status}: ${JSON.stringify(result)}`);
  }
});

async function startApp(t: { after: (fn: () => void | Promise<void>) => void }, edit: (c: ReturnType<typeof testConfig>) => void = () => undefined) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }, { id: 'spare', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:2/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [
    { id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false },
    { id: 'm2', provider: 'spare', model: 'y', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false },
  ];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 1 };
  config.memory.review = false;
  edit(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
  const adapters = new Map<string, FakeAdapter>();
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false,
    adapterOverride: p => { const a = new FakeAdapter(p); adapters.set(p.id, a); return a; },
  });
  await app.status.probeAll(app.config());
  const events: RunEvent[] = [];
  app.bus.subscribe(e => events.push(e.event));
  t.after(() => app.close());
  return { app, adapter: (id = 'fake') => adapters.get(id)!, clock, events };
}

const upstreamFailure = (status = 400, retryable = false) => fail(Object.assign(classifyHttpFailure(status, BODY), retryable ? {} : {}));

test('返事の失敗: 画面に届く出来事（run.end・再試行の警告・結果）に本文は無く、実行ログには本文が残る', async t => {
  const s = await startApp(t);
  s.adapter().scripts.push(upstreamFailure(503), upstreamFailure(503));
  const outcome = s.app.engine.send('c1', 'hi');
  assert.ok(outcome.ok);
  const result = await s.app.engine.wait(outcome.runId);
  assert.ok(result && !result.ok);
  assert.doesNotMatch(JSON.stringify(result), LEAK, '結果');
  assert.doesNotMatch(JSON.stringify(s.events), LEAK, 'run.end・警告の出来事');
  const row = s.app.runs.get(outcome.runId)!;
  assert.match(row.error_message ?? '', /プロバイダ側のエラーです（HTTP 503）/u, '実行ログには短い文');
  assert.match(row.error_message ?? '', /Traceback/u, '実行ログには本文が残る');
});

test('モデルの切り替え・続けて失敗した知らせ: 理由に本文は入らない', async t => {
  const s = await startApp(t, c => { c.routing = { chat: ['m', 'm2'], background: [], retriesPerModel: 0 }; });
  s.adapter().scripts.push(upstreamFailure(500));
  s.adapter('spare').scripts.push(fail(providerError('provider_error', 'http.server', { status: 500 }, { retryable: false })));
  const first = s.app.engine.send('c1', 'hi');
  assert.ok(first.ok);
  await s.app.engine.wait(first.runId);
  assert.doesNotMatch(JSON.stringify(s.events), LEAK, 'model.switch を含む出来事');
  for (let i = 2; i < 6; i++) {
    s.adapter().scripts.push(upstreamFailure(500));
    s.adapter('spare').scripts.push(fail(providerError('provider_error', 'http.server', { status: 500 }, { retryable: false })));
    const o = s.app.engine.send(`c${i}`, 'hi');
    assert.ok(o.ok);
    await s.app.engine.wait(o.runId);
  }
  assert.ok(s.app.notifications.list().some(n => n.kind === 'health_alert'), '前提: 続けて失敗した知らせが出ている');
  assert.doesNotMatch(JSON.stringify(s.app.notifications.list()), LEAK, '知らせ');
  assert.doesNotMatch(JSON.stringify([s.app.status.all(), s.app.status.coolingDown('m'), s.app.status.coolingDown('m2')]), LEAK, 'モデルの状態の理由');
});

test('タスクの失敗: 再試行の理由・結果・失敗の知らせに本文は入らない', async t => {
  const s = await startApp(t, c => { c.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 }; });
  const task = s.app.tasks.create({ title: '壊れた仕事', origin: 'user', actor: 'user' });
  for (let i = 0; i < 3; i++) s.adapter().scripts.push(upstreamFailure(400));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.doesNotMatch(JSON.stringify(s.app.tasks.get(task.id)), LEAK, '1 回目の失敗のあとの理由');
  for (let i = 0; i < 2; i++) { s.clock.now += 6 * 60_000; assert.equal(await s.app.worker.tick(), 'ran'); }
  const done = s.app.tasks.get(task.id)!;
  assert.equal(done.status, 'failed');
  assert.doesNotMatch(JSON.stringify(done), LEAK, 'タスクの結果');
  assert.doesNotMatch(JSON.stringify(s.app.tasks.events(task.id)), LEAK, 'タスクの履歴');
  assert.ok(s.app.notifications.list().some(n => n.kind === 'task_failed'));
  assert.doesNotMatch(JSON.stringify(s.app.notifications.list()), LEAK, '知らせ');
});
