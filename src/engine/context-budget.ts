import type { ModelConfig } from '../config/schema.ts';
import { SAFETY_MARGIN } from './tokens.ts';

// 古い発言を削り始める境目は、モデルのコンテキストの 95%（から最大出力を引いた量）。
export const CONTEXT_FILL_RATIO = 0.95;
// 会話の最初に固定する system に入れる記憶の量の上限は、そのモデルの「古い発言を削り始める境目」の 12%。
export const MEMORY_BUDGET_RATIO = 0.12;
// 固定する system に入る SOUL.md と USER.md の大きさの目安（超えても保存は止めず、画面で注意を出す）。
export const PERSONA_BUDGET_RATIO = 0.1;

// 道具の結果 1 つが取ってよい量は、そのとき残っている余裕のこの割合。余裕は、モデルの「古い発言を削り始める境目」（available）から、
// 古い発言を外しても残る分（system・道具の仕様・いまのやり取り。fit.ts の irreducibleEstimate）を引いたもの。結果は次のモデル呼び出しに全部積まれ、
// 同じやり取りの中の分は外せない。境目に対する固定の割合（以前は 2 割）だと、固定の分（道具の仕様が増える・日本語の本文）を考えないので、
// 小さなコンテキストでは結果が 3 つ（日本語なら 1 つ）で入りきらなくなる。残りに対する割合なら、結果が積まれるほど次の結果は小さくなり、最低の量に達するまでは入りきる。
// 4 分の 1 は、道具が 31 個のとき、結果の文字数の上限（16,000 文字）に届くコンテキストの大きさが、以前の 2 割と同じ約 29k になる値
export const TOOL_RESULT_RATIO = 0.25;
// 余裕がほとんど無くても、結果にはこれだけは許す（見積もりのトークン。英数字なら約 2,000 文字）
const MIN_TOOL_RESULT_TOKENS = 600;

// 道具の結果 1 つに許す量（見積もりのトークン。estimateTextTokens の単位）。irreducible は、いまのやり取りまで含めた、削れない送信量の見積もり
// （estimateRequest の tokens。補正 factor と安全率を掛けた後の値なので、ここで割り戻して、結果の文字の見積もりと同じ単位にする）
export function toolResultTokens(available: number, irreducible: number, factor = 1): number {
  const room = Math.max(0, available - irreducible);
  return Math.max(MIN_TOOL_RESULT_TOKENS, Math.floor((room * TOOL_RESULT_RATIO) / (factor * SAFETY_MARGIN)));
}

export const contextAvailable = (capacity: number, model: ModelConfig): number => Math.floor(capacity * CONTEXT_FILL_RATIO) - model.maxOutputTokens;
