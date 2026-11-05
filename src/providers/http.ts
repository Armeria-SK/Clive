import { redactSecrets } from '../shared/redaction.ts';
import { ProviderError, providerError, type Env } from './types.ts';
import type { ProviderConfig } from '../config/schema.ts';

export { checkBaseUrl, isLoopbackHost } from '../shared/url.ts';

export function joinUrl(base: string, path: string): URL {
  return new URL(path.replace(/^\/+/u, ''), `${base.replace(/\/+$/u, '')}/`);
}

export function apiKey(provider: ProviderConfig, env: Env): string | undefined {
  if (!provider.apiKeyEnv) return undefined;
  const value = env[provider.apiKeyEnv];
  return value && value.trim() ? value.trim() : undefined;
}

export function requireApiKey(provider: ProviderConfig, env: Env): string | undefined {
  const key = apiKey(provider, env);
  if (provider.apiKeyEnv && !key) {
    throw providerError('auth', 'key.missing', { env: provider.apiKeyEnv }, { retryable: false });
  }
  return key;
}

export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - now, 3_600_000)) : undefined;
}

const CONTEXT_PATTERNS = /context[ _-]?length|context window|maximum context|max(?:imum)?_?model_?len|too many tokens|exceeds? the (?:available )?context|prompt is too long|context_length_exceeded|n_ctx|num_ctx|input is too long/i;

export async function readSnippet(response: Response, max = 2000): Promise<string> {
  try {
    const text = (await response.text()).slice(0, max);
    try {
      const json = JSON.parse(text) as { error?: unknown; message?: unknown };
      const error = json.error;
      if (typeof error === 'string') return error;
      if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
      if (typeof json.message === 'string') return json.message;
    } catch { }
    return text;
  } catch { return ''; }
}

export function classifyHttpFailure(status: number, snippet: string, headers?: Headers): ProviderError {
  const shown = redactSecrets(snippet).replace(/\s+/g, ' ').trim().slice(0, 200);
  const suffix = shown ? `: ${shown}` : '';
  const retryAfterMs = parseRetryAfter(headers?.get('retry-after'));
  if (CONTEXT_PATTERNS.test(snippet)) {
    return providerError('context_overflow', 'http.context_overflow', { status, suffix }, {
      retryable: false, status, detail: { reason: 'prompt_exceeds' },
    });
  }
  if (status === 401 || status === 403) return providerError('auth', 'http.auth', { status, suffix }, { retryable: false, status });
  if (status === 429) return providerError('rate_limit', 'http.rate_limit', { suffix }, { status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  if (status === 404) return providerError('provider_error', 'http.not_found', { suffix }, { retryable: false, status });
  if (status === 408 || status === 409 || status >= 500) {
    return providerError('provider_error', 'http.server', { status, suffix }, { retryable: true, status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  }
  return providerError('provider_error', 'http.rejected', { status, suffix }, { retryable: false, status });
}

export function classifyFetchError(error: unknown, signal: AbortSignal, timeoutSignal?: AbortSignal): ProviderError {
  if (error instanceof ProviderError) return error;
  if (signal.aborted && !timeoutSignal?.aborted) return providerError('cancelled', 'cancelled', {}, { retryable: false });
  if (timeoutSignal?.aborted) return providerError('timeout', 'timeout');
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  return code ? providerError('provider_error', 'connect.code', { code }, { retryable: true }) : providerError('provider_error', 'connect', {}, { retryable: true });
}

export function withTimeout(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(timeoutMs);
  return { signal: AbortSignal.any([signal, timeout]), timeout };
}

export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/u, '');
        buffer = buffer.slice(index + 1);
        yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer) yield buffer.replace(/\r$/u, '');
  } finally {
    reader.releaseLock();
  }
}

export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let data: string[] = [];
  for await (const line of readLines(body)) {
    if (line === '') {
      if (data.length) { yield data.join('\n'); data = []; }
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
  }
  if (data.length) yield data.join('\n');
}
