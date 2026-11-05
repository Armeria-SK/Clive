import type { NotificationItem } from './api.ts';
import { useT } from './i18n/index.ts';
import { NotificationRow } from './NotificationRow.tsx';
import { ZoneNote } from './ZoneNote.tsx';

interface Props {
  items: NotificationItem[] | null;
  failed: boolean;
  unread: number;
  onReadAll: () => void;
  onOpenItem: (item: NotificationItem) => void;
}

// 通知のタブ。吹き出しの「すべて見る」と、古い経路 #/notifications から開く。
export function NotificationsPage({ items, failed, unread, onReadAll, onOpenItem }: Props) {
  const t = useT();
  return (
    <section className="view">
      <div className="view-inner">
        <div className="view-head">
          <div className="view-titles">
            <h1 className="view-title">{t('notifications.title')}</h1>
            <span className="view-sub">{t('notifications.subtitle')}</span>
          </div>
          <div className="view-actions">
            <span className="view-count">{t('notifications.unread', unread)}</span>
            <button className="btn btn-secondary" onClick={onReadAll} disabled={unread === 0}>{t('notifications.readAll')}</button>
          </div>
        </div>
        <p className="view-zone"><ZoneNote /></p>
        {!items ? <p className="view-note">{failed ? t('notifications.failed') : t('notifications.loading')}</p>
          : !items.length ? <p className="view-note">{t('notifications.empty')}</p>
          : <div className="notif-page-list">{items.map(item => <NotificationRow key={item.id} item={item} variant="page" onOpen={onOpenItem} />)}</div>}
      </div>
    </section>
  );
}
