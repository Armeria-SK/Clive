import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig, Language, ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { ProviderError, providerError } from '../src/providers/types.ts';
import { describeCron } from '../src/tasks/schedule.ts';
import { TaskError } from '../src/tasks/store.ts';
import { createWebServer } from '../src/web/server.ts';
import { CONTEXT_HINTS, contextHint, evaluateContext } from '../src/providers/context.ts';
import { classifyFetchError, classifyHttpFailure, requireApiKey } from '../src/providers/http.ts';
import { OllamaAdapter } from '../src/providers/ollama.ts';
import { OpenAiCompatibleAdapter } from '../src/providers/openai-compatible.ts';
import { fail, fakeServer, FakeAdapter, reply, tempDir, type Script, testConfig } from './helpers.ts';

const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;
const MIN = 60_000;

function toolCall(name: string, args: unknown): Script {
  return async function* () {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

function hang(): Script {
  return async function* (req) {
    yield { type: 'text', delta: 'working…' };
    await new Promise((_, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    });
  };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out: ${label}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

async function startApp(t: { after: (fn: () => void | Promise<void>) => void }, options: { language?: Language; edit?: (c: AppConfig) => void } = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  if (options.language) config.language = options.language;
  options.edit?.(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
  let adapter!: FakeAdapter;
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false,
    adapterOverride: provider => (adapter = new FakeAdapter(provider)),
  });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  return { app, paths, adapter: () => adapter, clock };
}

const noJapanese = (label: string, text: string | null | undefined) => assert.doesNotMatch(text ?? '', CJK, `${label}: ${text}`);

// ── 繰り返しの説明 ──

test('describeCron: 英語では英語で説明し、日本語は今までのまま', () => {
  const cases: Array<[string, string, string]> = [
    ['0 9 * * *', '毎日 09:00', 'Every day at 09:00'],
    ['0 9 * * MON-FRI', '平日 09:00', 'Weekdays at 09:00'],
    ['15 10 * * TUE', '毎週火曜 10:15', 'Every Tuesday at 10:15'],
    ['15 10 * * SUN', '毎週日曜 10:15', 'Every Sunday at 10:15'],
    ['5 * * * *', '毎時 5 分', 'Hourly at minute 5'],
    ['*/30 * * * *', '30 分ごと', 'Every 30 min'],
    ['0 0 1 * *', '0 0 1 * *', '0 0 1 * *'],
  ];
  for (const [cron, ja, en] of cases) {
    assert.equal(describeCron(cron), ja, cron);
    assert.equal(describeCron(cron, 'ja'), ja, cron);
    assert.equal(describeCron(cron, 'en'), en, cron);
  }
});

// ── タスクの経過・理由・通知を、作るときの言語で書く ──

test('タスクの経過と通知: language が en なら英語で書き、ja は今までの文のまま', async t => {
  for (const language of ['ja', 'en'] as const) {
    const s = await startApp(t, { language });
    const pick = <T>(ja: T, en: T): T => (language === 'ja' ? ja : en);

    const stopped = s.app.tasks.create({ title: language === 'ja' ? '止める仕事' : 'Stop me', origin: 'user', actor: 'user' });
    s.adapter().scripts.push(hang());
    const ticking = s.app.worker.tick();
    await waitFor(() => s.adapter().calls.length === 1, 'run starts');
    assert.ok(s.app.engine.stop(s.app.worker.status().running!.runId));
    await ticking;
    const requeued = s.app.tasks.events(stopped.id).find(e => e.kind === 'requeued')!;
    assert.equal(requeued.content, pick('止められたので、少し休んでから再開します', 'It was stopped, so it will rest for a short while and then resume'));

    s.clock.now += 20_000;
    s.adapter().scripts.push(toolCall('task_complete', { summary: language === 'ja' ? '終わった' : 'Finished', notify: true }));
    await s.app.worker.tick();
    const done = s.app.notifications.list()[0]!;
    assert.equal(done.kind, 'task_done');
    assert.equal(done.title, pick('タスク完了: 止める仕事', 'Task finished: Stop me'));

    const asked = s.app.tasks.create({ title: 'Q', origin: 'user', actor: 'user' });
    s.adapter().scripts.push(toolCall('ask_user', { question: language === 'ja' ? 'どうしますか' : 'What now?' }));
    await s.app.worker.tick();
    assert.equal(s.app.notifications.list()[0]!.title, pick('質問があります: Q', 'I have a question: Q'));
    assert.equal(s.app.tasks.get(asked.id)!.status, 'waiting');

    const retried = s.app.tasks.create({ title: 'R', origin: 'user', actor: 'user' });
    s.adapter().scripts.push(fail(new ProviderError('provider_error', 'boom', { retryable: false })));
    await s.app.worker.tick();
    const retry = s.app.tasks.events(retried.id).find(e => e.kind === 'requeued')!;
    assert.equal(retry.content, pick('失敗しました（boom）。1 分後にもう一度試します', 'It failed (boom). Will try again in 1 min'));

    const checkpoint = s.app.tasks.create({ title: 'C', origin: 'user', actor: 'user' });
    s.clock.now += 2 * MIN;
    s.adapter().scripts.push(toolCall('task_checkpoint', { tried: 'a', result: 'b', next_action: 'c', resume_after_minutes: 7 }));
    await s.app.worker.tick();
    assert.equal(s.app.tasks.events(checkpoint.id).find(e => e.kind === 'requeued')!.content, pick('7 分後に再開します', 'Will resume in 7 min'));
    if (language === 'en') for (const n of s.app.notifications.list()) { noJapanese('notification title', n.title); noJapanese('notification body', n.body); }
  }
});

test('タスクの相談: 3 回続けて決められなければ相談する（英語）', async t => {
  const s = await startApp(t, { language: 'en' });
  const task = s.app.tasks.create({ title: 'Vague job', origin: 'user', actor: 'user' });
  for (let i = 0; i < 3; i++) {
    s.adapter().scripts.push(reply(`thought ${i}`));
    await s.app.worker.tick();
    s.clock.now += 40 * MIN;
  }
  const stuck = s.app.tasks.get(task.id)!;
  assert.equal(stuck.status, 'waiting');
  assert.equal(stuck.waiting_text, 'I tried to work on "Vague job" 3 times but could not decide how to proceed. Please tell me what to do (cancel it if you would rather drop it)');
  assert.equal(s.app.notifications.list()[0]!.title, 'I need your advice: Vague job');
  assert.match(stuck.body, /- Note: thought 0/u);
});

test('実行の上限・使えるモデルが無いときの通知（英語）', async t => {
  const s = await startApp(t, { language: 'en', edit: c => { c.worker.maxRunsPerHour = 1; } });
  s.app.tasks.create({ title: 'One', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'ok', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  s.app.tasks.create({ title: 'Two', origin: 'user', actor: 'user' });
  assert.equal(await s.app.worker.tick(), 'budget');
  const budget = s.app.notifications.list().find(n => n.kind === 'info')!;
  assert.equal(budget.title, 'The hourly run limit was reached, so tasks are being held back for a while');
  assert.equal(budget.body, 'The limit is 1 run(s) per hour (worker.maxRunsPerHour in the settings). Urgent tasks can be started with "Run now"');
});

test('ワーカーの題・理由（英語）: 振り返りの会話の題と、モデルが無いときの待ち', async t => {
  const s = await startApp(t, { language: 'en', edit: c => { c.memory.review = true; } });
  await s.app.worker.tick();
  s.adapter().scripts.push(reply('hello'));
  const sent = s.app.engine.send('c1', 'hello');
  assert.ok(sent.ok);
  await s.app.engine.wait(sent.runId);
  s.app.reviews.enqueue('manual', 'manual:c1', { conversationId: 'c1' });
  s.adapter().scripts.push(reply('No changes'));
  await s.app.worker.tick();
  const titles = (s.app.db.prepare("SELECT title FROM conversations WHERE kind = 'task'").all() as Array<{ title: string }>).map(r => r.title);
  assert.deepEqual(titles, ['Review: Manual']);
  assert.equal(s.app.reviews.list()[0]!.note, 'No changes');

  const idle = s.app.tasks.create({ title: 'Needs a model', origin: 'user', actor: 'user' });
  s.adapter().probeResult = { status: 'unreachable', message: 'no connection' };
  await s.app.status.probeAll(s.app.config());
  assert.equal(await s.app.worker.tick(), 'no_model');
  assert.equal(s.app.notifications.list().find(n => n.kind === 'health_alert')!.title, 'No model is available to run the task');
  assert.match(s.app.tasks.events(idle.id).find(e => e.kind === 'requeued')!.content ?? '', /^Waiting because no model is available: /u);
});

test('モデルの不調の通知（英語）と、タスクの保存済みの経過は元の言語のまま', async t => {
  const s = await startApp(t, { language: 'ja' });
  const task = s.app.tasks.create({ title: 'A', origin: 'user', actor: 'user', propose: true });
  assert.equal(s.app.tasks.events(task.id)[0]!.content, '提案として作成');
  await s.app.applyConfig({ ...s.app.config(), language: 'en' });
  const proposal = s.app.tasks.create({ title: 'B', origin: 'user', actor: 'user', propose: true });
  assert.equal(s.app.tasks.events(proposal.id)[0]!.content, 'Created as a proposal');
  assert.equal(s.app.tasks.events(task.id)[0]!.content, '提案として作成', '言語を変える前に作られた経過は書き換えない');

  s.app.bus.publish({ type: 'model.switch', runId: 'r', conversationId: 'c', from: 'm', to: 'n', reason: 'timeout' });
  for (let i = 0; i < 2; i++) s.app.bus.publish({ type: 'model.switch', runId: 'r', conversationId: 'c', from: 'm', to: 'n', reason: 'timeout' });
  const alert = s.app.notifications.list().find(n => n.kind === 'health_alert')!;
  assert.equal(alert.title, 'Model "m" keeps failing (3 times)');
  assert.equal(alert.body, 'timeout\nFallback models will be tried first for 5 minutes.');
});

test('タスクの予定・復旧・エラー（英語）と、コード', async t => {
  const s = await startApp(t, { language: 'en' });
  const template = s.app.tasks.create({ title: 'Daily', origin: 'user', actor: 'user', cron: '0 9 * * *', timezone: 'UTC' });
  assert.equal(s.app.tasks.events(template.id)[0]!.content, 'Repeat: 0 9 * * *');
  const child = s.app.tasks.spawnNow(template.id)!;
  assert.equal(s.app.tasks.events(child.id)[0]!.content, 'Created from the schedule "Daily"');
  assert.equal(s.app.tasks.spawnNow(template.id), undefined);
  assert.equal(s.app.tasks.events(template.id)[0]!.content, 'The previous run has not finished yet, so none was created this time');

  const claimed = s.app.tasks.create({ title: 'Mid', origin: 'user', actor: 'user' });
  const conv = s.app.conversations.create({ kind: 'task' });
  assert.ok(s.app.tasks.claim(claimed.id, MIN, conv.id));
  s.app.tasks.recoverExpiredLeases({ all: true });
  assert.equal(s.app.tasks.events(claimed.id)[0]!.content, 'The previous run stopped midway, so it will run again');

  for (const make of [() => s.app.tasks.create({ title: ' ', origin: 'user', actor: 'user' }), () => s.app.tasks.approve(claimed.id)]) {
    try { make(); assert.fail('should throw'); } catch (error) {
      assert.ok(error instanceof TaskError);
      noJapanese('en text', error.text('en'));
      assert.match(error.message, CJK, 'message stays the Japanese text');
    }
  }
  const empty = new TaskError('error.empty_title');
  assert.equal(empty.fullCode, 'task.error.empty_title');
  assert.equal(empty.text('en'), 'The title is empty');
  assert.equal(empty.message, 'タイトルが空です');
  const missing = new TaskError('error.not_found', { id: 'abc' });
  assert.deepEqual(missing.params, { id: 'abc' });
  assert.equal(missing.text('en'), 'Task abc was not found');
});

test('API: タスクの操作の失敗は、コードとパラメータを添え、文は language で書く', async t => {
  const s = await startApp(t, { language: 'en' });
  const web = createWebServer(s.app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); });
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  const api = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, { ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Origin: origin } });

  const task = s.app.tasks.create({ title: 'Ready one', origin: 'user', actor: 'user' });
  const res = await api(`/api/tasks/${task.id}/approve`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 409);
  const body = await res.json() as any;
  assert.equal(body.error, 'task', 'the existing error code is unchanged');
  assert.equal(body.code, 'task.error.not_proposal');
  assert.equal(body.message, 'This is not a proposal waiting for approval');

  await s.app.applyConfig({ ...s.app.config(), language: 'ja' });
  const ja = await (await api(`/api/tasks/${task.id}/approve`, { method: 'POST', body: '{}' })).json() as any;
  assert.equal(ja.message, '承認待ちの提案ではありません');
  assert.equal(ja.code, 'task.error.not_proposal');

  const listed = await (await api('/api/tasks')).json() as any;
  assert.equal(listed.active.length, 1);
  const scheduled = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Every day', repeat: { freq: 'daily', values: { time: '09:00' } } }) });
  assert.equal(((await scheduled.json()) as any).task.cron_text, '毎日 09:00');
  await s.app.applyConfig({ ...s.app.config(), language: 'en' });
  const again = await (await api('/api/tasks')).json() as any;
  assert.equal(again.active.find((x: any) => x.title === 'Every day').cron_text, 'Every day at 09:00');
});

