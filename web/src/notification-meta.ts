import type { IconName } from './icon-paths.ts';
import type { PlainKey } from './i18n/index.ts';
import { parseRoute, routeHash } from './routes.ts';

const ICONS: Record<string, IconName> = {
  approval_needed: 'shield', task_waiting: 'help', task_done: 'circleCheck', task_failed: 'circleX', health_alert: 'alert', info: 'info',
};

const KIND_LABELS: Record<string, PlainKey> = {
  task_done: 'notifications.kind.task_done',
  task_waiting: 'notifications.kind.task_waiting',
  task_failed: 'notifications.kind.task_failed',
  approval_needed: 'notifications.kind.approval_needed',
  health_alert: 'notifications.kind.health_alert',
  info: 'notifications.kind.info',
};

export const notificationIcon = (kind: string): IconName => ICONS[kind] ?? 'info';
export const notificationKindLabel = (kind: string): PlainKey | null => KIND_LABELS[kind] ?? null;

// 通知のリンクはデータベースに文字列で残っている（古い経路を含む）。画面の経路として読めるものだけを開く。
export function notificationLink(link: string | null): string | null {
  if (!link) return null;
  const canonical = routeHash(parseRoute(link));
  if (canonical === '#/') return link === '#/' ? link : null;
  return link === canonical || link.startsWith(`${canonical}/`) ? link : null;
}
