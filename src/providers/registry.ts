import type { AppConfig, ProviderConfig } from '../config/schema.ts';
import { AnthropicAdapter } from './anthropic.ts';
import { OllamaAdapter } from './ollama.ts';
import { OpenAiCompatibleAdapter } from './openai-compatible.ts';
import type { Env, FetchLike, ProviderAdapter } from './types.ts';

export function createAdapter(provider: ProviderConfig, env: Env, fetchImpl?: FetchLike): ProviderAdapter {
  switch (provider.kind) {
    case 'anthropic': return new AnthropicAdapter(provider, env, fetchImpl);
    case 'ollama': return new OllamaAdapter(provider, env, fetchImpl);
    case 'openai_compatible': return new OpenAiCompatibleAdapter(provider, env, fetchImpl);
  }
}

export class ProviderRegistry {
  #adapters = new Map<string, ProviderAdapter>();
  readonly #env: Env;
  readonly #fetch: FetchLike | undefined;
  readonly #override: ((provider: ProviderConfig) => ProviderAdapter | undefined) | undefined;
  constructor(options: { env?: Env; fetch?: FetchLike; override?: (provider: ProviderConfig) => ProviderAdapter | undefined } = {}) {
    this.#env = options.env ?? process.env;
    this.#fetch = options.fetch;
    this.#override = options.override;
  }

  reload(config: AppConfig): void {
    this.#adapters = new Map(config.providers.map(p => [p.id, this.#override?.(p) ?? createAdapter(p, this.#env, this.#fetch)]));
  }

  get(providerId: string): ProviderAdapter | undefined { return this.#adapters.get(providerId); }
}