// ── モデルの確認・プロバイダのエラー ──

const probeModel = (over: Partial<ModelConfig> = {}): ModelConfig => ({ id: 'm', provider: 'p', model: 'test-model', contextLength: 8192, minContext: 1024, maxOutputTokens: 512, toolMode: 'native', vision: false, ...over });
const compatProvider = (baseUrl: string, over: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: 'p', kind: 'openai_compatible', baseUrl, maxParallel: 1, timeoutMs: 10_000, ...over });

test('モデルの確認: 日本語の文は今までの出力と一字も違わない', () => {
  const facts = { modelId: 'm', server: 'generic', required: 65536 };
  const tooSmall = evaluateContext({ ...facts, measured: 4096, hint: CONTEXT_HINTS.generic(65536) });
  assert.equal(tooSmall.message, 'コンテキスト長が足りません: measured 4,096 < required 65,536（実測 4,096）');
  assert.equal(tooSmall.hint, 'サーバー側のコンテキスト長を 65,536 以上にして、config の contextLength も合わせてください');
  assert.equal(evaluateContext({ ...facts, declared: 8192, hint: 'x' }).message, 'コンテキスト長が足りません: measured 8,192 < required 65,536（設定 8,192）');
  assert.equal(evaluateContext({ ...facts, modelMax: 4096, hint: 'x' }).message, 'コンテキスト長が足りません: measured 4,096 < required 65,536（上限 4,096）');
  const exceeds = evaluateContext({ ...facts, declared: 200000, modelMax: 131072 });
  assert.equal(exceeds.message, '設定の contextLength（200,000）がモデルの上限（131,072）を超えています');
  assert.equal(exceeds.hint, 'contextLength を 131,072 以下にしてください');
  const unknown = evaluateContext(facts);
  assert.equal(unknown.message, 'コンテキスト長が分かりません（サーバーから取得できず、設定にもありません）');
  assert.equal(unknown.hint, 'config の models[].contextLength に、サーバー側で設定した長さを書いてください');
  assert.equal(evaluateContext({ ...facts, declared: 70000 }).message, '使用できます: 70,000 トークン');
  assert.equal(evaluateContext({ ...facts, declared: 70000, unmeasuredNote: 'probe.note.use_config' }).message, '使用できます: 70,000 トークン（サーバーから長さを取得できないため、設定値を使っています）');
  assert.equal(CONTEXT_HINTS.hosted(65536), 'コンテキスト長が 65,536 以上のモデルを選んでください');
  assert.equal(CONTEXT_HINTS.ollama(65536), 'config の contextLength を 65,536 以上にしてください（Clive は毎回 num_ctx として送ります）。VRAM が足りないと遅くなるか読み込みに失敗します');
  assert.equal(CONTEXT_HINTS.lmstudio(65536), 'LM Studio でモデルを読み込むときの Context Length を 65,536 以上にして読み込み直し、contextLength も合わせてください');
  assert.equal(CONTEXT_HINTS.llamacpp(65536), 'llama-server を -c で起動し、スロットあたり 65,536 以上にしてください（-np でスロットを増やすと -c が分割されます）');
  assert.equal(CONTEXT_HINTS.vllm(65536), 'vLLM を --max-model-len 65,536 以上で起動してください');
  assert.equal(CONTEXT_HINTS.tabbyapi(65536), 'TabbyAPI の config.yml（model の max_seq_len）を 65,536 以上にしてモデルを読み込み直し、contextLength も合わせてください（cache_size も同じ以上に）');
});

