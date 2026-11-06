// 日付の核。日付・日時・タイムゾーンを扱う純粋な関数。成功と失敗を一つの型で返す（calc-core.ts と同じ形）

export type DateErrorCode = 'bad_date' | 'bad_datetime' | 'bad_timezone' | 'out_of_range' | 'missing';
export type DateResult<T> = { ok: true; value: T } | { ok: false; code: DateErrorCode; field?: string };

const MIN_YEAR = 1900;
const MAX_YEAR = 2200;
const MAX_AMOUNT = 100000;
const MS_PER_DAY = 86400000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function pad2(n: number): string { return String(n).padStart(2, '0'); }

// 実在する日か。Date.UTC は無い日（2026-02-30 など）を翌月へ繰り上げるので、戻り値を照合して判別する
function isRealDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

type ParsedDate = { y: number; m: number; d: number };
type ParsedDateTime = ParsedDate & { h: number; mi: number };

function yearError(y: number): DateErrorCode | null {
  return y < MIN_YEAR || y > MAX_YEAR ? 'out_of_range' : null;
}

function parseDate(s: string): DateResult<ParsedDate> {
  const match = DATE_RE.exec(s);
  if (!match) return { ok: false, code: 'bad_date' };
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!isRealDate(y, m, d)) return { ok: false, code: 'bad_date' };
  const err = yearError(y);
  if (err) return { ok: false, code: err };
  return { ok: true, value: { y, m, d } };
}

function parseDateTime(s: string): DateResult<ParsedDateTime> {
  const match = DATETIME_RE.exec(s);
  if (!match) return { ok: false, code: 'bad_datetime' };
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const h = Number(match[4]);
  const mi = Number(match[5]);
  if (!isRealDate(y, m, d)) return { ok: false, code: 'bad_date' };
  const err = yearError(y);
  if (err) return { ok: false, code: err };
  return { ok: true, value: { y, m, d, h, mi } };
}

function makeFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
}

type Wall = { y: number; m: number; d: number; h: number; mi: number; offset: string };

function readWall(fmt: Intl.DateTimeFormat, ms: number): Wall {
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    h: Number(get('hour')),
    mi: Number(get('minute')),
    offset: get('timeZoneName').replace('GMT', ''),
  };
}

export function nowIn(timezone: string, nowMs: number): DateResult<{ date: string; time: string; weekday: number; offset: string }> {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = makeFormatter(timezone);
  } catch {
    return { ok: false, code: 'bad_timezone' };
  }
  const w = readWall(fmt, nowMs);
  const weekday = (new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay() + 6) % 7;
  return { ok: true, value: { date: `${w.y}-${pad2(w.m)}-${pad2(w.d)}`, time: `${pad2(w.h)}:${pad2(w.mi)}`, weekday, offset: w.offset } };
}

export function addToDate(date: string, amount: { days?: number; weeks?: number; months?: number; years?: number }): DateResult<string> {
  const parsed = parseDate(date);
  if (!parsed.ok) return parsed;
  for (const key of ['days', 'weeks', 'months', 'years'] as const) {
    const v = amount[key];
    if (v !== undefined && Math.abs(v) > MAX_AMOUNT) return { ok: false, code: 'out_of_range' };
  }
  const { y: sy, m: sm, d: sd } = parsed.value;
  const totalMonths = (sy - 1) * 12 + (sm - 1) + (amount.years ?? 0) * 12 + (amount.months ?? 0);
  const y = Math.floor(totalMonths / 12) + 1;
  const m = ((totalMonths % 12) + 12) % 12 + 1;
  const d = Math.min(sd, daysInMonth(y, m));
  const dayCount = (amount.days ?? 0) + (amount.weeks ?? 0) * 7;
  const dt = new Date(Date.UTC(y, m - 1, d) + dayCount * MS_PER_DAY);
  return { ok: true, value: `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}` };
}

export function diffDates(from: string, to: string): DateResult<{ days: number; weekdays: number }> {
  const a = parseDate(from);
  if (!a.ok) return a;
  const b = parseDate(to);
  if (!b.ok) return b;
  const startMs = Date.UTC(a.value.y, a.value.m - 1, a.value.d);
  const endMs = Date.UTC(b.value.y, b.value.m - 1, b.value.d);
  const days = Math.round((endMs - startMs) / MS_PER_DAY);
  let weekdays = 0;
  if (endMs >= startMs) {
    for (let cursor = startMs; cursor < endMs; cursor += MS_PER_DAY) {
      const dow = new Date(cursor).getUTCDay();
      if (dow >= 1 && dow <= 5) weekdays++;
    }
  } else {
    for (let cursor = endMs; cursor < startMs; cursor += MS_PER_DAY) {
      const dow = new Date(cursor).getUTCDay();
      if (dow >= 1 && dow <= 5) weekdays--;
    }
  }
  return { ok: true, value: { days, weekdays } };
}

export function weekdayOf(date: string): DateResult<number> {
  const parsed = parseDate(date);
  if (!parsed.ok) return parsed;
  const dow = new Date(Date.UTC(parsed.value.y, parsed.value.m - 1, parsed.value.d)).getUTCDay();
  return { ok: true, value: (dow + 6) % 7 };
}

export function convertZone(datetime: string, fromZone: string, toZone: string): DateResult<{ datetime: string; offset: string }> {
  const parsed = parseDateTime(datetime);
  if (!parsed.ok) return parsed;
  let fromFmt: Intl.DateTimeFormat;
  let toFmt: Intl.DateTimeFormat;
  try {
    fromFmt = makeFormatter(fromZone);
    toFmt = makeFormatter(toZone);
  } catch {
    return { ok: false, code: 'bad_timezone' };
  }
  const { y, m, d, h, mi } = parsed.value;
  const provUtc = Date.UTC(y, m - 1, d, h, mi);
  const fromWall = readWall(fromFmt, provUtc);
  const fromWallMs = Date.UTC(fromWall.y, fromWall.m - 1, fromWall.d, fromWall.h, fromWall.mi);
  const trueUtc = provUtc + (provUtc - fromWallMs);
  const toWall = readWall(toFmt, trueUtc);
  const datetimeOut = `${toWall.y}-${pad2(toWall.m)}-${pad2(toWall.d)}T${pad2(toWall.h)}:${pad2(toWall.mi)}`;
  return { ok: true, value: { datetime: datetimeOut, offset: toWall.offset } };
}
