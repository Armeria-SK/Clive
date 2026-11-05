import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { Language } from '../src/config/schema.ts';
import { defaultConfig } from '../src/config/store.ts';
import { errorProbeText, evaluateContext } from '../src/providers/context.ts';
import { providerError } from '../src/providers/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { noUsableText } from '../web/src/chat-logic.ts';
import { FakeAdapter, tempDir } from './helpers.ts';

// 送る前の 409（使えるモデルが無い）の problems。モデルごとに、今までの文（message / hint）のほかに、
// モデルの確認と同じ messageCode / messageParams を添える（画面が、サーバーの言語にかかわらず自分の言語で組み立てられるように）。
// 日本語の出力は、これまでと 1 文字も変えない（下の文字列は、変更前のサーバーの出力をそのまま写したもの）。

async function startApp(t: { after: (fn: () => void | Promise<void>) => void }, language: Language, options: { probe: boolean }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = defaultConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  config.language = language;
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, adapterOverride: provider => (adapter = new FakeAdapter(provider)) });
  if (options.probe) await app.status.probeAll(app.config());
  t.after(() => app.close());
  return { app, adapter: () => adapter };
}

const FRAME_JA = '使えるモデルがないため送信しませんでした。設定画面で確認してください。\n';
const FRAME_EN = 'Nothing was sent because there is no model that can be used. Check the settings screen.\n';

// 送信は、本物のエンジンの返す SendOutcome を、HTTP の本文と同じく JSON にしたもので確かめる。
async function blockedBody(s: Awaited<ReturnType<typeof startApp>>): Promise<Record<string, any>> {
  const outcome = s.app.engine.send('c1', 'hi');
  assert.ok(!outcome.ok);
  const { ok: _ok, httpStatus, ...body } = outcome as Record<string, any>;
  assert.equal(httpStatus, 409);
  return JSON.parse(JSON.stringify(body)) as Record<string, any>;
}

test('送る前の 409（確認していない）: ja は今までと同じ文で、problems に messageCode が付く', async t => {
  const s = await startApp(t, 'ja', { probe: false });
  const body = await blockedBody(s);
  assert.equal(body.errorKind, 'context_overflow');
  assert.equal(body.errorCode, 'engine.no_usable');
  assert.equal(body.errorMessage, `${FRAME_JA}・m: まだ確認していません`, '日本語は 1 文字も変えない');
  assert.deepEqual(body.detail, { reason: 'context_unknown' });
  assert.deepEqual(body.problems, [{ modelId: 'm', status: 'unknown', message: 'まだ確認していません', messageCode: 'engine.problem.unchecked' }]);
});

test('送る前の 409（確認していない）: en は英語の文で、同じコードが付く', async t => {
  const s = await startApp(t, 'en', { probe: false });
  const body = await blockedBody(s);
  assert.equal(body.errorMessage, `${FRAME_EN}- m: Not checked yet`);
  assert.deepEqual(body.problems, [{ modelId: 'm', status: 'unknown', message: 'Not checked yet', messageCode: 'engine.problem.unchecked' }]);
});

test('送る前の 409（接続できない）: モデルの確認の messageCode / messageParams をそのまま problems に付ける。ja の文は今までと同じ', async t => {
  const s = await startApp(t, 'ja', { probe: false });
  const unreachable = errorProbeText(providerError('provider_error', 'probe.ollama_unreachable', { base: 'http://127.0.0.1:11434' }), 'ja');
  s.adapter().probeResult = { status: 'unreachable', ...unreachable };
  await s.app.status.probeAll(s.app.config());
  const body = await blockedBody(s);
  assert.equal(body.errorKind, 'provider_error');
  assert.equal(body.errorMessage, `${FRAME_JA}・m: Ollama（http://127.0.0.1:11434）に接続できません。起動しているか確認してください`);
  assert.deepEqual(body.problems, [{
    modelId: 'm', status: 'unreachable', message: 'Ollama（http://127.0.0.1:11434）に接続できません。起動しているか確認してください',
    messageCode: 'provider.probe.ollama_unreachable', messageParams: { base: 'http://127.0.0.1:11434' },
  }]);
});

