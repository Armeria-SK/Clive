import type { AppConfig, ProviderConfig } from '../config/schema.ts';
import { OLLAMA_DEFAULT_URL } from '../config/store.ts';
import { isLoopbackHost } from '../shared/url.ts';

// 手元のモデル = 提供元の接続先（baseUrl）がループバックのホスト。Ollama は接続先が無ければ既定の 127.0.0.1。
// 手元のモデルで話した会話は、外のモデルに渡さない約束の元になる判定（振り返り・履歴の検索）
export function isLocalProvider(provider: ProviderConfig): boolean {
  const base = provider.baseUrl ?? (provider.kind === 'ollama' ? OLLAMA_DEFAULT_URL : undefined);
  if (!base) return false;
  try { return isLoopbackHost(new URL(base).hostname); } catch { return false; }
}

// 設定にあるモデルで、提供元が手元のものの id。提供元が設定に無いモデルは、手元と言えないので入れない
export function localModelIds(config: AppConfig): string[] {
  return config.models.filter(m => { const provider = config.providers.find(p => p.id === m.provider); return provider !== undefined && isLocalProvider(provider); }).map(m => m.id);
}

export function isLocalModel(config: AppConfig, modelId: string | null | undefined): boolean {
  return modelId != null && localModelIds(config).includes(modelId);
}

// 設定にあるモデルで、提供元が外（手元でない）と分かっているものの id
export function externalModelIds(config: AppConfig): string[] {
  return config.models.filter(m => { const provider = config.providers.find(p => p.id === m.provider); return provider !== undefined && !isLocalProvider(provider); }).map(m => m.id);
}

// 会話で選んだモデルが、「手元のモデルを選んだ会話」の約束の対象か。選んでいて（null は自動で対象外）、外と分かっているモデルでなければ対象。
// 設定から消した・名前を変えたモデルや、提供元が設定に無いモデルも対象にする（外へ回さない側に倒す）
export function isLocalPinned(config: AppConfig, modelId: string | null | undefined): boolean {
  return modelId != null && !externalModelIds(config).includes(modelId);
}
