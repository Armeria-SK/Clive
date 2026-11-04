export type Lang = 'ja' | 'en';
export type LanguagePreference = Lang | 'auto';

export const LANGUAGES: readonly Lang[] = ['ja', 'en'];
export const DEFAULT_LANGUAGE: Lang = 'ja';
export const DEFAULT_TIMEZONE = 'Asia/Tokyo';

const STORAGE_KEY = 'clive.language';

export function resolveLanguage(saved: string | null | undefined, browserLanguages: readonly string[]): Lang {
  const savedLang = LANGUAGES.find(l => l === saved);
  if (savedLang) return savedLang;
  for (const tag of browserLanguages) {
    const primary = tag.toLowerCase().split(/[-_]/u)[0];
    const match = LANGUAGES.find(l => l === primary);
    if (match) return match;
  }
  return DEFAULT_LANGUAGE;
}

export function isValidTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}

let preference: LanguagePreference = 'auto';
let language: Lang = DEFAULT_LANGUAGE;
let timezone = DEFAULT_TIMEZONE;
let version = 0;
const listeners = new Set<() => void>();

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

function readSaved(): LanguagePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'ja' || saved === 'en') return saved;
  } catch { }
  return 'auto';
}

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function applyLanguage(): void {
  language = resolveLanguage(preference === 'auto' ? null : preference, browserLanguages());
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  changed();
}

export function initLanguage(): void {
  preference = readSaved();
  applyLanguage();
}

export function setLanguagePreference(next: LanguagePreference): void {
  preference = next;
  try {
    if (next === 'auto') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch { }
  applyLanguage();
}

export function setTimezone(zone: string): void {
  const next = isValidTimeZone(zone) ? zone : DEFAULT_TIMEZONE;
  if (next === timezone) return;
  timezone = next;
  changed();
}

export const getLanguage = (): Lang => language;
export const getLanguagePreference = (): LanguagePreference => preference;
export const getTimezone = (): string => timezone;
export const getVersion = (): number => version;
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
