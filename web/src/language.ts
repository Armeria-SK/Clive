import { api } from './api.ts';
import { setLanguagePreference, type Lang, type LanguagePreference } from './i18n/index.ts';

const PROMPT_KEY = 'clive.languagePrompt';
export type PromptAnswer = 'yes' | 'no';

// 設定の language が無く（返事は日本語のまま）、画面だけがブラウザの言語（日本語以外）になっているときに、1 回だけ
// 「Clive も英語にしますか」と聞く。答えたら（どちらでも）二度と聞かない。
export function shouldAskLanguage(input: { serverLanguage: LanguagePreference; screenLanguage: Lang; answered: boolean }): boolean {
  return input.serverLanguage === 'auto' && input.screenLanguage !== 'ja' && !input.answered;
}

export function loadPromptAnswer(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): PromptAnswer | null {
  try {
    const value = storage?.getItem(PROMPT_KEY);
    return value === 'yes' || value === 'no' ? value : null;
  } catch { return null; }
}

export function savePromptAnswer(answer: PromptAnswer, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try { storage?.setItem(PROMPT_KEY, answer); } catch { }
}

// auto は language を設定から消す（省略 = 返事は日本語のまま、画面はブラウザの言語）。
export function configWithLanguage(config: Record<string, unknown>, language: LanguagePreference): Record<string, unknown> {
  const next = { ...config };
  if (language === 'auto') delete next.language;
  else next.language = language;
  return next;
}

// 設定の画面を開いたまま、ほかの場所（コマンドパレット・「Clive も英語にしますか」）で言語が保存されたとき、
// 画面の中の「保存済み」と「編集中」の language も合わせる（合わせないと、次の保存で language が元に戻ってしまう）。
// すでに合っていれば同じものを返す。
export function withAdoptedLanguage<T extends Record<string, unknown>>(config: T, preference: LanguagePreference): T {
  return (config.language ?? 'auto') === preference ? config : configWithLanguage(config, preference) as T;
}

// 編集中の language は、保存済みと同じ（自分では触っていない）ときだけ合わせる。自分で変えていれば、その編集を残す。
export function adoptLanguageInDraft<T extends Record<string, unknown>>(draft: T, savedLanguage: unknown, preference: LanguagePreference): T {
  return draft.language === savedLanguage ? withAdoptedLanguage(draft, preference) : draft;
}

// 設定を読み直して language だけを変えて保存し、画面に反映する（コマンドパレットと「Clive も英語にしますか」で使う）。
export async function saveLanguage(language: LanguagePreference): Promise<void> {
  const view = await api.settings();
  await api.saveSettings(configWithLanguage(view.config, language));
  setLanguagePreference(language);
}

function safeStorage(): Storage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}
