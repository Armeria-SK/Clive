// 文字数からのおおまかな量の見積もり。サーバーの src/engine/tokens.ts の estimateTextTokens と同じ式（tests/onboarding-screen.test.ts で突き合わせている）。
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/u;

export function estimateTokens(text: string): number {
  let cjk = 0; let other = 0;
  for (const ch of text) { if (CJK.test(ch)) cjk++; else other++; }
  return Math.ceil(cjk + other / 3.5);
}

// SOUL.md と USER.md は固定の system に入る。合わせた量が予算（いちばん小さいモデルの available の 10%）を超えたら注意する（保存は止めない）。
export const overPersonaBudget = (tokens: number, budget: number | null): boolean => budget !== null && tokens > budget;