test('モデルの確認: messageParams には言語で書いた文を入れず、小さなコードと値を入れる', () => {
  const facts = { modelId: 'm', server: 'generic', required: 65536 };
  for (const language of ['ja', 'en'] as const) {
    assert.deepEqual(evaluateContext({ ...facts, language, declared: 8192, hint: 'x' }).messageParams, { effective: '8,192', required: '65,536', sourceKind: 'declared', n: '8,192' });
    assert.deepEqual(evaluateContext({ ...facts, language, modelMax: 4096, hint: 'x' }).messageParams, { effective: '4,096', required: '65,536', sourceKind: 'limit', n: '4,096' });
    assert.deepEqual(evaluateContext({ ...facts, language, declared: 70000 }).messageParams, { effective: '70,000' });
    assert.deepEqual(evaluateContext({ ...facts, language, declared: 70000, unmeasuredNote: 'probe.note.use_config' }).messageParams, { effective: '70,000', noteCode: 'provider.probe.note.use_config' });
    assert.deepEqual(evaluateContext({ ...facts, language, declared: 200000, modelMax: 131072 }).messageParams, { declared: '200,000', modelMax: '131,072' });
  }
});

test('プロバイダのエラー: 日本語の文は今までと同じで、コードと値を添え、英語では英語で書く', () => {
  const cases: Array<[ProviderError, string, string, string]> = [
    [classifyHttpFailure(401, 'bad key'), '認証に失敗しました（HTTP 401: bad key）', 'Authentication failed (HTTP 401: bad key)', 'http.auth'],
    [classifyHttpFailure(429, ''), '利用制限に達しました（HTTP 429）', 'The usage limit was reached (HTTP 429)', 'http.rate_limit'],
    [classifyHttpFailure(404, ''), 'モデルまたは API が見つかりません（HTTP 404）', 'The model or API was not found (HTTP 404)', 'http.not_found'],
    [classifyHttpFailure(503, 'down'), 'プロバイダ側のエラーです（HTTP 503: down）', 'The provider reported an error (HTTP 503: down)', 'http.server'],
    [classifyHttpFailure(400, ''), 'リクエストが拒否されました（HTTP 400）', 'The request was rejected (HTTP 400)', 'http.rejected'],
    [classifyHttpFailure(400, 'maximum context length exceeded'), '入力がモデルのコンテキスト長を超えました（HTTP 400: maximum context length exceeded）', 'The input exceeded the context length of the model (HTTP 400: maximum context length exceeded)', 'http.context_overflow'],
    [classifyFetchError(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }), new AbortController().signal), 'プロバイダに接続できません（ECONNREFUSED）', 'Cannot connect to the provider (ECONNREFUSED)', 'connect.code'],
    [classifyFetchError(new Error('x'), new AbortController().signal), 'プロバイダに接続できません', 'Cannot connect to the provider', 'connect'],
  ];
  for (const [error, ja, en, code] of cases) {
    assert.equal(error.message, ja);
    assert.equal(error.text('ja'), ja);
    assert.equal(error.text('en'), en);
    assert.equal(error.code, code);
  }
  assert.deepEqual(cases[0]![0].params, { status: 401, suffix: ': bad key' });
  assert.throws(() => requireApiKey(compatProvider('http://127.0.0.1:1/v1', { apiKeyEnv: 'NOPE_KEY' }), {}), (e: unknown) => {
    const error = e as ProviderError;
    return error.message === '環境変数 NOPE_KEY に API キーが設定されていません（.env か OS の環境変数に書いてください）'
      && error.text('en') === 'The API key is not set in the environment variable NOPE_KEY (put it in .env or in the OS environment variables)' && error.code === 'key.missing';
  });
  for (const kind of ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'tabbyapi', 'generic', 'hosted'] as const) noJapanese(`hint ${kind}`, contextHint('en', kind, 65536));
});

