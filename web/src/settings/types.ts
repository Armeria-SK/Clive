import type { Config, Problem } from './model.ts';

export interface SectionProps {
  draft: Config;
  saved: Config;
  update: (change: (config: Config) => Config) => void;
  problems: readonly Problem[];
}

export const errorFor = (problems: readonly Problem[], path: string): string | undefined => problems.find(p => p.path === path)?.message;

// 保存した設定と今の設定の同じ場所を比べる（行の「変更あり」の点）。
export const differs = (saved: Config, draft: Config, read: (config: Config) => unknown): boolean => {
  const safe = (config: Config) => { try { return JSON.stringify(read(config)) ?? ''; } catch { return ''; } };
  return safe(saved) !== safe(draft);
};
