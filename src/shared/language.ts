import { DEFAULT_LANGUAGE, type AppConfig, type Language } from '../config/schema.ts';

export function languageOf(config: Pick<AppConfig, 'language'>): Language {
  return config.language ?? DEFAULT_LANGUAGE;
}
