import { getLanguage, getTimezone } from './state.ts';

export type DateStyle = 'compact' | 'full' | 'precise' | 'time';

const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  compact: { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  full: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' },
  precise: { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' },
  time: { hour: '2-digit', minute: '2-digit' },
};

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(locale: string, zone: string, style: DateStyle | 'wall'): Intl.DateTimeFormat {
  const key = `${locale}|${zone}|${style}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = style === 'wall'
      ? new Intl.DateTimeFormat(locale, { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      : new Intl.DateTimeFormat(locale, { timeZone: zone, ...DATE_OPTIONS[style] });
    formatters.set(key, formatter);
  }
  return formatter;
}

function wallClock(ms: number, zone: string) {
  const parts: Record<string, number> = {};
  for (const part of dateFormatter('en-US', zone, 'wall').formatToParts(ms)) parts[part.type] = Number(part.value);
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute!, second: parts.second! };
}

function offsetMs(ms: number, zone: string): number {
  const w = wallClock(ms, zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export function formatDateTime(ms: number | null | undefined, style: DateStyle = 'compact'): string {
  return ms ? dateFormatter(getLanguage(), getTimezone(), style).format(ms) : '—';
}

export function parseZonedInput(value: string, zone = getTimezone()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number, number];
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(asUtc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) return null;
  const before = offsetMs(asUtc - DAY_MS, zone);
  const after = offsetMs(asUtc + DAY_MS, zone);
  const instants = [...new Set([before, after])].map(offset => asUtc - offset).filter(instant => offsetMs(instant, zone) === asUtc - instant);
  return instants.length ? Math.min(...instants) : asUtc - before;
}

export function startOfDay(ms: number, zone = getTimezone()): number {
  const w = wallClock(ms, zone);
  return parseZonedInput(`${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T00:00`, zone) ?? ms;
}

export function timezoneLabel(zone = getTimezone(), at = Date.now()): string {
  const minutes = Math.round(offsetMs(at, zone) / 60_000);
  const abs = Math.abs(minutes);
  return `${zone} (UTC${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)})`;
}

export function formatRelative(ms: number, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(getLanguage(), { numeric: 'auto' });
  const seconds = (ms - now) / 1000;
  if (Math.abs(seconds) < 45) return rtf.format(0, 'second');
  const steps: Array<[Intl.RelativeTimeFormatUnit, number, number]> = [['minute', 60, 60], ['hour', 3600, 24], ['day', 86_400, 30], ['month', 2_592_000, 12]];
  for (const [unit, size, limit] of steps) {
    const amount = Math.round(seconds / size);
    if (Math.abs(amount) < limit) return rtf.format(amount, unit);
  }
  return rtf.format(Math.round(seconds / 31_536_000), 'year');
}

export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getLanguage(), options).format(n);
}

export function formatList(items: readonly string[]): string {
  return new Intl.ListFormat(getLanguage(), { style: 'long', type: 'conjunction' }).format(items);
}

export function pluralEn(n: number, forms: { one: string; other: string }): string {
  return new Intl.PluralRules('en').select(n) === 'one' ? forms.one : forms.other;
}