test('モデルの確認（英語）: 接続先ごとの message / hint / code', async t => {
  const tabby = await fakeServer((_req, _body, res) => { res.writeHead(200); res.end(JSON.stringify({ id: 'other-model', parameters: { max_seq_len: 4096 } })); });
  const vllm = await fakeServer((_req, _body, res) => { res.writeHead(200); res.end(JSON.stringify({ data: [{ id: 'another' }] })); });
  const small = await fakeServer((_req, _body, res) => { res.writeHead(200); res.end(JSON.stringify({ default_generation_settings: { n_ctx: 2048 } })); });
  const gone = await fakeServer((_req, _body, res) => { res.writeHead(404); res.end('{}'); });
  t.after(async () => { for (const s of [tabby, vllm, small, gone]) await s.close(); });

  const tabbyResult = await new OpenAiCompatibleAdapter(compatProvider(`${tabby.url}/v1`, { server: 'tabbyapi' }), {}).probe(probeModel(), 65536, 'en');
  assert.equal(tabbyResult.status, 'not_found');
  assert.equal(tabbyResult.message, 'TabbyAPI has "other-model" loaded, not "test-model"');
  assert.equal(tabbyResult.hint, 'Load the model you want in TabbyAPI, or make models[].model match');
  assert.equal(tabbyResult.messageCode, 'provider.probe.tabby_other');
  assert.deepEqual(tabbyResult.messageParams, { current: 'other-model', model: 'test-model' });
  const tabbyJa = await new OpenAiCompatibleAdapter(compatProvider(`${tabby.url}/v1`, { server: 'tabbyapi' }), {}).probe(probeModel(), 65536);
  assert.equal(tabbyJa.message, 'TabbyAPI が読み込んでいるのは「other-model」で、「test-model」ではありません');
  assert.equal(tabbyJa.hint, 'TabbyAPI で目的のモデルを読み込むか、models[].model を合わせてください');

  const vllmResult = await new OpenAiCompatibleAdapter(compatProvider(`${vllm.url}/v1`, { server: 'vllm' }), {}).probe(probeModel(), 65536, 'en');
  assert.equal(vllmResult.message, 'vLLM does not have the model "test-model"');

  const tooSmall = await new OpenAiCompatibleAdapter(compatProvider(`${small.url}/v1`, { server: 'llamacpp' }), {}).probe(probeModel(), 65536, 'en');
  assert.equal(tooSmall.status, 'too_small');
  assert.equal(tooSmall.message, 'The context length is too small: measured 2,048 < required 65,536 (measured 2,048)');
  assert.equal(tooSmall.messageCode, 'provider.probe.too_small');
  assert.deepEqual(tooSmall.messageParams, { effective: '2,048', required: '65,536', sourceKind: 'measured', n: '2,048' }, 'messageParams hold a sub-code, not language-written text');
  assert.equal(tooSmall.hint, 'Start llama-server with -c so that each slot has 65,536 or more (raising the slots with -np splits -c)');

  const missing = await new OllamaAdapter({ id: 'p', kind: 'ollama', baseUrl: gone.url, maxParallel: 1, timeoutMs: 10_000 }, {}).probe(probeModel(), 65536, 'en');
  assert.equal(missing.status, 'not_found');
  assert.equal(missing.message, 'Ollama does not have the model "test-model" (fetch it with: ollama pull test-model)');
  const unreachable = await new OllamaAdapter({ id: 'p', kind: 'ollama', baseUrl: 'http://127.0.0.1:9', maxParallel: 1, timeoutMs: 10_000 }, {}).probe(probeModel(), 65536, 'en');
  assert.equal(unreachable.status, 'unreachable');
  assert.equal(unreachable.message, 'Cannot connect to Ollama (http://127.0.0.1:9). Check that it is running');
  const noKey = await new OpenAiCompatibleAdapter(compatProvider('http://127.0.0.1:9/v1', { apiKeyEnv: 'NOPE_KEY' }), {}).probe(probeModel(), 65536, 'en');
  assert.equal(noKey.status, 'no_api_key');
  assert.equal(noKey.message, 'The API key is not set in the environment variable NOPE_KEY (put it in .env or in the OS environment variables)');
  assert.equal(noKey.messageCode, 'provider.key.missing');
  for (const r of [tabbyResult, vllmResult, tooSmall, missing, unreachable, noKey]) { noJapanese('probe message', r.message); noJapanese('probe hint', r.hint); }
});

