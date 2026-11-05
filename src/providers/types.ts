import type { Language, ModelConfig, ProviderConfig } from '../config/schema.ts';
import type { ChatMessage, ContextDetail, EngineErrorKind, StopReason, ToolCall, ToolSpec, Usage } from '../engine/types.ts';
import type { MessageParams } from '../shared/messages/define.ts';
import { providerText, type ProviderMessageKey } from '../shared/messages/providers.ts';

export interface ModelRequest {
  model: ModelConfig;
  system: { frozen: string; dynamic: string };
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stop: StopReason };

export type ProbeStatus =
  | 'ok'
  | 'too_small'
  | 'exceeds_model'
  | 'unknown'
  | 'unreachable'
  | 'no_api_key'
  | 'not_found'
  | 'error';

export interface ProbeResult {
  modelId: string;
  status: ProbeStatus;
  server: string;
  declared?: number | undefined;
  measured?: number | undefined;
  modelMax?: number | undefined;
  effective?: number | undefined;
  required: number;
  message: string;
  messageCode?: string | undefined;
  messageParams?: MessageParams | undefined;
  hint?: string | undefined;
  capabilities?: string[] | undefined;
  checkedAt: number;
}

export interface ProviderAdapter {
  readonly provider: ProviderConfig;
  stream(request: ModelRequest): AsyncIterable<StreamEvent>;
  probe(model: ModelConfig, required: number, language?: Language): Promise<ProbeResult>;
}

export class ProviderError extends Error {
  readonly kind: EngineErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;
  readonly detail: ContextDetail | undefined;
  readonly code: ProviderMessageKey | undefined;
  readonly params: MessageParams;
  // 相手のサーバーが返した本文など。画面には出さず、実行ログにだけ残す（message・params には入れない）
  readonly upstream: string | undefined;
  constructor(kind: EngineErrorKind, message: string, options: {
    retryable?: boolean; retryAfterMs?: number; status?: number; detail?: ContextDetail; code?: ProviderMessageKey; params?: MessageParams; upstream?: string;
  } = {}) {
    super(message);
    this.kind = kind;
    this.retryable = options.retryable ?? (kind === 'rate_limit' || kind === 'timeout' || kind === 'provider_error');
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
    this.detail = options.detail;
    this.code = options.code;
    this.params = options.params ?? {};
    this.upstream = options.upstream;
  }

  text(language: Language): string { return this.code ? providerText(language, this.code, this.params) : this.message; }
}

export function providerError(kind: EngineErrorKind, code: ProviderMessageKey, params: MessageParams = {}, options: { retryable?: boolean; retryAfterMs?: number; status?: number; detail?: ContextDetail; upstream?: string } = {}): ProviderError {
  return new ProviderError(kind, providerText('ja', code, params), { ...options, code, params });
}

export type FetchLike = typeof fetch;
export type Env = Readonly<Record<string, string | undefined>>;
