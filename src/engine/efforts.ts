import type { AppConfig, ModelConfig } from '../config/schema.ts';
import type { ProbeResult } from '../providers/types.ts';

// そのモデルで選べる考える深さ。OpenAI 互換のプロバイダのモデルだけ（Anthropic・Ollama には送る仕組みが無い）。
// 設定の efforts が先で、無ければ確認で分かった値（サーバーが supported_reasoning_efforts で知らせたもの）。どちらも無ければ空 = 選ばせない
export function modelEfforts(config: AppConfig, model: ModelConfig, probe: Pick<ProbeResult, 'efforts'> | undefined): string[] {
  if (config.providers.find(p => p.id === model.provider)?.kind !== 'openai_compatible') return [];
  return [...(model.efforts?.length ? model.efforts : probe?.efforts ?? [])];
}