test('モデルの確認: 設定の language がアダプタの確認まで届き、設定を保存するたびに新しい言語で確認し直す', async t => {
  const s = await startApp(t, { language: 'en' });
  assert.deepEqual(s.adapter().probeLanguages, ['en']);
  await s.app.applyConfig({ ...s.app.config(), language: 'ja' });
  assert.deepEqual(s.adapter().probeLanguages, ['ja']);
});

// ── エンジンの失敗・警告 ──

function collect(app: App): RunEvent[] {
  const events: RunEvent[] = [];
  app.bus.subscribe(e => events.push(e.event));
  return events;
}

test('エンジンの失敗と警告（英語）: 文は英語で、コードと値を添え、日本語は今までのまま', async t => {
  for (const language of ['ja', 'en'] as const) {
    const s = await startApp(t, { language, edit: c => { c.routing.retriesPerModel = 1; c.tools.maxIterations = 1; } });
    const events = collect(s.app);
    const pick = <T>(ja: T, en: T): T => (language === 'ja' ? ja : en);
    const send = async (id: string, text: string) => {
      const outcome = s.app.engine.send(id, text);
      assert.ok(outcome.ok);
      return s.app.engine.wait(outcome.runId)!;
    };

    // 再試行 → 失敗
    const down = () => fail(providerError('provider_error', 'http.server', { status: 503, suffix: '' }, { retryable: true, status: 503, retryAfterMs: 1 }));
    s.adapter().scripts.push(down(), down());
    const failed = await send('c1', 'hi');
    assert.ok(!failed.ok);
    const retrying = events.find(e => e.type === 'warning' && e.code === 'retrying') as Extract<RunEvent, { type: 'warning' }>;
    assert.equal(retrying.message, pick('プロバイダ側のエラーです（HTTP 503）。1 秒後に再試行します（1/1）', 'The provider reported an error (HTTP 503). Retrying in 1 s (1/1)'));
    assert.deepEqual(retrying.params, { seconds: 1, attempt: 1, retries: 1, errorCode: 'provider.http.server', errorParams: { status: 503, suffix: '' } }, 'language-written text is not in params');
    const end = events.findLast(e => e.type === 'run.end') as Extract<RunEvent, { type: 'run.end' }>;
    assert.equal(end.errorKind, 'provider_error');
    assert.equal(end.errorMessage, pick('プロバイダ側のエラーです（HTTP 503）', 'The provider reported an error (HTTP 503)'));
    assert.equal(end.errorCode, 'provider.http.server');
    assert.deepEqual(end.errorParams, { status: 503, suffix: '' });
    if (!failed.ok) assert.equal(failed.errorCode, 'provider.http.server');

    // 途中まで書いて失敗
    s.adapter().scripts.push(fail(providerError('provider_error', 'http.rejected', { status: 400, suffix: '' }, { retryable: false }), 'partial text'));
    await send('c2', 'hi');
    const discarded = events.find(e => e.type === 'warning' && e.code === 'partial_discarded') as Extract<RunEvent, { type: 'warning' }>;
    assert.equal(discarded.message, pick('返事の途中で失敗したため、途中までの内容は保存しませんでした', 'The reply failed partway, so the part written so far was not saved'));

    // ツールの呼び直しが上限
    s.adapter().scripts.push(toolCall('task_list', {}));
    await send('c3', 'hi');
    const limit = events.find(e => e.type === 'warning' && e.code === 'max_iterations') as Extract<RunEvent, { type: 'warning' }>;
    assert.equal(limit.message, pick('ツールを使った呼び直しが上限（1 回）に達したため止めました。続けるなら「続けて」と送ってください', 'Stopped because the tool-calling loop reached its limit of 1. Send "continue" if you want it to keep going'));
    assert.deepEqual(limit.params, { max: 1 });

    // 止められた返事（途中まで保存される）
    s.adapter().scripts.push(hang());
    const outcome = s.app.engine.send('c4', 'hi');
    assert.ok(outcome.ok);
    await waitFor(() => s.adapter().calls.length >= 4, 'hang starts');
    await new Promise(r => setTimeout(r, 30));
    s.app.engine.stop(outcome.runId);
    const cancelled = await s.app.engine.wait(outcome.runId);
    assert.ok(cancelled && !cancelled.ok);
    if (cancelled && !cancelled.ok) { assert.equal(cancelled.errorMessage, pick('中止しました', 'Stopped')); assert.equal(cancelled.errorCode, 'provider.cancelled'); }
    assert.equal(s.app.conversations.messages('c4').at(-1)!.text, `working…\n\n${pick('（途中で止めました）', '(stopped partway)')}`);

    // 忙しい・やり直す発言が無い
    s.adapter().scripts.push(hang());
    const running = s.app.engine.send('c5', 'hi');
    assert.ok(running.ok);
    const busy = s.app.engine.send('c5', 'again');
    assert.ok(!busy.ok);
    if (!busy.ok) {
      assert.equal(busy.errorMessage, pick('この会話はまだ返事を作っています。止めるか、終わるまで待ってください', 'This conversation is still writing a reply. Stop it or wait until it finishes'));
      assert.equal(busy.errorCode, 'engine.send.busy_chat');
    }
    s.app.engine.stop(running.runId);
    await s.app.engine.wait(running.runId);
    const nothing = s.app.engine.retry('c-none');
    assert.ok(!nothing.ok);
    if (!nothing.ok) assert.equal(nothing.errorCode, 'engine.send.nothing_to_retry');
  }
});

