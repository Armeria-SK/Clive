import type { AppConfig, ModelConfig } from '../config/schema.ts';
import type { KV } from '../db/kv.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { ProbeResult } from '../providers/types.ts';
import { languageOf } from '../shared/language.ts';
import { providerText } from '../shared/messages/providers.ts';
import { contextAvailable, MEMORY_BUDGET_RATIO } from './context-budget.ts';

export const HISTORY_RESERVE = 8192;

// 必要な長さ。記憶の分は、そのモデル自身の「古い発言を削り始める境目」の 12% までしか数えない（会話に入れる記憶の予算が、実行のときもそれ以下になるため）。
// 長さが分からないと予算が決まらず、予算が決まらないと必要な長さが決まらない、という堂々巡りを避けるため、
// 「その長さで足りる」いちばん短い長さを二分探索で求める（長さが増えるほど足りないものは減るので、答えは 1 つに決まる）。
export function requiredContext(model: ModelConfig, baseTokens: number, memoryTokens = 0): number {
  const fixed = baseTokens + HISTORY_RESERVE + model.maxOutputTokens;
  const needAt = (capacity: number) => Math.max(model.minContext, fixed + Math.min(memoryTokens, Math.floor(MEMORY_BUDGET_RATIO * Math.max(0, contextAvailable(capacity, model)))));
  let low = 0;
  let high = Math.max(model.minContext, fixed + memoryTokens);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (middle >= needAt(middle)) high = middle; else low = middle + 1;
  }
  return high;
}

export interface ModelStatusDeps {
  registry: ProviderRegistry;
  kv: KV;
  baseTokens: () => number;
  memoryTokens?: (() => number) | undefined;
  log?: (line: string) => void;
}

export class ModelStatus {
  #results = new Map<string, ProbeResult>();
  #cooldowns = new Map<string, { until: number; reason: string }>();
  readonly #deps: ModelStatusDeps;
  constructor(deps: ModelStatusDeps) { this.#deps = deps; }

  async probeAll(config: AppConfig): Promise<ProbeResult[]> {
    const base = this.#deps.baseTokens();
    const memory = this.#deps.memoryTokens?.() ?? 0;
    const language = languageOf(config);
    const results = await Promise.all(config.models.map(async model => {
      const required = requiredContext(model, base, memory);
      const adapter = this.#deps.registry.get(model.provider);
      if (!adapter) {
        return { modelId: model.id, status: 'error', server: '?', required, message: providerText(language, 'probe.no_provider', { id: model.provider }), messageCode: 'provider.probe.no_provider', messageParams: { id: model.provider }, checkedAt: Date.now() } satisfies ProbeResult;
      }
      try { return await adapter.probe(model, required, language); }
      catch (error) {
        return { modelId: model.id, status: 'error', server: adapter.provider.kind, required, message: providerText(language, 'probe.check_failed', { detail: (error as Error).message }), messageCode: 'provider.probe.check_failed', messageParams: { detail: (error as Error).message }, checkedAt: Date.now() } satisfies ProbeResult;
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
