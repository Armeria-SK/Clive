import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addToDate,
  convertZone,
  diffDates,
  nowIn,
  weekdayOf,
  type DateResult,
} from '../src/tools/builtin/date-core.ts';

const value = <T,>(result: DateResult<T>): T => {
  assert.equal(result.ok, true);
  return (result as Extract<DateResult<T>, { ok: true }>).value;
};

const failCode = <T,>(result: DateResult<T>, code: string): void => {
  assert.equal(result.ok, false);
  assert.equal((result as Extract<DateResult<T>, { ok: false }>).code, code);
};

test('日付: 月の足し算は月末で止まる', () => {
  assert.equal(value(addToDate('2026-01-31', { months: 1 })), '2026-02-28');
  assert.equal(value(addToDate('2024-02-29', { years: 1 })), '2025-02-28');
});

test('日付: 日数と平日の差', () => {
  const diff = value(diffDates('2026-11-02', '2026-11-09'));
  assert.equal(diff.days, 7);
  assert.equal(diff.weekdays, 5, 'from を含み to を含まない月〜金');
});

test('日付: 曜日は 0=月 … 6=日', () => {
  assert.equal(value(weekdayOf('2026-11-06')), 4, '金');
});

test('日付: タイムゾーン変換', () => {
  const july = value(convertZone('2026-07-01T09:00', 'Asia/Tokyo', 'America/New_York'));
  assert.equal(july.datetime, '2026-06-30T20:00');
  assert.equal(july.offset, '-04:00', '夏時間');
  const jan = value(convertZone('2026-01-15T09:00', 'Asia/Tokyo', 'America/New_York'));
  assert.equal(jan.datetime, '2026-01-14T19:00');
  assert.equal(jan.offset, '-05:00', '冬時間');
});

test('日付: 今この瞬間', () => {
  const now = value(nowIn('Asia/Tokyo', Date.UTC(2026, 10, 6, 15, 0)));
  assert.equal(now.date, '2026-11-07');
  assert.equal(now.time, '00:00');
  assert.equal(now.offset, '+09:00');
});

test('日付: 失敗のコード', () => {
  failCode(addToDate('2026-02-30', { days: 1 }), 'bad_date');
  failCode(weekdayOf('2026-02-30'), 'bad_date');
  failCode(nowIn('Mars/Base', Date.UTC(2026, 10, 6, 15, 0)), 'bad_timezone');
  failCode(convertZone('2026-07-01T09:00', 'Mars/Base', 'America/New_York'), 'bad_timezone');
  failCode(addToDate('1800-01-01', { days: 1 }), 'out_of_range');
});