test('エンジンの失敗（英語）: 使えるモデルが無い・ツールを正しく呼べない・内部エラー', async t => {
  const s = await startApp(t, { language: 'en' });
  s.adapter().probeResult = { status: 'too_small', message: 'x' };
  await s.app.status.probeAll(s.app.config());
  const blocked = s.app.engine.send('c1', 'hi');
  assert.ok(!blocked.ok);
  if (!blocked.ok) {
    assert.equal(blocked.errorCode, 'engine.no_usable');
    assert.match(blocked.errorMessage, /^Nothing was sent because there is no model that can be used\. Check the settings screen\.\n- m: x$/u);
    noJapanese('no usable model', blocked.errorMessage);
  }
  s.adapter().probeResult = {};
  await s.app.status.probeAll(s.app.config());

  const events = collect(s.app);
  for (let i = 0; i < 3; i++) s.adapter().scripts.push(toolCall('no_such_tool', {}));
  const outcome = s.app.engine.send('c2', 'hi');
  assert.ok(outcome.ok);
  const result = await s.app.engine.wait(outcome.runId)!;
  assert.ok(result && !result.ok);
  if (result && !result.ok) {
    assert.equal(result.errorMessage, 'The model could not call tools in a valid form (3 times in a row). Switch to a model that handles tools well, or set toolMode to json_fallback');
    assert.equal(result.errorCode, 'engine.tool.invalid_streak');
    assert.equal(result.detail?.hint, 'Set models[].toolMode to json_fallback, or reduce the number of tools with maxTools');
  }
  const toolResults = events.filter(e => e.type === 'tool.result');
  assert.ok(toolResults.length >= 1);
});

