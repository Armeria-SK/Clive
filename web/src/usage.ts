// 使用量の目盛り（設定の「記憶」と、記憶のページで共通）。デザインどおり、8 割を超えたらアクセント色にする。
export const USAGE_HIGH = 0.8;

export const usageFraction = (used: number, max: number): number => (max > 0 ? Math.min(1, Math.max(0, used / max)) : 0);

export const usageIsHigh = (used: number, max: number): boolean => max > 0 && used / max > USAGE_HIGH;
