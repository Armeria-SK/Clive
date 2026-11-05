import { useSyncExternalStore } from 'react';
import { en } from './en.ts';
import { ja } from './ja.ts';
import { getLanguage, getVersion, subscribe, type Lang } from './state.ts';
import type { ArgsOf, Dict, DictKey } from './types.ts';

export { formatDateTime, formatDateTimeSmart, formatList, formatNumber, formatRelative, parseZonedInput, pluralEn, startOfDay, timezoneLabel, type DateStyle } from './format.ts';
export { formatElapsed } from './elapsed.ts';
export { applyServerSettings, loadServerSettings, type LoadSettingsOptions, type ServerSettingsView } from './load-settings.ts';
export {
  DEFAULT_LANGUAGE, DEFAULT_TIMEZONE, LANGUAGES, getLanguage, getLanguagePreference, getSettingsApplied, getTimezone, initLanguage, resolveLanguage, setLanguagePreference, setTimezone,
  type Lang, type LanguagePreference,
} from './state.ts';
export type { DictKey, PlainKey } from './types.ts';

const dictionaries: Record<Lang, Dict> = { ja, en };

export function t<K extends DictKey>(key: K, ...args: ArgsOf<K>): string {
  const entry = dictionaries[getLanguage()][key] as string | ((...a: unknown[]) => string);
  return typeof entry === 'function' ? entry(...args) : entry;
}

const COMPACT_STEPS = [
  ['time.years', 31_536_000_000], ['time.months', 2_592_000_000], ['time.days', 86_400_000], ['time.hours', 3_600_000], ['time.minutes', 60_000],
] as const;

// サイドバーの会話の横に置く短い相対時刻（5分 / 2時間 / 3日。en は 5m / 2h / 3d）。1 分未満は「今」。
export function formatRelativeCompact(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  for (const [key, size] of COMPACT_STEPS) if (diff >= size) return t(key, Math.floor(diff / size));
  return t('time.now');
}

export function useT(): typeof t {
  useSyncExternalStore(subscribe, getVersion);
  return t;
}
