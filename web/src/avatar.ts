import { t } from './i18n/index.ts';

export interface AvatarParts { body: string; eyes: string[] }

export function avatarParts(svg: string): AvatarParts {
  const d = /<path\b[^>]*\sd="([^"]+)"/u.exec(String(svg))?.[1] ?? '';
  const [body = '', ...eyes] = d.split(/(?=M)/u).map(part => part.trim()).filter(Boolean);
  return { body, eyes };
}

export type Runtime = 'work' | 'wait' | 'idle' | 'celebrate';
export type AvatarMotion = Runtime | 'sleep' | 'none' | 'float' | 'sway' | 'pulse';

export function avatarMotion(options: { preference?: string; runtime?: Runtime; sleeping?: boolean; preview?: boolean }): AvatarMotion {
  const { preference = 'auto', runtime, sleeping = false, preview = false } = options;
  if (sleeping) return 'sleep';
  if (preference === 'none') return 'none';
  if (preference !== 'auto') return preference as AvatarMotion;
  if (preview) return 'work';
  return runtime ?? 'idle';
}

export function blinkTiming(seed: string): { period: number; delay: number } {
  let hash = 0;
  for (const char of String(seed || '')) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return { period: 4.2 + (hash % 25) / 10, delay: -((hash >>> 5) % 60) / 10 };
}

export interface Presence {
  generating: boolean;
  runningTask: string | null;
  approvals: number;
  waitingTasks: number;
  paused: boolean;
  quiet: boolean;
  celebrating: boolean;
}

const TITLE_CHARS = 14;
const cut = (text: string, n: number): string => {
  const chars = [...text];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : text;
};

export function presenceOf(p: Presence): { runtime: Runtime; sleeping: boolean; line: string } {
  if (p.celebrating) return { runtime: 'celebrate', sleeping: false, line: t('presence.celebrate') };
  if (p.generating) return { runtime: 'work', sleeping: false, line: t('presence.generating') };
  if (p.runningTask) return { runtime: 'work', sleeping: false, line: t('presence.task', cut(p.runningTask, TITLE_CHARS)) };
  if (p.approvals) return { runtime: 'wait', sleeping: false, line: t('presence.approvals', p.approvals) };
  if (p.waitingTasks) return { runtime: 'wait', sleeping: false, line: t('presence.waiting', p.waitingTasks) };
  if (p.paused) return { runtime: 'idle', sleeping: true, line: t('presence.paused') };
  if (p.quiet) return { runtime: 'idle', sleeping: true, line: t('presence.quiet') };
  return { runtime: 'idle', sleeping: false, line: t('presence.idle') };
}
