import type { Language } from '../../config/schema.ts';

export type MessageParams = Record<string, string | number>;

export interface Catalog<K extends string> {
  (language: Language, key: K, params?: MessageParams): string;
  readonly domain: string;
  readonly tables: Record<Language, Record<K, string>>;
}

export function format(template: string, params: MessageParams = {}): string {
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

export function defineMessages<K extends string>(domain: string, ja: Record<K, string>, en: Record<K, string>): Catalog<K> {
  const tables: Record<Language, Record<K, string>> = { ja, en };
  const text = (language: Language, key: K, params?: MessageParams): string => format(tables[language][key], params);
  return Object.assign(text, { domain, tables });
}

export class LocalizedError<K extends string> extends Error {
  readonly code: K;
  readonly params: MessageParams;
  readonly #catalog: Catalog<K>;

  constructor(catalog: Catalog<K>, code: K, params: MessageParams = {}) {
    super(catalog('ja', code, params));
    this.code = code;
    this.params = params;
    this.#catalog = catalog;
  }

  get fullCode(): string { return `${this.#catalog.domain}.${this.code}`; }

  text(language: Language): string { return this.#catalog(language, this.code, this.params); }
}

export function errorText(error: unknown, language: Language): string {
  return error instanceof LocalizedError ? error.text(language) : error instanceof Error ? error.message : String(error);
}
