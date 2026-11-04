import { setTimezone } from './state.ts';

export interface TimezoneSettingsView { config: { timezone?: unknown } }

export interface LoadTimezoneOptions {
  waitMs?: number;
  retryMs?: number;
}

export const SETTINGS_WAIT_MS = 3000;
export const SETTINGS_RETRY_MS = 5000;

// 最初の描画は waitMs までしか待たない。そのあとで設定が届いたら、届いた時点で反映する
// （捨てると、設定を開くまでタイムゾーンが既定のままになり、日時の入力が違う時刻として読まれる）。
// 読めなかったときは一度だけ、retryMs 後にやり直す。
export async function loadTimezone(
  fetchSettings: () => Promise<TimezoneSettingsView>,
  { waitMs = SETTINGS_WAIT_MS, retryMs = SETTINGS_RETRY_MS }: LoadTimezoneOptions = {},
): Promise<void> {
  const apply = ({ config }: TimezoneSettingsView): void => { if (typeof config.timezone === 'string') setTimezone(config.timezone); };
  let retried = false;
  const attempt = (): Promise<void> => fetchSettings().then(apply, (error: unknown) => {
    console.warn('Could not load the server settings; showing times in the default time zone', error);
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
