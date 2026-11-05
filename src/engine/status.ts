import type { AppConfig, ModelConfig } from '../config/schema.ts';
import type { KV } from '../db/kv.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { ProbeResult } from '../providers/types.ts';
import { languageOf } from '../shared/language.ts';
import { providerText } from '../shared/messages/providers.ts';

export const HISTORY_RESERVE = 8192;

export function requiredContext(model: ModelConfig, baseTokens: number): number {
  return Math.max(model.minContext, baseTokens + HISTORY_RESERVE + model.maxOutputTokens);
}

export interface ModelStatusDeps {
  registry: ProviderRegistry;
  kv: KV;
  baseTokens: () => number;
  log?: (line: string) => void;
}

export class ModelStatus {
  #results = new Map<string, ProbeResult>();
  #cooldowns = new Map<string, { until: number; reason: string }>();
  readonly #deps: ModelStatusDeps;
  constructor(deps: ModelStatusDeps) { this.#deps = deps; }

  async probeAll(config: AppConfig): Promise<ProbeResult[]> {
    const base = this.#deps.baseTokens();
    const language = languageOf(config);
    const results = await Promise.all(config.models.map(async model => {
      const required = requiredContext(model, base);
      const adapter = this.#deps.registry.get(model.provider);
      if (!adapter) {
        return { modelId: model.id, status: 'error', server: '?', required, message: providerText(language, 'probe.no_provider', { id: model.provider }), messageCode: 'probe.no_provider', messageParams: { id: model.provider }, checkedAt: Date.now() } satisfies ProbeResult;
      }
      try { return await adapter.probe(model, required, language); }
      catch (error) {
        return { modelId: model.id, status: 'error', server: adapter.provider.kind, required, message: providerText(language, 'probe.check_failed', { detail: (error as Error).message }), messageCode: 'probe.check_failed', messageParams: { detail: (error as Error).message }, checkedAt: Date.now() } satisfies ProbeResult;
      }
    }));
    this.#results = new Map(results.map(r => [r.modelId, r]));
    this.#cooldowns.clear();
    for (const r of results) {
      this.#deps.kv.delete(`truncation:${r.modelId}`);
      if (r.status !== 'ok') this.#deps.log?.(`[ERROR] model ${r.modelId}: ${r.message}${r.hint ? ` / ${r.hint}` : ''}`);
    }
    return results;
  }

  get(modelId: string): ProbeResult | undefined { return this.#results.get(modelId); }
  all(): ProbeResult[] { return [...this.#results.values()]; }
  usable(modelId: string): boolean { return this.#results.get(modelId)?.status === 'ok'; }

  cooldown(modelId: string, until: number, reason: string): void { this.#cooldowns.set(modelId, { until, reason }); }
  endCooldown(modelId: string): void { this.#cooldowns.delete(modelId); }
  coolingDown(modelId: string, now = Date.now()): { until: number; reason: string } | undefined {
    const c = this.#cooldowns.get(modelId);
    if (c && c.until <= now) { this.#cooldowns.delete(modelId); return undefined; }
    return c;
  }

  disable(modelId: string, message: string, hint?: string): void {
    const current = this.#results.get(modelId);
    if (!current) return;
    this.#results.set(modelId, { ...current, status: 'error', message, ...(hint === undefined ? {} : { hint }), checkedAt: Date.now() });
    this.#deps.log?.(`[ERROR] model ${modelId}: ${message}`);
  }
}
