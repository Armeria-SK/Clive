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

test('日付: DST 切替直後の変換', () => {
  // 2026-03-08 は America/New_York の DST 開始日（02:00 → 03:00）
  const before = value(convertZone('2026-03-08T03:30', 'America/New_York', 'UTC'));
  assert.equal(before.datetime, '2026-03-08T07:30', 'DST 開始後の 03:30 は UTC 07:30');
  const after = value(convertZone('2026-03-08T05:00', 'America/New_York', 'UTC'));
  assert.equal(after.datetime, '2026-03-08T09:00', 'DST 開始後の 05:00 は UTC 09:00');
});

test('日付: 時刻の範囲は拒否する', () => {
  failCode(convertZone('2026-01-01T25:00', 'UTC', 'UTC'), 'bad_datetime');
  failCode(convertZone('2026-01-01T00:99', 'UTC', 'UTC'), 'bad_datetime');
});

test('日付: 結果の年は範囲外を拒否する', () => {
  failCode(addToDate('2026-01-01', { years: -1950 }), 'out_of_range');
  failCode(addToDate('2026-01-01', { years: 100000 }), 'out_of_range');
  failCode(addToDate('2200-12-31', { days: 1 }), 'out_of_range');
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

test('日付: DST ギャップとフォールド（Temporal compatible）', () => {
  // 春のギャップ（存在しない wall）→ 遅い瞬間
  const nyGap = value(convertZone('2026-03-08T02:30', 'America/New_York', 'UTC'));
  assert.equal(nyGap.datetime, '2026-03-08T07:30', 'NY ギャップは遅い瞬間');
  const berlinGap = value(convertZone('2026-03-29T02:30', 'Europe/Berlin', 'UTC'));
  assert.equal(berlinGap.datetime, '2026-03-29T01:30', 'Berlin ギャップは遅い瞬間');
  // 秋のフォールド（二つの発生）→ 早い瞬間
  const nyFold = value(convertZone('2026-11-01T01:30', 'America/New_York', 'UTC'));
  assert.equal(nyFold.datetime, '2026-11-01T05:30', 'NY フォールドは早い瞬間');
  const berlinFold = value(convertZone('2026-10-25T02:30', 'Europe/Berlin', 'UTC'));
  assert.equal(berlinFold.datetime, '2026-10-25T00:30', 'Berlin フォールドは早い瞬間');
});

test('日付: 30 分 DST のギャップとフォールド（Lord Howe）', () => {
  // Australia/Lord_Howe は 30 分だけ切替。秋のフォールド（2026-04-05 02:00 → 01:30）→ 早い瞬間
  const howeFold = value(convertZone('2026-04-05T01:45', 'Australia/Lord_Howe', 'UTC'));
  assert.equal(howeFold.datetime, '2026-04-04T14:45', 'Lord Howe フォールドは早い瞬間（+11:00）');
  // 春のギャップ（2026-10-04 02:00 → 02:30、02:15 は存在しない）→ 遅い瞬間
  const howeGap = value(convertZone('2026-10-04T02:15', 'Australia/Lord_Howe', 'UTC'));
  assert.equal(howeGap.datetime, '2026-10-03T15:45', 'Lord Howe ギャップは遅い瞬間');
});
