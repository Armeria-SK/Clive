import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import { AnthropicAdapter } from '../src/providers/anthropic.ts';
import { evaluateContext } from '../src/providers/context.ts';
import { checkBaseUrl, parseRetryAfter, readSseData } from '../src/providers/http.ts';
import { contextLengthFromShow, OllamaAdapter } from '../src/providers/ollama.ts';
import { OpenAiCompatibleAdapter } from '../src/providers/openai-compatible.ts';
import { ProviderError, type ModelRequest, type StreamEvent } from '../src/providers/types.ts';
import { fakeServer, sse } from './helpers.ts';

const model = (over: Partial<ModelConfig> = {}): ModelConfig => ({
  id: 'm', provider: 'p', model: 'test-model', contextLength: 65536, minContext: 65536, maxOutputTokens: 1024, toolMode: 'native', vision: false, ...over,
});
const request = (m: ModelConfig, over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: m, system: { frozen: 'あなたは Clive', dynamic: '現在時刻' }, messages: [{ role: 'user', content: 'こんにちは' }],
  tools: [], maxOutputTokens: 1024, signal: new AbortController().signal, ...over,
});
async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const text = (events: StreamEvent[]) => events.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('');
async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  try { await promise; } catch (error) { assert.ok(error instanceof ProviderError, String(error)); return error; }
  assert.fail('失敗するはず');
}

// ── 共通部品 ─────────────────────────────────────────────

test('Retry-After は秒と日付の両方を読む', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter(new Date(Date.now() + 5000).toUTCString(), Date.now()) !== undefined, true);
  assert.equal(parseRetryAfter('abc'), undefined);
});

test('API キーを使う接続に平文の http を許すのはこの PC だけ', () => {
  assert.ok('url' in checkBaseUrl('http://127.0.0.1:1234/v1/', true));
  assert.ok('problem' in checkBaseUrl('http://192.168.0.2:1234/v1', true));
  assert.ok('url' in checkBaseUrl('http://192.168.0.2:1234/v1', false));
  assert.ok('problem' in checkBaseUrl('https://user:pass@example.com', false));
});

test('SSE の data を CRLF や複数行でも読める', async () => {
  const body = new Response('data: a\r\ndata: b\r\n\r\n: comment\n\ndata: c\n\n').body!;
  const out: string[] = [];
  for await (const d of readSseData(body)) out.push(d);
  assert.deepEqual(out, ['a\nb', 'c']);
});

test('コンテキスト長の判定: 足りない・上限超え・不明・OK', () => {
  const small = evaluateContext({ modelId: 'm', server: 'x', required: 65536, declared: 65536, measured: 4096 });
  assert.equal(small.status, 'too_small');
  assert.match(small.message, /measured 4,096 < required 65,536/);
  assert.equal(evaluateContext({ modelId: 'm', server: 'x', required: 1000, declared: 70000, modelMax: 32768 }).status, 'exceeds_model');
  assert.equal(evaluateContext({ modelId: 'm', server: 'x', required: 1000 }).status, 'unknown');
  const ok = evaluateContext({ modelId: 'm', server: 'x', required: 1000, declared: 70000, measured: 65536, modelMax: 131072 });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.effective, 65536);
});

// ── OpenAI 互換 ───────────────────────────────────────────

const compat = (baseUrl: string, over: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: 'p', kind: 'openai_compatible', baseUrl, maxParallel: 1, timeoutMs: 10_000, ...over });

