import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_LANGUAGE, type Language, type ModelConfig, type ProviderConfig } from '../config/schema.ts';
import type { ChatMessage, StopReason } from '../engine/types.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { contextHint, errorProbeText, evaluateContext } from './context.ts';
import { classifyHttpFailure, parseRetryAfter, requireApiKey } from './http.ts';
import { ProviderError, providerError, type Env, type FetchLike, type ModelRequest, type ProbeResult, type ProviderAdapter, type StreamEvent } from './types.ts';

type Block = Anthropic.ContentBlockParam;
const EPHEMERAL = { type: 'ephemeral' } as const;

export function toAnthropicMessages(messages: readonly ChatMessage[], vision: boolean): Anthropic.MessageParam[] {
  const out: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      const blocks: Block[] = [];
      if (vision) for (const img of m.images ?? []) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType as 'image/png', data: img.data } });
      }
      blocks.push({ type: 'text', text: m.content || '（空のメッセージ）' });
      push('user', blocks);
    } else if (m.role === 'assistant') {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls ?? []) {
        const input = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments as Record<string, unknown> : {};
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input });
      }
      push('assistant', blocks.length ? blocks : [{ type: 'text', text: '（空の応答）' }]);
    } else {
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) }]);
    }
  }
  // 会話の末尾にキャッシュの区切りを置き、次のターンで前半を再利用できるようにする
  const lastBlock = out.at(-1)?.content.at(-1);
  if (lastBlock && lastBlock.type !== 'thinking' && lastBlock.type !== 'redacted_thinking') {
    (lastBlock as { cache_control?: typeof EPHEMERAL }).cache_control = EPHEMERAL;
  }
  return out;
}

function mapStop(reason: string | null | undefined): StopReason {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'end_turn';
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'max_tokens';
  return 'other';
}

export function classifyAnthropicError(error: unknown, signal: AbortSignal): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Anthropic.APIUserAbortError || signal.aborted) return providerError('cancelled', 'cancelled', {}, { retryable: false });
  if (error instanceof Anthropic.APIConnectionTimeoutError) return providerError('timeout', 'anthropic.timeout');
  if (error instanceof Anthropic.APIConnectionError) return providerError('provider_error', 'anthropic.connect', {}, { retryable: true });
  if (error instanceof Anthropic.APIError && typeof error.status === 'number') {
    const body = error.error as { error?: { type?: string; message?: string } } | undefined;
    const message = body?.error?.message ?? error.message ?? '';
    if (error.status === 529 || body?.error?.type === 'overloaded_error') {
      const retryAfterMs = parseRetryAfter(error.headers?.get('retry-after'));
      return providerError('provider_error', 'anthropic.busy', {}, { retryable: true, status: error.status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
    }
    return classifyHttpFailure(error.status, message, error.headers);
  }
  return providerError('internal', 'unexpected', { detail: redactSecrets(String((error as Error)?.message ?? error)).slice(0, 200) }, { retryable: false });
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider: ProviderConfig;
  readonly #env: Env;
  readonly #fetch: FetchLike | undefined;
  #client: Anthropic | undefined;
  #clientKey: string | undefined;
  constructor(provider: ProviderConfig, env: Env, fetchImpl?: FetchLike) {
    this.provider = provider; this.#env = env; this.#fetch = fetchImpl;
  }

  #clientFor(): Anthropic {
    const key = requireApiKey({ ...this.provider, apiKeyEnv: this.provider.apiKeyEnv ?? 'ANTHROPIC_API_KEY' }, this.#env);
    if (!this.#client || this.#clientKey !== key) {
      this.#client = new Anthropic({
        apiKey: key ?? null,
        maxRetries: 0, // 再試行はエンジン側で一本化する（試行回数を engine_runs に正しく残すため）
        timeout: this.provider.timeoutMs,
        ...(this.provider.baseUrl ? { baseURL: this.provider.baseUrl } : {}),
        ...(this.#fetch ? { fetch: this.#fetch } : {}),
      });
      this.#clientKey = key;
    }
    return this.#client;
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    let client: Anthropic;
    try { client = this.#clientFor(); } catch (error) { throw classifyAnthropicError(error, req.signal); }
    const system: Anthropic.TextBlockParam[] = [];
    if (req.system.frozen) system.push({ type: 'text', text: req.system.frozen, cache_control: EPHEMERAL });
    if (req.system.dynamic) system.push({ type: 'text', text: req.system.dynamic });
    const tools: Anthropic.Tool[] = req.tools.map((t, i, all) => ({
      name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      ...(i === all.length - 1 ? { cache_control: EPHEMERAL } : {}),
    }));
    const tooling: Record<string, { id: string; name: string; json: string }> = {};
    let stop: StopReason = 'other';
    try {
      const stream = await client.messages.create({
        model: req.model.model,
        max_tokens: req.maxOutputTokens,
        system,
        messages: toAnthropicMessages(req.messages, req.model.vision),
        ...(tools.length ? { tools } : {}),
        ...(req.model.temperature === undefined ? {} : { temperature: req.model.temperature }),
        stream: true,
      }, { signal: req.signal });
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            const u = event.message.usage;
            yield { type: 'usage', usage: {
              inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              ...(u.cache_read_input_tokens == null ? {} : { cacheReadTokens: u.cache_read_input_tokens }),
              ...(u.cache_creation_input_tokens == null ? {} : { cacheWriteTokens: u.cache_creation_input_tokens }),
            } };
            break;
          }
          case 'content_block_start':
            if (event.content_block.type === 'tool_use') tooling[event.index] = { id: event.content_block.id, name: event.content_block.name, json: '' };
            break;
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') yield { type: 'text', delta: event.delta.text };
            else if (event.delta.type === 'input_json_delta') { const t = tooling[event.index]; if (t) t.json += event.delta.partial_json; }
            else if (event.delta.type === 'thinking_delta') yield { type: 'reasoning', delta: event.delta.thinking };
            break;
          case 'content_block_stop': {
            const t = tooling[event.index];
            if (t) {
              let args: unknown;
              try { args = t.json.trim() ? JSON.parse(t.json) : {}; } catch { args = undefined; }
              yield { type: 'tool_call', call: { id: t.id, name: t.name, arguments: args, raw: t.json } };
              delete tooling[event.index];
            }
            break;
          }
          case 'message_delta':
            stop = mapStop(event.delta.stop_reason);
            if (typeof event.usage?.output_tokens === 'number') yield { type: 'usage', usage: { outputTokens: event.usage.output_tokens } };
            break;
          default: break;
        }
      }
    } catch (error) { throw classifyAnthropicError(error, req.signal); }
    yield { type: 'done', stop };
  }

  async probe(model: ModelConfig, required: number, language: Language = DEFAULT_LANGUAGE): Promise<ProbeResult> {
    const facts = { modelId: model.id, server: 'anthropic', required, declared: model.contextLength, language };
    try {
      const info = await this.#clientFor().models.retrieve(model.model, undefined, { timeout: 10_000 });
      const modelMax = typeof info.max_input_tokens === 'number' ? info.max_input_tokens : undefined;
      return evaluateContext({ ...facts, modelMax, hint: contextHint(language, 'hosted', required), unmeasuredNote: modelMax === undefined ? 'probe.note.max_unavailable' : undefined });
    } catch (error) {
      const e = classifyAnthropicError(error, new AbortController().signal);
      const status = e.kind === 'auth' ? 'no_api_key' : e.status === 404 ? 'not_found' : e.status === undefined ? 'unreachable' : 'error';
      return { ...facts, status, ...errorProbeText(e, language), checkedAt: Date.now() };
    }
  }
}