// ── API のエラー ──

async function serve(t: { after: (fn: () => void | Promise<void>) => void }, language: Language) {
  const s = await startApp(t, { language });
  const web = createWebServer(s.app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); });
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  const api = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, { ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Origin: origin, ...init.headers } });
  const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });
  return { ...s, api, post, origin };
}

const SHAPES = 'pebble / triangle / diamond / bean / cloud / droplet / heart / star / crescent / capsule / square / puddle / ghost / bunny / cat / bear / mushroom / bell / peanut / comet';

for (const language of ['ja', 'en'] as const) {
  test(`API のエラー（${language}）: 今までの error / field に code と params を添え、message は language で書く`, async t => {
    const s = await serve(t, language);
    const pick = <T>(ja: T, en: T): T => (language === 'ja' ? ja : en);
    const expectProblem = async (res: Response, status: number, expected: { error: string; code: string; message: [string, string]; field?: string; params?: Record<string, unknown> }) => {
      assert.equal(res.status, status);
      const body = await res.json() as any;
      assert.equal(body.error, expected.error);
      assert.equal(body.code, expected.code);
      assert.equal(body.message, pick(...expected.message));
      assert.equal(body.field, expected.field);
      assert.deepEqual(body.params, expected.params);
    };

    await expectProblem(await s.post('/api/conversations/c1/messages', {}), 400, { error: 'invalid_field', code: 'http.required', field: 'text', params: { field: 'text' }, message: ['text を入力してください', 'Enter text'] });
    await expectProblem(await s.post('/api/conversations/c1/messages', { text: 'x'.repeat(100_001) }), 400, { error: 'invalid_field', code: 'http.too_long', field: 'text', params: { field: 'text', max: 100000 }, message: ['text が長すぎます（上限 100000 文字）', 'text is too long (limit 100000 characters)'] });
    await expectProblem(await s.api('/api/conversations/c1/messages', { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } }), 400, { error: 'invalid_json', code: 'http.invalid_json', message: ['JSON として読めません', 'This could not be read as JSON'] });
    await expectProblem(await s.api('/api/conversations/c1/messages', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } }), 415, { error: 'unsupported_media_type', code: 'http.unsupported_media_type', message: ['Content-Type は application/json にしてください', 'Set Content-Type to application/json'] });
    await expectProblem(await s.api('/api/conversations/nope/messages'), 404, { error: 'not_found', code: 'http.conversation_missing', message: ['会話がありません', 'The conversation was not found'] });
    await expectProblem(await s.api('/api/tasks/nope'), 404, { error: 'not_found', code: 'http.task_missing', message: ['タスクがありません', 'The task was not found'] });
    await expectProblem(await s.post('/api/tasks', { title: 'x', priority: 9 }), 400, { error: 'invalid_field', code: 'http.bad_priority', field: 'priority', message: ['priority は 1（高）・2・3（低）のどれかにしてください', 'priority must be 1 (high), 2 or 3 (low)'] });
    await expectProblem(await s.post('/api/tasks', { title: 'x', when: 'tomorrow' }), 400, { error: 'invalid_field', code: 'http.bad_when', field: 'when', message: ['when は日時（例: 2026-11-06T09:00:00+09:00）にしてください', '"when" must be a date and time (example: 2026-11-06T09:00:00+09:00)'] });
    await expectProblem(await s.api('/api/profile', { method: 'PATCH', body: JSON.stringify({ shape: 'nope' }) }), 400, { error: 'invalid_field', code: 'http.bad_enum', field: 'shape', params: { field: 'shape', values: SHAPES }, message: [`shape は ${SHAPES} のどれかにしてください`, `shape must be one of ${SHAPES}`] });
    await expectProblem(await s.post('/api/memories', { book: 'x', content: 'a' }), 400, { error: 'invalid_field', code: 'http.bad_book', field: 'book', message: ['book は user か notes にしてください', 'book must be user or notes'] });
    await expectProblem(await s.post('/api/approvals/none', { decision: 'maybe' }), 400, { error: 'invalid_field', code: 'http.bad_enum', field: 'decision', params: { field: 'decision', values: 'once / conversation / deny' }, message: ['decision は once / conversation / deny のどれかにしてください', 'decision must be one of once / conversation / deny'] });
    await expectProblem(await s.post('/api/approvals/none', { decision: 'once' }), 404, { error: 'not_found', code: 'http.approval_gone', message: ['この承認は既に終わっています（時間切れか、中止された可能性があります）', 'This approval has already ended (it may have timed out or been cancelled)'] });
    await expectProblem(await s.api('/api/templates/fr'), 404, { error: 'not_found', code: 'http.unknown_language', params: { language: 'fr', values: 'ja / en' }, message: ['言語「fr」の初期値はありません（ja / en）', 'There are no defaults for the language "fr" (ja / en)'] });
    await expectProblem(await s.post('/api/worker', { paused: 'yes' }), 400, { error: 'invalid_field', code: 'http.bad_bool', field: 'paused', params: { field: 'paused' }, message: ['paused は true / false にしてください', 'paused must be true or false'] });

    await expectProblem(await s.post('/api/memories', { book: 'user', content: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }), 400, { error: 'memory', code: 'store.memory.secret', message: ['API キーやトークンらしい文字列を含む内容は記憶しません', 'Content that contains what looks like an API key or token is not remembered'] });
    await expectProblem(await s.api('/api/memories/999', { method: 'PATCH', body: JSON.stringify({ content: 'x' }) }), 400, { error: 'memory', code: 'store.memory.not_found', params: { id: 999 }, message: ['記憶 999 がありません', 'Memory 999 was not found'] });
    assert.equal((await s.post('/api/curiosity', { topic: 'Tea' })).status, 201);
    await expectProblem(await s.post('/api/curiosity', { topic: 'Tea' }), 400, { error: 'invalid', code: 'store.curiosity.duplicate', params: { id: 1 }, message: ['同じものが既にあります（#1）', 'The same item already exists (#1)'] });
    await expectProblem(await s.api('/api/uploads?name=a.txt', { method: 'POST', body: Buffer.alloc(0), headers: { 'Content-Type': 'text/plain' } }), 400, { error: 'upload', code: 'store.upload.empty', message: ['空のファイルです', 'The file is empty'] });

    s.app.reviews.enqueue('manual', 'manual:x', {});
    const reviews = await (await s.api('/api/reviews')).json() as any;
    assert.equal(reviews.jobs[0].trigger, 'manual');
    assert.equal(reviews.jobs[0].triggerLabel, pick('手動', 'Manual'));
  });
}