test('OpenAI 互換: 本文の差分・使用量・終了理由を読む', async t => {
  const server = await fakeServer((_req, _body, res) => sse(res, [
    { choices: [{ delta: { content: 'こん' } }] },
    { choices: [{ delta: { content: 'にちは' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 42, completion_tokens: 3 } },
  ]));
  t.after(() => server.close());
  const events = await collect(new OpenAiCompatibleAdapter(compat(`${server.url}/v1`), {}).stream(request(model())));
  assert.equal(text(events), 'こんにちは');
  assert.deepEqual(events.find(e => e.type === 'usage'), { type: 'usage', usage: { inputTokens: 42, outputTokens: 3 } });
  assert.deepEqual(events.at(-1), { type: 'done', stop: 'end_turn' });
  const sent = server.requests[0]!;
  assert.equal(sent.path, '/v1/chat/completions');
  assert.equal(sent.body.messages[0].role, 'system');
  assert.equal(sent.body.stream_options.include_usage, true);
});

test('OpenAI 互換: 断片で届くツール呼び出しを組み立てる', async t => {
  const server = await fakeServer((_req, _body, res) => sse(res, [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'memory_save', arguments: '{"bo' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'dy":"x"}' } }] }, finish_reason: 'tool_calls' }] },
  ]));
  t.after(() => server.close());
  const events = await collect(new OpenAiCompatibleAdapter(compat(server.url), {}).stream(request(model())));
  const call = events.find(e => e.type === 'tool_call');
  assert.deepEqual(call, { type: 'tool_call', call: { id: 'call_1', name: 'memory_save', arguments: { body: 'x' }, raw: '{"body":"x"}' } });
  assert.deepEqual(events.at(-1), { type: 'done', stop: 'tool_use' });
});

test('OpenAI 互換: HTTP の失敗を分類する', async t => {
  const responses: Array<[number, Record<string, string>, string]> = [
    [429, { 'retry-after': '7' }, '{"error":{"message":"slow down"}}'],
    [400, {}, '{"error":{"message":"This model\'s maximum context length is 4096 tokens"}}'],
    [401, {}, '{"error":"bad key"}'],
    [503, {}, 'busy'],
  ];
  const server = await fakeServer((_req, _body, res) => {
    const [status, headers, body] = responses.shift()!;
    res.writeHead(status, headers); res.end(body);
  });
  t.after(() => server.close());
  const adapter = new OpenAiCompatibleAdapter(compat(server.url), {});
  const rate = await rejection(collect(adapter.stream(request(model()))));
  assert.equal(rate.kind, 'rate_limit'); assert.equal(rate.retryAfterMs, 7000); assert.equal(rate.retryable, true);
  const ctx = await rejection(collect(adapter.stream(request(model()))));
  assert.equal(ctx.kind, 'context_overflow'); assert.equal(ctx.retryable, false);
  const auth = await rejection(collect(adapter.stream(request(model()))));
  assert.equal(auth.kind, 'auth');
  const busy = await rejection(collect(adapter.stream(request(model()))));
  assert.equal(busy.kind, 'provider_error'); assert.equal(busy.retryable, true);
});

test('OpenAI 互換: 環境変数にキーが無ければ送る前に止める', async () => {
  const adapter = new OpenAiCompatibleAdapter(compat('https://example.invalid/v1', { apiKeyEnv: 'MISSING_KEY' }), {});
  const error = await rejection(collect(adapter.stream(request(model()))));
  assert.equal(error.kind, 'auth');
  assert.match(error.message, /MISSING_KEY/);
});

test('OpenAI 互換: キーは Authorization ヘッダで送る', async t => {
  const server = await fakeServer((_req, _body, res) => sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
  t.after(() => server.close());
  await collect(new OpenAiCompatibleAdapter(compat(server.url, { apiKeyEnv: 'K' }), { K: 'secret-123' }).stream(request(model())));
  assert.equal(server.requests[0]!.headers.authorization, 'Bearer secret-123');
});

test('probe: LM Studio で読み込み時の長さが足りなければ too_small', async t => {
  const server = await fakeServer((req, _body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // 長さは /api/v0/models/<モデル> から読む。/v1/models は考える深さ（efforts）を読むためだけに見る（無い返事でも長さの判定は変わらない）
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [] })); return; }
    assert.equal(req.url, '/api/v0/models/test-model');
    res.end(JSON.stringify({ id: 'test-model', state: 'loaded', max_context_length: 131072, loaded_context_length: 4096 }));
  });
  t.after(() => server.close());
  const result = await new OpenAiCompatibleAdapter(compat(`${server.url}/v1`, { server: 'lmstudio' }), {}).probe(model(), 65536);
  assert.equal(result.status, 'too_small');
  assert.equal(result.efforts, undefined);
  assert.equal(result.measured, 4096);
  assert.match(result.hint ?? '', /Context Length/);
});

