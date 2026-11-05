import { randomUUID } from 'node:crypto';
import { DEFAULT_LANGUAGE, type Language, type ModelConfig, type ProviderConfig } from '../config/schema.ts';
import type { ChatMessage, StopReason, ToolCall } from '../engine/types.ts';
import { OLLAMA_DEFAULT_URL } from '../config/store.ts';
import { contextHint, errorProbeText, evaluateContext, probeText } from './context.ts';
import {
  checkBaseUrl, classifyFetchError, classifyHttpFailure, joinUrl, readLines, readSnippet, requireApiKey, withTimeout,
} from './http.ts';
import { ProviderError, providerError, type Env, type FetchLike, type ModelRequest, type ProbeResult, type ProviderAdapter, type StreamEvent } from './types.ts';

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  tool_name?: string;
};

export function toOllamaMessages(system: string, messages: readonly ChatMessage[], vision: boolean): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content, ...(vision && m.images?.length ? { images: m.images.map(i => i.data) } : {}) });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant', content: m.content,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ function: { name: c.name, arguments: c.arguments ?? {} } })) } : {}),
      });
    } else out.push({ role: 'tool', content: m.content, tool_name: m.name });
  }
  return out;
}

function mapDone(reason: unknown, hadTools: boolean): StopReason {
  if (hadTools) return 'tool_use';
  if (reason === 'stop') return 'end_turn';
  if (reason === 'length') return 'max_tokens';
  return 'other';
}

export function contextLengthFromShow(show: any): number | undefined {
  const info = show?.model_info;
  if (!info || typeof info !== 'object') return undefined;
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) return value;
  }
  return undefined;
}

export class OllamaAdapter implements ProviderAdapter {
  readonly provider: ProviderConfig;
  readonly #env: Env;
  readonly #fetch: FetchLike;
  constructor(provider: ProviderConfig, env: Env, fetchImpl: FetchLike = fetch) {
    this.provider = provider; this.#env = env; this.#fetch = fetchImpl;
  }

  #base(): string {
    const checked = checkBaseUrl(this.provider.baseUrl ?? OLLAMA_DEFAULT_URL, Boolean(this.provider.apiKeyEnv));
    if ('problem' in checked) throw new ProviderError('provider_error', `providers.${this.provider.id}.baseUrl: ${checked.problem}`, { retryable: false });
    return checked.url;
  }

  #headers(): Record<string, string> {
    const key = requireApiKey(this.provider, this.#env);
    return { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    if (req.model.contextLength === undefined) {
      throw providerError('context_overflow', 'ollama.context_unset', {}, { retryable: false, detail: { reason: 'context_unknown' } });
    }
    const base = this.#base();
    const headers = this.#headers();
    const system = [req.system.frozen, req.system.dynamic].filter(Boolean).join('\n\n');
    const body = {
      model: req.model.model,
      messages: toOllamaMessages(system, req.messages, req.model.vision),
      stream: true,
      // 既定の 4k に黙って切り捨てられないよう、設定したコンテキスト長を毎回送る
      options: {
        num_ctx: req.model.contextLength,
        num_predict: req.maxOutputTokens,
        ...(req.model.temperature === undefined ? {} : { temperature: req.model.temperature }),
      },
      ...(req.tools.length ? { tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
    };
    const { signal, timeout } = withTimeout(req.signal, this.provider.timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(joinUrl(base, 'api/chat'), { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
    } catch (error) { throw classifyFetchError(error, req.signal, timeout); }
    if (!response.ok || !response.body) throw classifyHttpFailure(response.status, await readSnippet(response), response.headers);

    const calls: ToolCall[] = [];
    let stop: StopReason = 'other';
    try {
      for await (const line of readLines(response.body)) {
        if (!line.trim()) continue;
        let chunk: any;
        try { chunk = JSON.parse(line); } catch { continue; }
        if (chunk?.error) throw classifyHttpFailure(500, String(chunk.error));
        const message = chunk?.message;
        if (typeof message?.thinking === 'string' && message.thinking) yield { type: 'reasoning', delta: message.thinking };
        if (typeof message?.content === 'string' && message.content) yield { type: 'text', delta: message.content };
        if (Array.isArray(message?.tool_calls)) {
          for (const c of message.tool_calls) {
            const name = c?.function?.name;
            if (typeof name !== 'string') continue;
            let args = c.function.arguments;
            let raw: string | undefined;
            if (typeof args === 'string') { raw = args; try { args = JSON.parse(args); } catch { args = undefined; } }
            calls.push({ id: typeof c.id === 'string' ? c.id : `call_${randomUUID()}`, name, arguments: args ?? {}, ...(raw === undefined ? {} : { raw }) });
          }
        }
        if (chunk?.done) {
          stop = mapDone(chunk.done_reason, calls.length > 0);
          yield { type: 'usage', usage: {
            ...(typeof chunk.prompt_eval_count === 'number' ? { inputTokens: chunk.prompt_eval_count } : {}),
            ...(typeof chunk.eval_count === 'number' ? { outputTokens: chunk.eval_count } : {}),
          } };
        }
      }
    } catch (error) { throw classifyFetchError(error, req.signal, timeout); }
    for (const call of calls) yield { type: 'tool_call', call };
    yield { type: 'done', stop };
  }

  async probe(model: ModelConfig, required: number, language: Language = DEFAULT_LANGUAGE): Promise<ProbeResult> {
    const facts = { modelId: model.id, server: 'ollama', required, declared: model.contextLength, language };
    let base: string; let headers: Record<string, string>;
    try { base = this.#base(); headers = this.#headers(); }
    catch (error) {
      const e = error as ProviderError;
      return { ...facts, status: e.kind === 'auth' ? 'no_api_key' : 'error', ...errorProbeText(e, language), checkedAt: Date.now() };
    }
    try {
      const response = await this.#fetch(joinUrl(base, 'api/show'), {
        method: 'POST', headers, body: JSON.stringify({ model: model.model }), signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      if (response.status === 404) {
        return { ...facts, status: 'not_found', ...probeText(language, 'probe.ollama_not_found', { model: model.model }), checkedAt: Date.now() };
      }
      if (!response.ok) throw classifyHttpFailure(response.status, await readSnippet(response));
      const show = await response.json() as any;
      const capabilities = Array.isArray(show?.capabilities) ? show.capabilities.filter((c: unknown) => typeof c === 'string') as string[] : undefined;
      if (model.contextLength === undefined) {
        return { ...facts, status: 'unknown', ...probeText(language, 'probe.ollama_unset'), hint: contextHint(language, 'ollama', required), checkedAt: Date.now(), ...(capabilities ? { capabilities } : {}) };
      }
      // num_ctx を毎回送るので、実際に使う長さ＝設定値（モデル上限を超えていなければ）
      return evaluateContext({
        ...facts, measured: model.contextLength, modelMax: contextLengthFromShow(show), capabilities,
        hint: contextHint(language, 'ollama', required),
      });
    } catch (error) {
      const e = error instanceof ProviderError ? error : classifyFetchError(error, new AbortController().signal);
      return { ...facts, status: e.status === undefined ? 'unreachable' : 'error', ...(e.status === undefined ? probeText(language, 'probe.ollama_unreachable', { base }) : errorProbeText(e, language)), checkedAt: Date.now() };
    }
  }
}
