// 使用量の目盛り（記憶のページの、会話に入る量の線）。デザインどおり、8 割を超えたらアクセント色にする。
export const USAGE_HIGH = 0.8;

export const usageFraction = (used: number, max: number): number => (max > 0 ? Math.min(1, Math.max(0, used / max)) : 0);

export const usageIsHigh = (used: number, max: number): boolean => max > 0 && used / max > USAGE_HIGH;
