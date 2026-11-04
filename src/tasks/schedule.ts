import { Cron } from 'croner';

export const DAY_MAP: Record<string, string> = { 月: 'MON', 火: 'TUE', 水: 'WED', 木: 'THU', 金: 'FRI', 土: 'SAT', 日: 'SUN' };
export const DAY_REV: Record<string, string> = Object.fromEntries(Object.entries(DAY_MAP).map(([k, v]) => [v, k]));

export type Freq = 'daily' | 'weekday' | 'weekly' | 'hourly' | 'interval';

export const FREQ_LABELS: Record<Freq, string> = {
  daily: '毎日（時刻指定）',
  weekday: '平日のみ（月〜金）',
  weekly: '毎週（曜日・時刻指定）',
  hourly: '毎時（分指定）',
  interval: 'N分ごと',
};

export function inferFreqFromCron(cron: string): Freq | null {
  const parts = cron.trim().split(/\s+/u);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  if (m.startsWith('*/')) return 'interval';
  if (h === '*' && dom === '*' && mon === '*' && dow === '*') return 'hourly';
  if (dom === '*' && mon === '*' && dow === 'MON-FRI') return 'weekday';
  if (dom === '*' && mon === '*' && dow === '*') return 'daily';
  if (dom === '*' && mon === '*') return 'weekly';
  return null;
}

export function validateCron(cron: string): boolean {
  if (cron.trim().split(/\s+/u).length !== 5) return false;
  try { new Cron(cron, { paused: true }); return true; } catch { return false; }
}

export function parseCron(freq: string, values: Record<string, string>): string | null {
  try {
    let cron: string;
    if (freq === 'daily' || freq === 'weekday' || freq === 'weekly') {
      const [hs, ms] = (values.time ?? '').trim().split(':');
      const h = Number.parseInt(hs ?? '', 10); const m = Number.parseInt(ms ?? '', 10);
      if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
      if (freq === 'daily') cron = `${m} ${h} * * *`;
      else if (freq === 'weekday') cron = `${m} ${h} * * MON-FRI`;
      else {
        const day = DAY_MAP[(values.day ?? '').trim()];
        if (!day) return null;
        cron = `${m} ${h} * * ${day}`;
      }
    } else if (freq === 'hourly') {
      const m = Number.parseInt((values.minute ?? '').trim(), 10);
      if (!Number.isInteger(m) || m < 0 || m > 59) return null;
      cron = `${m} * * * *`;
    } else if (freq === 'interval') {
      const n = Number.parseInt((values.interval ?? '').trim(), 10);
      if (!Number.isInteger(n) || n < 1 || n > 59) return null;
      cron = `*/${n} * * * *`;
    } else return null;
    return validateCron(cron) ? cron : null;
  } catch { return null; }
}

export function cronToFields(cron: string, freq: Freq): Record<string, string> {
  const parts = cron.trim().split(/\s+/u);
  if (parts.length !== 5) return {};
  const [m, h, , , dow] = parts as [string, string, string, string, string];
  const pad = (n: string) => String(Number.parseInt(n, 10)).padStart(2, '0');
  if (freq === 'daily' || freq === 'weekday') return { time: `${pad(h)}:${pad(m)}` };
  if (freq === 'weekly') return { time: `${pad(h)}:${pad(m)}`, day: DAY_REV[dow.toUpperCase()] ?? '月' };
  if (freq === 'hourly') return { minute: String(Number.parseInt(m, 10)) };
  if (freq === 'interval') return { interval: m.replace(/^\*\//u, '') };
  return {};
}

export function nextRunAt(cron: string, timezone: string, after: number): number | null {
  try {
    const next = new Cron(cron, { paused: true, timezone }).nextRun(new Date(after));
    return next ? next.getTime() : null;
  } catch { return null; }
}

export function describeCron(cron: string): string {
  const freq = inferFreqFromCron(cron);
  if (!freq) return cron;
  const f = cronToFields(cron, freq);
  switch (freq) {
    case 'daily': return `毎日 ${f.time}`;
    case 'weekday': return `平日 ${f.time}`;
    case 'weekly': return `毎週${f.day}曜 ${f.time}`;
    case 'hourly': return `毎時 ${f.minute} 分`;
    case 'interval': return `${f.interval} 分ごと`;
  }
}
