import { randomUUID } from 'node:crypto';
import { DEFAULT_LANGUAGE, type Language, type ModelConfig, type ProviderConfig } from '../config/schema.ts';
import type { ChatMessage, StopReason, ToolCall } from '../engine/types.ts';
import { contextHint, errorProbeText, evaluateContext, probeText } from './context.ts';
import { providerText } from '../shared/messages/providers.ts';
import {
  checkBaseUrl, classifyFetchError, classifyHttpFailure, joinUrl, providerSecrets, readSnippet, readSseData, requireApiKey, withTimeout,
} from './http.ts';
import { ProviderError, type Env, type FetchLike, type ModelRequest, type ProbeResult, type ProviderAdapter, type StreamEvent } from './types.ts';

type OpenAiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

export function toOpenAiMessages(system: string, messages: readonly ChatMessage[], vision: boolean): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      if (vision && m.images?.length) {
        out.push({ role: 'user', content: [
          ...m.images.map(img => ({ type: 'image_url' as const, image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
          { type: 'text' as const, text: m.content },
        ] });
      } else out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant', content: m.content || null,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.raw ?? JSON.stringify(c.arguments ?? {}) } })) } : {}),
      });
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

function mapFinish(reason: unknown): StopReason {
  if (reason === 'stop') return 'end_turn';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'other';
}

class ToolCallAssembler {
  #parts = new Map<number, { id?: string; name?: string; args: string }>();
  push(deltas: unknown): void {
    if (!Array.isArray(deltas)) return;
    for (const d of deltas as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>) {
      const index = typeof d.index === 'number' ? d.index : this.#parts.size;
      const part = this.#parts.get(index) ?? { args: '' };
      if (d.id) part.id = d.id;
      if (d.function?.name) part.name = (part.name ?? '') + d.function.name;
      if (typeof d.function?.arguments === 'string') part.args += d.function.arguments;
      this.#parts.set(index, part);
    }
  }
  finish(): ToolCall[] {
    return [...this.#parts.entries()].sort(([a], [b]) => a - b).filter(([, p]) => p.name).map(([, p]) => {
      let args: unknown;
      try { args = p.args.trim() ? JSON.parse(p.args) : {}; } catch { args = undefined; }
      return { id: p.id ?? `call_${randomUUID()}`, name: p.name!, arguments: args, raw: p.args };
    });
  }
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly provider: ProviderConfig;
  readonly #env: Env;
  readonly #fetch: FetchLike;
  constructor(provider: ProviderConfig, env: Env, fetchImpl: FetchLike = fetch) {
    this.provider = provider; this.#env = env; this.#fetch = fetchImpl;
  }

  #base(): string {
    const checked = checkBaseUrl(this.provider.baseUrl ?? '', Boolean(this.provider.apiKeyEnv));
    if ('problem' in checked) throw new ProviderError('provider_error', `providers.${this.provider.id}.baseUrl: ${checked.problem}`, { retryable: false });
    return checked.url;
  }

  #secrets(): string[] { return providerSecrets(this.provider, this.#env); }

  #headers(): Record<string, string> {
    const key = requireApiKey(this.provider, this.#env);
    return { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    const base = this.#base();
    const headers = this.#headers();
    const system = [req.system.frozen, req.system.dynamic].filter(Boolean).join('\n\n');
    const body: Record<string, unknown> = {
      model: req.model.model,
      messages: toOpenAiMessages(system, req.messages, req.model.vision),
      stream: true,
      stream_options: { include_usage: true },
      ...(this.provider.server === 'openai' ? { max_completion_tokens: req.maxOutputTokens } : { max_tokens: req.maxOutputTokens }),
      ...(req.model.temperature === undefined ? {} : { temperature: req.model.temperature }),
      ...(req.effort ? { reasoning_effort: req.effort } : {}),
      ...(req.tools.length ? {
        tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
        parallel_tool_calls: false,
      } : {}),
    };
    const { signal, timeout } = withTimeout(req.signal, this.provider.timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(joinUrl(base, 'chat/completions'), { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
    } catch (error) { throw classifyFetchError(error, req.signal, timeout); }
    if (!response.ok || !response.body) throw classifyHttpFailure(response.status, await readSnippet(response, this.#secrets()), response.headers, this.#secrets());

    const tools = new ToolCallAssembler();
    let stop: StopReason = 'other';
    try {
      for await (const data of readSseData(response.body)) {
        if (data === '[DONE]') break;
        let chunk: any;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk?.error) {
          const message = typeof chunk.error === 'string' ? chunk.error : String(chunk.error.message ?? 'error');
          throw classifyHttpFailure(Number(chunk.error.code) || 500, message, undefined, this.#secrets());
        }
        const choice = chunk?.choices?.[0];
        const delta = choice?.delta;
        if (delta) {
          if (typeof delta.content === 'string' && delta.content) yield { type: 'text', delta: delta.content };
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', delta: reasoning };
          tools.push(delta.tool_calls);
        }
        if (choice?.finish_reason) stop = mapFinish(choice.finish_reason);
        if (chunk?.usage) {
          const u = chunk.usage;
          yield { type: 'usage', usage: {
            ...(typeof u.prompt_tokens === 'number' ? { inputTokens: u.prompt_tokens } : {}),
            ...(typeof u.completion_tokens === 'number' ? { outputTokens: u.completion_tokens } : {}),
            ...(typeof u.prompt_tokens_details?.cached_tokens === 'number' ? { cacheReadTokens: u.prompt_tokens_details.cached_tokens } : {}),
          } };
        }
      }
    } catch (error) { throw classifyFetchError(error, req.signal, timeout); }
    const calls = tools.finish();
    for (const call of calls) yield { type: 'tool_call', call };
    yield { type: 'done', stop: calls.length && stop !== 'max_tokens' ? 'tool_use' : stop };
  }

  async probe(model: ModelConfig, required: number, language: Language = DEFAULT_LANGUAGE): Promise<ProbeResult> {
    const result = await this.#probeContext(model, required, language);
    if (!['ok', 'too_small', 'exceeds_model', 'unknown'].includes(result.status)) return result;
    const efforts = await this.#probeEfforts(model);
    return efforts ? { ...result, efforts } : result;
  }

  // /v1/models の項目が supported_reasoning_efforts を知らせていれば、その値（標準の項目ではないので、無ければ undefined）。サーバーの種類を問わず読み、読めなくても確認の結果は変えない
  async #probeEfforts(model: ModelConfig): Promise<string[] | undefined> {
    try {
      const headers = this.#headers();
      delete headers['Accept'];
      const response = await this.#fetch(joinUrl(this.#base(), 'models'), { headers, signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (!response.ok) return undefined;
      const list: any = await response.json();
      const entry = Array.isArray(list?.data) ? list.data.find((m: any) => m?.id === model.model) : undefined;
      const efforts = entry?.supported_reasoning_efforts;
      const values = Array.isArray(efforts) ? efforts.filter((v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/u.test(v)).slice(0, 8) : [];
      return values.length ? values : undefined;
    } catch { return undefined; }
  }

  async #probeContext(model: ModelConfig, required: number, language: Language): Promise<ProbeResult> {
    const server = this.provider.server ?? 'generic';
    const facts = { modelId: model.id, server, required, declared: model.contextLength, language };
    let base: string; let headers: Record<string, string>;
    try { base = this.#base(); headers = this.#headers(); }
    catch (error) {
      const e = error as ProviderError;
      return { ...facts, status: e.kind === 'auth' ? 'no_api_key' : 'error', ...errorProbeText(e, language), checkedAt: Date.now() };
    }
    delete headers['Accept'];
    const getJson = async (url: URL): Promise<any> => {
      const response = await this.#fetch(url, { headers, signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (!response.ok) throw classifyHttpFailure(response.status, await readSnippet(response, this.#secrets()), undefined, this.#secrets());
      return response.json();
    };
    const origin = new URL(base).origin;
    try {
      if (server === 'lmstudio') {
        // LM Studio は読み込み済みのときだけ実際の長さ（loaded_context_length）が分かる
        const info = await getJson(new URL(`/api/v0/models/${encodeURIComponent(model.model)}`, origin));
        const loaded = info?.state === 'loaded' && typeof info.loaded_context_length === 'number' ? info.loaded_context_length : undefined;
        return evaluateContext({
          ...facts, measured: loaded, modelMax: typeof info?.max_context_length === 'number' ? info.max_context_length : undefined,
          hint: contextHint(language, 'lmstudio', required),
          unmeasuredNote: 'probe.note.not_loaded',
        });
      }
      if (server === 'llamacpp') {
        const props = await getJson(new URL('/props', origin));
        const nCtx = props?.default_generation_settings?.n_ctx;
        return evaluateContext({ ...facts, measured: typeof nCtx === 'number' ? nCtx : undefined, hint: contextHint(language, 'llamacpp', required) });
      }
      if (server === 'tabbyapi') {
        // TabbyAPI（ExLlamaV2/V3）: /v1/model が今読み込んでいるモデルと max_seq_len を返す
        const current = await getJson(joinUrl(base, 'model'));
        const maxSeq = current?.parameters?.max_seq_len;
        if (current?.id && current.id !== model.model) {
          return { ...facts, status: 'not_found', ...probeText(language, 'probe.tabby_other', { current: current.id, model: model.model }), hint: providerText(language, 'hint.tabby_other'), checkedAt: Date.now() };
        }
        return evaluateContext({ ...facts, measured: typeof maxSeq === 'number' ? maxSeq : undefined, hint: contextHint(language, 'tabbyapi', required) });
      }
      const list = await getJson(joinUrl(base, 'models'));
      const entry = Array.isArray(list?.data) ? list.data.find((m: any) => m?.id === model.model) : undefined;
      if (server === 'vllm') {
        if (!entry) return { ...facts, status: 'not_found', ...probeText(language, 'probe.vllm_missing', { model: model.model }), checkedAt: Date.now() };
        return evaluateContext({ ...facts, measured: typeof entry.max_model_len === 'number' ? entry.max_model_len : undefined, hint: contextHint(language, 'vllm', required) });
      }
      if (server === 'openrouter') {
        if (!entry) return { ...facts, status: 'not_found', ...probeText(language, 'probe.openrouter_missing', { model: model.model }), checkedAt: Date.now() };
        const max = entry.top_provider?.context_length ?? entry.context_length;
        return evaluateContext({ ...facts, modelMax: typeof max === 'number' ? max : undefined, hint: contextHint(language, 'hosted', required) });
      }
      if (server === 'openai') {
        return evaluateContext({ ...facts, hint: contextHint(language, 'hosted', required), unmeasuredNote: 'probe.note.use_config' });
      }
      // generic: サーバーの種類が分からなくても、/v1/models によく載る欄（vLLM・TabbyAPI・llama.cpp など）があれば使う
      const measured = [entry?.max_model_len, entry?.context_length, entry?.parameters?.max_seq_len, entry?.max_seq_len].find((v): v is number => typeof v === 'number' && v > 0);
      const trained = typeof entry?.meta?.n_ctx_train === 'number' ? entry.meta.n_ctx_train : undefined;
      return evaluateContext({
        ...facts, measured, ...(trained ? { modelMax: trained } : {}), hint: contextHint(language, 'generic', required),
        unmeasuredNote: 'probe.note.use_config',
      });
    } catch (error) {
      const e = error instanceof ProviderError ? error : classifyFetchError(error, new AbortController().signal);
      const status = e.kind === 'auth' ? 'no_api_key' : e.status === 404 ? 'not_found' : e.status === undefined ? 'unreachable' : 'error';
      return { ...facts, status, ...errorProbeText(e, language), checkedAt: Date.now() };
    }
  }
}