test('probe: llama.cpp の /props と vLLM の max_model_len', async t => {
  const llama = await fakeServer((_req, _body, res) => { res.writeHead(200); res.end(JSON.stringify({ default_generation_settings: { n_ctx: 32768 } })); });
  const vllm = await fakeServer((_req, _body, res) => { res.writeHead(200); res.end(JSON.stringify({ data: [{ id: 'test-model', max_model_len: 131072 }] })); });
  t.after(async () => { await llama.close(); await vllm.close(); });
  const l = await new OpenAiCompatibleAdapter(compat(`${llama.url}/v1`, { server: 'llamacpp' }), {}).probe(model(), 65536);
  assert.equal(l.status, 'too_small'); assert.equal(l.measured, 32768);
  const v = await new OpenAiCompatibleAdapter(compat(`${vllm.url}/v1`, { server: 'vllm' }), {}).probe(model(), 65536);
  assert.equal(v.status, 'ok'); assert.equal(v.effective, 65536);
});

test('probe: 長さを返さないサーバーは設定値を使い、設定も無ければ unknown', async t => {
  const server = await fakeServer((_req, _body, res) => { res.writeHead(200); res.end(JSON.stringify({ data: [{ id: 'test-model' }] })); });
  t.after(() => server.close());
  const adapter = new OpenAiCompatibleAdapter(compat(`${server.url}/v1`), {});
  assert.equal((await adapter.probe(model(), 65536)).status, 'ok');
  const { contextLength: _omit, ...noLength } = model();
  assert.equal((await adapter.probe(noLength as ModelConfig, 65536)).status, 'unknown');
});

test('probe: 接続できなければ unreachable', async () => {
  const result = await new OpenAiCompatibleAdapter(compat('http://127.0.0.1:9/v1'), {}).probe(model(), 1024);
  assert.equal(result.status, 'unreachable');
});

// ── Ollama ────────────────────────────────────────────────

const ollama = (baseUrl: string): ProviderConfig => ({ id: 'p', kind: 'ollama', baseUrl, maxParallel: 1, timeoutMs: 10_000 });

