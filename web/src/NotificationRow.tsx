import type { NotificationItem } from './api.ts';
import { formatDateTime, formatRelative, useT } from './i18n/index.ts';
import { Icon } from './icons.tsx';
import { notificationIcon, notificationKindLabel } from './notification-meta.ts';

interface Props {
  item: NotificationItem;
  variant: 'bubble' | 'page';
  onOpen: (item: NotificationItem) => void;
}

// 通知 1 件の行。吹き出し（本文は 1 行、時間は相対）と、通知のページ（本文は全部、日時）で同じ部品を使う。
export function NotificationRow({ item, variant, onOpen }: Props) {
  const t = useT();
  const unread = !item.read_at;
  const kind = notificationKindLabel(item.kind);
  return (
    <button className={`notif-row notif-row-${variant}${unread ? ' unread' : ''}`} onClick={() => onOpen(item)}>
      <span className="notif-icon"><Icon name={notificationIcon(item.kind)} size={15} /></span>
      <span className="notif-text">
        <span className="notif-title">{item.title}</span>
        {item.body && <span className="notif-body">{item.body}</span>}
        {variant === 'page' && <span className="tag tag-neutral notif-kind">{kind ? t(kind) : item.kind}</span>}
      </span>
      <span className="notif-meta">
        <span className="notif-time">{variant === 'bubble' ? formatRelative(item.created_at) : formatDateTime(item.created_at)}</span>
        {unread && <span className="notif-dot"><span className="sr-only">{t('notifications.unreadMark')}</span></span>}
      </span>
    </button>
  );
}
