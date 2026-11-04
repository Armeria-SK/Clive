import { useSyncExternalStore } from 'react';
import { en } from './en.ts';
import { ja } from './ja.ts';
import { getLanguage, getVersion, subscribe, type Lang } from './state.ts';
import type { ArgsOf, Dict, DictKey } from './types.ts';

export { formatDateTime, formatList, formatNumber, formatRelative, parseZonedInput, pluralEn, startOfDay, timezoneLabel, type DateStyle } from './format.ts';
export { loadTimezone, type LoadTimezoneOptions, type TimezoneSettingsView } from './load-timezone.ts';
export {
  DEFAULT_LANGUAGE, DEFAULT_TIMEZONE, LANGUAGES, getLanguage, getLanguagePreference, getTimezone, initLanguage, resolveLanguage, setLanguagePreference, setTimezone,
  type Lang, type LanguagePreference,
} from './state.ts';
export type { DictKey } from './types.ts';

const dictionaries: Record<Lang, Dict> = { ja, en };

export function t<K extends DictKey>(key: K, ...args: ArgsOf<K>): string {
  const entry = dictionaries[getLanguage()][key] as string | ((...a: unknown[]) => string);
  return typeof entry === 'function' ? entry(...args) : entry;
}

export function useT(): typeof t {
  useSyncExternalStore(subscribe, getVersion);
  return t;
}