test('Ollama: num_ctx を毎回送り、NDJSON を読む', async t => {
  const server = await fakeServer((_req, _body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'やあ' }, done: false })}\n`);
    res.write(`${JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'task_list', arguments: { status: 'ready' } } }] }, done: false })}\n`);
    res.end(`${JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 120, eval_count: 9 })}\n`);
  });
  t.after(() => server.close());
  const events = await collect(new OllamaAdapter(ollama(server.url), {}).stream(request(model({ contextLength: 65536 }))));
  assert.equal(server.requests[0]!.body.options.num_ctx, 65536);
  assert.equal(server.requests[0]!.body.options.num_predict, 1024);
  assert.equal(text(events), 'やあ');
  const call = events.find(e => e.type === 'tool_call') as Extract<StreamEvent, { type: 'tool_call' }>;
  assert.equal(call.call.name, 'task_list');
  assert.deepEqual(call.call.arguments, { status: 'ready' });
  assert.deepEqual(events.find(e => e.type === 'usage'), { type: 'usage', usage: { inputTokens: 120, outputTokens: 9 } });
  assert.deepEqual(events.at(-1), { type: 'done', stop: 'tool_use' });
});

test('Ollama: model_info から上限を読み、設定が上限を超えれば exceeds_model', async t => {
  const server = await fakeServer((_req, body, res) => {
    if (body.model === 'missing') { res.writeHead(404); res.end('{"error":"model not found"}'); return; }
    res.writeHead(200); res.end(JSON.stringify({ model_info: { 'qwen3.context_length': 32768 }, capabilities: ['completion', 'tools'] }));
  });
  t.after(() => server.close());
  const adapter = new OllamaAdapter(ollama(server.url), {});
  const over = await adapter.probe(model({ contextLength: 65536 }), 65536);
  assert.equal(over.status, 'exceeds_model');
  assert.equal(over.modelMax, 32768);
  const small = await adapter.probe(model({ contextLength: 8192, minContext: 1024 }), 65536);
  assert.equal(small.status, 'too_small');
  assert.deepEqual(small.capabilities, ['completion', 'tools']);
  const ok = await adapter.probe(model({ contextLength: 32768, minContext: 1024 }), 16384);
  assert.equal(ok.status, 'ok');
  assert.equal((await adapter.probe(model({ model: 'missing' }), 1024)).status, 'not_found');
  assert.equal(contextLengthFromShow({ model_info: { 'llama.context_length': 8192 } }), 8192);
});

test('Ollama: 起動していなければ unreachable', async () => {
  const result = await new OllamaAdapter(ollama('http://127.0.0.1:9'), {}).probe(model(), 1024);
  assert.equal(result.status, 'unreachable');
  assert.match(result.message, /起動/);
});

// ── Anthropic ─────────────────────────────────────────────

function anthropicSse(events: Array<{ type: string } & Record<string, unknown>>): Response {
  const body = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' } });
}
const anthropicProvider: ProviderConfig = { id: 'p', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 1, timeoutMs: 10_000 };

test('Anthropic: 本文・ツール呼び出し・キャッシュを含む使用量を読み、system にキャッシュの区切りを付ける', async () => {
  let sentBody: any;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body));
    return anthropicSse([
      { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'はい' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'memory_save', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"body":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"y"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ]);
  }) as typeof fetch;
  const adapter = new AnthropicAdapter(anthropicProvider, { ANTHROPIC_API_KEY: 'sk-ant-test' }, fetchImpl);
  const events = await collect(adapter.stream(request(model({ contextLength: undefined } as unknown as Partial<ModelConfig>))));
  assert.equal(text(events), 'はい');
  assert.deepEqual((events.find(e => e.type === 'tool_call') as any).call, { id: 'tu_1', name: 'memory_save', arguments: { body: 'y' }, raw: '{"body":"y"}' });
  assert.deepEqual(events.find(e => e.type === 'usage'), { type: 'usage', usage: { inputTokens: 910, cacheReadTokens: 900, cacheWriteTokens: 0 } });
  assert.deepEqual(events.at(-1), { type: 'done', stop: 'tool_use' });
  assert.deepEqual(sentBody.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(sentBody.system[1].cache_control, undefined);
  assert.deepEqual(sentBody.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' });
});

test('Anthropic: 429 は rate_limit、529 は再試行できる provider_error', async () => {
  const replies = [
    new Response('{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}', { status: 429, headers: { 'retry-after': '2', 'content-type': 'application/json' } }),
    new Response('{"type":"error","error":{"type":"overloaded_error","message":"busy"}}', { status: 529, headers: { 'content-type': 'application/json' } }),
  ];
  const fetchImpl = (async () => replies.shift()!) as unknown as typeof fetch;
  const adapter = new AnthropicAdapter(anthropicProvider, { ANTHROPIC_API_KEY: 'k' }, fetchImpl);
  const rate = await rejection(collect(adapter.stream(request(model()))));
  assert.equal(rate.kind, 'rate_limit'); assert.equal(rate.retryAfterMs, 2000);
  const busy = await rejection(collect(adapter.stream(request(model()))));
  assert.equal(busy.kind, 'provider_error'); assert.equal(busy.retryable, true);
});

test('Anthropic: probe は max_input_tokens を上限として使う', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ id: 'claude-x', type: 'model', display_name: 'x', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 200000, max_tokens: 64000 }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const result = await new AnthropicAdapter(anthropicProvider, { ANTHROPIC_API_KEY: 'k' }, fetchImpl).probe(model({ contextLength: undefined } as unknown as Partial<ModelConfig>), 65536);
  assert.equal(result.status, 'ok');
  assert.equal(result.effective, 200000);
});

test('Anthropic: キーが無ければ no_api_key', async () => {
  const result = await new AnthropicAdapter(anthropicProvider, {}).probe(model(), 1024);
  assert.equal(result.status, 'no_api_key');
});
