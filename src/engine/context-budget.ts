import type { ModelConfig } from '../config/schema.ts';

// 古い発言を削り始める境目は、モデルのコンテキストの 95%（から最大出力を引いた量）。
export const CONTEXT_FILL_RATIO = 0.95;
// 会話の最初に固定する system に入れる記憶の量の上限は、そのモデルの「古い発言を削り始める境目」の 12%。
export const MEMORY_BUDGET_RATIO = 0.12;
// 固定する system に入る SOUL.md と USER.md の大きさの目安（超えても保存は止めず、画面で注意を出す）。
export const PERSONA_BUDGET_RATIO = 0.1;

export const contextAvailable = (capacity: number, model: ModelConfig): number => Math.floor(capacity * CONTEXT_FILL_RATIO) - model.maxOutputTokens;
