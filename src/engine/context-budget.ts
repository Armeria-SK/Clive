import type { ModelConfig } from '../config/schema.ts';

// 古い発言を削り始める境目は、モデルのコンテキストの 95%（から最大出力を引いた量）。
export const CONTEXT_FILL_RATIO = 0.95;
// 会話の最初に固定する system に入れる記憶の量の上限は、そのモデルの「古い発言を削り始める境目」の 12%。
export const MEMORY_BUDGET_RATIO = 0.12;
// 固定する system に入る SOUL.md と USER.md の大きさの目安（超えても保存は止めず、画面で注意を出す）。
export const PERSONA_BUDGET_RATIO = 0.1;

// 道具の結果 1 つが、そのモデルの「古い発言を削り始める境目」に占めてよい割合。結果は次のモデル呼び出しに全部積まれるので、
// 小さなコンテキスト（ローカルのモデルの 8k など）では、大きな一覧 1 つで入りきらなくなる
export const TOOL_RESULT_RATIO = 0.2;
const CHARS_PER_TOKEN = 3;
const MIN_TOOL_RESULT_CHARS = 2000;

export function toolOutputLimit(available: number, max: number): number {
  return Math.max(MIN_TOOL_RESULT_CHARS, Math.min(max, Math.floor(available * TOOL_RESULT_RATIO * CHARS_PER_TOKEN)));
}

export const contextAvailable = (capacity: number, model: ModelConfig): number => Math.floor(capacity * CONTEXT_FILL_RATIO) - model.maxOutputTokens;
