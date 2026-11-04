import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cronToFields, describeCron, inferFreqFromCron, nextRunAt, parseCron, validateCron } from '../src/tasks/schedule.ts';

// 繰り返しの簡単入力（毎日・平日・毎週・毎時・N分ごと）と cron 式の変換

test('inferFreqFromCron: 種類の推定', () => {
  assert.equal(inferFreqFromCron('*/5 * * * *'), 'interval');
  assert.equal(inferFreqFromCron('30 * * * *'), 'hourly');
  assert.equal(inferFreqFromCron('0 9 * * MON-FRI'), 'weekday');
  assert.equal(inferFreqFromCron('30 9 * * *'), 'daily');
  assert.equal(inferFreqFromCron('0 9 * * MON'), 'weekly');
  assert.equal(inferFreqFromCron('0 9 * *'), null, '欄の数が違う');
  assert.equal(inferFreqFromCron('*/5 9 * * *'), 'interval', '分が */N なら時の指定があっても interval');
});

test('validateCron', () => {
  assert.equal(validateCron('30 9 * * *'), true);
  assert.equal(validateCron('99 99 * * *'), false);
  assert.equal(validateCron('not a cron'), false);
});

test('parseCron: 簡単入力から cron 式へ', () => {
  assert.equal(parseCron('daily', { time: '09:30' }), '30 9 * * *');
  assert.equal(parseCron('weekday', { time: '08:00' }), '0 8 * * MON-FRI');
  assert.equal(parseCron('weekly', { time: '10:15', day: '火' }), '15 10 * * TUE');
  assert.equal(parseCron('weekly', { time: '10:15', day: 'Xxx' }), null);
  assert.equal(parseCron('hourly', { minute: '45' }), '45 * * * *');
  assert.equal(parseCron('hourly', { minute: '60' }), null);
  assert.equal(parseCron('interval', { interval: '10' }), '*/10 * * * *');
  assert.equal(parseCron('interval', { interval: '0' }), null);
  assert.equal(parseCron('yearly', {}), null);
  assert.equal(parseCron('daily', { time: '9시30분' }), null);
});

test('cronToFields: cron 式から簡単入力へ', () => {
  assert.deepEqual(cronToFields('30 9 * * *', 'daily'), { time: '09:30' });
  assert.deepEqual(cronToFields('0 9 * * TUE', 'weekly'), { time: '09:00', day: '火' });
  assert.deepEqual(cronToFields('45 * * * *', 'hourly'), { minute: '45' });
  assert.deepEqual(cronToFields('*/10 * * * *', 'interval'), { interval: '10' });
  assert.deepEqual(cronToFields('garbage', 'daily'), {});
});

test('parseCron → inferFreqFromCron の往復', () => {
  for (const [freq, values] of [
    ['daily', { time: '07:05' }], ['weekday', { time: '12:00' }], ['hourly', { minute: '20' }], ['interval', { interval: '15' }],
  ] as const) {
    const cron = parseCron(freq, values);
    assert.ok(cron);
    assert.equal(inferFreqFromCron(cron), freq);
  }
});

test('nextRunAt: タイムゾーンを考慮する（Asia/Tokyo の 9 時は UTC の 0 時）', () => {
  const after = Date.parse('2026-11-04T20:00:00Z'); // 日本時間 11/5 05:00
  assert.equal(nextRunAt('0 9 * * *', 'Asia/Tokyo', after), Date.parse('2026-11-05T00:00:00Z'));
  assert.equal(nextRunAt('0 9 * * *', 'UTC', after), Date.parse('2026-11-05T09:00:00Z'));
  // 金曜の夜（日本時間）の次の平日 9 時は月曜
  const fridayNight = Date.parse('2026-11-06T13:00:00Z'); // 日本時間 11/6（金）22:00
  assert.equal(nextRunAt('0 9 * * MON-FRI', 'Asia/Tokyo', fridayNight), Date.parse('2026-11-09T00:00:00Z'));
  assert.equal(nextRunAt('not a cron', 'Asia/Tokyo', after), null);
});

test('describeCron: 人向けの説明', () => {
  assert.equal(describeCron('0 9 * * MON-FRI'), '平日 09:00');
  assert.equal(describeCron('15 10 * * TUE'), '毎週火曜 10:15');
  assert.equal(describeCron('*/30 * * * *'), '30 分ごと');
  assert.equal(describeCron('0 0 1 * *'), '0 0 1 * *', '簡単入力で表せないものは式のまま');
});
