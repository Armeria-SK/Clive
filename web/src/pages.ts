import type { IconName } from './icon-paths.ts';
import type { PlainKey } from './i18n/index.ts';
import type { Page } from './routes.ts';
import type { ModelView, WorkerStatus } from './api.ts';

export const PAGE_META: Record<Page, { label: PlainKey; icon: IconName }> = {
  chat: { label: 'tab.newChat', icon: 'msg' },
  tasks: { label: 'nav.tasks', icon: 'tasks' },
  today: { label: 'nav.activity', icon: 'panel' },
  notifications: { label: 'nav.notifications', icon: 'bell' },
  settings: { label: 'nav.settings', icon: 'sliders' },
  runs: { label: 'nav.runs', icon: 'activity' },
  memory: { label: 'nav.memory', icon: 'bookmark' },
  review: { label: 'nav.review', icon: 'circleCheck' },
  skills: { label: 'nav.skills', icon: 'wrench' },
};

export type WorkerState = 'disabled' | 'paused' | 'running' | 'quiet' | 'idle';

export function workerState(worker: WorkerStatus | null): WorkerState {
  if (!worker || !worker.enabled) return 'disabled';
  if (worker.paused) return 'paused';
  if (worker.running) return 'running';
  if (worker.quiet) return 'quiet';
  return 'idle';
}

export const WORKER_STATE_LABEL: Record<WorkerState, PlainKey> = {
  disabled: 'worker.disabled', paused: 'worker.paused', running: 'worker.running', quiet: 'worker.quiet', idle: 'worker.idle',
};

// 状態バーに出すモデル: チャットの並びの先頭で、使えるもの（なければ並びの先頭）。
export function pickChatModel(models: readonly ModelView[], routing: { chat: readonly string[] }): string | null {
  const ordered = routing.chat.map(id => models.find(m => m.id === id)).filter((m): m is ModelView => m !== undefined);
  const usable = ordered.find(m => m.probe?.status === 'ok') ?? ordered[0];
  return usable ? usable.model : null;
}
