import { arrangeNotifications, NOTIFICATION_LIST_LIMIT } from '../../src/shared/notification-list.ts';
import type { NotificationItem } from './api.ts';
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
// #/curiosity はタスクの節に移ったが、古い通知のために今も通す。
export function notificationLink(link: string | null): string | null {
  if (!link) return null;
  const route = parseRoute(link);
  const canonical = route.page === 'tasks' && route.section ? `#/${route.section}` : routeHash(route);
  if (canonical === '#/') return link === '#/' ? link : null;
  return link === canonical || link.startsWith(`${canonical}/`) ? link : null;
}

// 画面の一覧に、届いた通知を足す。サーバーの一覧と同じ並べ方（承認待ちなどの未読は先頭に残る）
export const withNotification = (list: readonly NotificationItem[] | null, added: NotificationItem): NotificationItem[] =>
  arrangeNotifications([added, ...(list ?? [])], NOTIFICATION_LIST_LIMIT);

// ids を既読にする（ids が無ければ全部）。既読になった通知は先頭から外れる。新しい 50 件の中なら新しい順の場所に戻り、それより古いものは一覧から消える
export const withRead = (list: readonly NotificationItem[] | null, ids: readonly number[] | undefined, now: number): NotificationItem[] | null =>
  list && arrangeNotifications(list.map(n => (!ids || ids.includes(n.id) ? { ...n, read_at: n.read_at ?? now } : n)), NOTIFICATION_LIST_LIMIT);
