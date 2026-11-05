import { timezoneLabel, useT } from './i18n/index.ts';

export function ZoneNote({ input = false }: { input?: boolean }) {
  const t = useT();
  const zone = timezoneLabel();
  return <span className="muted small">{input ? t('time.inputZone', zone) : t('time.zoneNote', zone)}</span>;
}
