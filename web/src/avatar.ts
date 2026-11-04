
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

export function presenceOf(p: Presence): { runtime: Runtime; sleeping: boolean; line: string } {
  if (p.celebrating) return { runtime: 'celebrate', sleeping: false, line: 'タスクを終えました' };
  if (p.generating) return { runtime: 'work', sleeping: false, line: '返事を考えています' };
  if (p.runningTask) return { runtime: 'work', sleeping: false, line: `タスク「${p.runningTask}」を進めています` };
  if (p.approvals) return { runtime: 'wait', sleeping: false, line: `承認を待っています（${p.approvals} 件）` };
  if (p.waitingTasks) return { runtime: 'wait', sleeping: false, line: `返事を待っています（${p.waitingTasks} 件）` };
  if (p.paused) return { runtime: 'idle', sleeping: true, line: 'お休み中（ワーカーを一時停止しています）' };
  if (p.quiet) return { runtime: 'idle', sleeping: true, line: 'お休み中（静かにする時間帯です）' };
  return { runtime: 'idle', sleeping: false, line: 'ひと休みしています' };
}