test('API: 添付だけの発言の目印と、記憶の削除の理由は設定の言語で書く', async t => {
  for (const language of ['ja', 'en'] as const) {
    const s = await serve(t, language);
    const pick = <T>(ja: T, en: T): T => (language === 'ja' ? ja : en);
    const uploaded = await (await s.api('/api/uploads?name=a.txt', { method: 'POST', body: 'file body', headers: { 'Content-Type': 'text/plain' } })).json() as any;
    s.adapter().scripts.push(reply('ok'));
    const sent = await s.post('/api/conversations/c1/messages', { text: '', attachments: [uploaded.upload.id] });
    assert.equal(sent.status, 202);
    await s.app.engine.wait(((await sent.json()) as any).runId);
    const stored = s.app.conversations.messages('c1')[0]!.message;
    assert.equal(stored.role, 'user');
    if (stored.role === 'user') {
      assert.ok(stored.content.startsWith(pick('（ファイルを添付しました）\n\n<<<添付ファイル: a.txt（テキスト）>>>', '(A file was attached)\n\n<<<Attachment: a.txt（text）>>>')), stored.content);
      assert.ok(stored.content.endsWith(pick('<<<添付ファイルここまで>>>', '<<<End of attachment>>>')));
    }
    assert.equal(s.app.conversations.get('c1')!.title, 'a.txt', '添付の目印は題にしない');
    const history = await (await s.api('/api/conversations/c1/messages')).json() as any;
    assert.equal(history.messages[0].text, pick('（ファイルを添付しました）', '(A file was attached)'), '画面には囲みの中身を出さない');

    const memory = await (await s.post('/api/memories', { book: 'user', content: 'tea' })).json() as any;
    const removed = await (await s.api(`/api/memories/${memory.memory.id}`, { method: 'DELETE' })).json() as any;
    const events = s.app.memory.events(memory.memory.id);
    assert.equal(events.find(e => e.id === removed.eventId)!.reason, pick('画面から削除', 'Deleted from the screen'));
  }
});

test('再起動で中断した実行の記録は、設定の言語で書く', async t => {
  for (const language of ['ja', 'en'] as const) {
    const dir = tempDir(t);
    const paths = resolvePaths(dir);
    mkdirSync(paths.data, { recursive: true });
    const config = testConfig();
    config.language = language;
    writeFileSync(paths.config, JSON.stringify(config));
    const first = new App({ paths, log: () => undefined, workerTimers: false, adapterOverride: p => new FakeAdapter(p) });
    first.runs.start('r1', 'chat', 'c1');
    first.close();
    const second = new App({ paths, log: () => undefined, workerTimers: false, adapterOverride: p => new FakeAdapter(p) });
    const row = second.runs.get('r1')!;
    assert.equal(row.error_kind, 'cancelled');
    assert.equal(row.error_message, language === 'ja' ? 'アプリの再起動で中断しました' : 'Interrupted by an app restart');
    second.close();
  }
});
