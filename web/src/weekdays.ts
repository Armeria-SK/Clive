import type { DictKey } from './i18n/index.ts';

export const WEEKDAYS = [
  { value: '月', label: 'weekday.mon' },
  { value: '火', label: 'weekday.tue' },
  { value: '水', label: 'weekday.wed' },
  { value: '木', label: 'weekday.thu' },
  { value: '金', label: 'weekday.fri' },
  { value: '土', label: 'weekday.sat' },
  { value: '日', label: 'weekday.sun' },
] as const satisfies ReadonlyArray<{ value: string; label: DictKey }>;