test('送る前の 409（長さが足りない）: 直し方（hint）と、出どころ・数のコードが付く。ja の文は今までと同じ', async t => {
  const s = await startApp(t, 'ja', { probe: false });
  s.adapter().probeResult = evaluateContext({ modelId: 'm', server: 'generic', required: 32768, declared: 8192, hint: '直し方のテスト', language: 'ja', now: 1 });
  await s.app.status.probeAll(s.app.config());
  const body = await blockedBody(s);
  assert.equal(body.errorKind, 'context_overflow');
  assert.equal(body.errorMessage, `${FRAME_JA}・m: コンテキスト長が足りません: measured 8,192 < required 32,768（設定 8,192）（直し方のテスト）`);
  assert.deepEqual(body.detail, { reason: 'server_ctx_too_small', hint: '直し方のテスト' });
  assert.deepEqual(body.problems, [{
    modelId: 'm', status: 'too_small', message: 'コンテキスト長が足りません: measured 8,192 < required 32,768（設定 8,192）', hint: '直し方のテスト',
    messageCode: 'provider.probe.too_small', messageParams: { effective: '8,192', required: '32,768', sourceKind: 'declared', n: '8,192' },
  }]);
});

test('送る前の 409: コードの無いモデルの確認（古いアダプタなど）は、今までどおり文だけで、コードのキーは付けない', async t => {
  const s = await startApp(t, 'ja', { probe: false });
  s.adapter().probeResult = { status: 'error', message: '想定外の失敗' };
  await s.app.status.probeAll(s.app.config());
  const body = await blockedBody(s);
  assert.deepEqual(body.problems, [{ modelId: 'm', status: 'error', message: '想定外の失敗' }]);
  assert.equal(body.errorMessage, `${FRAME_JA}・m: 想定外の失敗`);
});

test('画面の組み立て: サーバーが ja で書いた 409 を、problems 自身のコードだけ（モデルの一覧なし）で、サーバーが en で書く文と同じ英語にできる', async t => {
  const scenarios: Array<{ name: string; probe: (language: Language) => Record<string, unknown> | null }> = [
    { name: '確認していない', probe: () => null },
    { name: '接続できない', probe: language => ({ status: 'unreachable', ...errorProbeText(providerError('provider_error', 'probe.ollama_unreachable', { base: 'http://127.0.0.1:11434' }), language) }) },
    { name: '長さが足りない（直し方つき）', probe: language => evaluateContext({ modelId: 'm', server: 'generic', required: 32768, measured: 8192, hint: 'same hint', language, now: 1 }) as never },
    { name: '長さが分からない', probe: language => evaluateContext({ modelId: 'm', server: 'generic', required: 32768, language, now: 1 }) as never },
  ];
  for (const scenario of scenarios) {
    const bodies = {} as Record<Language, Record<string, any>>;
    for (const language of ['ja', 'en'] as const) {
      const s = await startApp(t, language, { probe: false });
      const probe = scenario.probe(language);
      if (probe) { s.adapter().probeResult = probe; await s.app.status.probeAll(s.app.config()); }
      bodies[language] = await blockedBody(s);
    }
    // 直し方（hint）はサーバーの種類ごとの手順で、画面は訳さずそのまま出す。サーバーが作る言語のままなので、比べるときは外す
    const stripHint = (text: string, body: Record<string, any>): string => { const hint = body.problems[0]?.hint as string | undefined; return hint ? text.replace(`（${hint}）`, '').replace(` (${hint})`, '') : text; };
    assert.notEqual(bodies.ja.errorMessage, bodies.en.errorMessage, `${scenario.name}: 言語ごとに別の文`);
    assert.equal(stripHint(noUsableText(bodies.ja, [], 'en')!, bodies.ja), stripHint(bodies.en.errorMessage, bodies.en), `${scenario.name}: ja の 409 を en の画面で`);
    assert.equal(stripHint(noUsableText(bodies.en, [], 'ja')!, bodies.en), stripHint(bodies.ja.errorMessage, bodies.ja), `${scenario.name}: en の 409 を ja の画面で`);
    assert.equal(noUsableText(bodies.ja, [], 'ja'), bodies.ja.errorMessage, `${scenario.name}: 同じ言語なら同じ文`);
  }
});
