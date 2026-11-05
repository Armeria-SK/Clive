import { LANGUAGES, setLanguagePreference, setTimezone } from './state.ts';

export interface ServerSettingsView { config: { timezone?: unknown; language?: unknown } }

export interface LoadSettingsOptions {
  waitMs?: number;
  retryMs?: number;
}

export const SETTINGS_WAIT_MS = 3000;
export const SETTINGS_RETRY_MS = 5000;

// サーバーの設定のうち、画面の表示に関わるもの（タイムゾーン・言語）を反映する。language が無ければ「ブラウザの言語」に従う。
export function applyServerSettings({ config }: ServerSettingsView): void {
  if (typeof config.timezone === 'string') setTimezone(config.timezone);
  const language = LANGUAGES.find(l => l === config.language);
  setLanguagePreference(language ?? 'auto');
}

// 最初の描画は waitMs までしか待たない。そのあとで設定が届いたら、届いた時点で反映する
// （捨てると、設定を開くまでタイムゾーンが既定のままになり、日時の入力が違う時刻として読まれる）。
// 読めなかったときは一度だけ、retryMs 後にやり直す。
export async function loadServerSettings(
  fetchSettings: () => Promise<ServerSettingsView>,
  { waitMs = SETTINGS_WAIT_MS, retryMs = SETTINGS_RETRY_MS }: LoadSettingsOptions = {},
): Promise<void> {
  const apply = applyServerSettings;
  let retried = false;
  const attempt = (): Promise<void> => fetchSettings().then(apply, (error: unknown) => {
    console.warn('Could not load the server settings; showing the default time zone and the browser language', error);
    if (!retried) {
      retried = true;
      setTimeout(() => { void attempt(); }, retryMs);
    }
  });
  const pending = attempt();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); });
  try { await Promise.race([pending, timeout]); } finally { clearTimeout(timer); }
}
