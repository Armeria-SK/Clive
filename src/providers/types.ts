import type { ModelConfig, ProviderConfig } from '../config/schema.ts';
import type { ChatMessage, ContextDetail, EngineErrorKind, StopReason, ToolCall, ToolSpec, Usage } from '../engine/types.ts';

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
  hint?: string | undefined;
  capabilities?: string[] | undefined;
  checkedAt: number;
}

export interface ProviderAdapter {
  readonly provider: ProviderConfig;
  stream(request: ModelRequest): AsyncIterable<StreamEvent>;
  probe(model: ModelConfig, required: number): Promise<ProbeResult>;
}

export class ProviderError extends Error {
  readonly kind: EngineErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;
  readonly detail: ContextDetail | undefined;
  constructor(kind: EngineErrorKind, message: string, options: {
    retryable?: boolean; retryAfterMs?: number; status?: number; detail?: ContextDetail;
  } = {}) {
    super(message);
    this.kind = kind;
    this.retryable = options.retryable ?? (kind === 'rate_limit' || kind === 'timeout' || kind === 'provider_error');
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
    this.detail = options.detail;
  }
}

export type FetchLike = typeof fetch;
export type Env = Readonly<Record<string, string | undefined>>;
