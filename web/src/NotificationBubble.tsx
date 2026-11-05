import { useEffect, useRef, useState } from 'react';
import type { NotificationItem } from './api.ts';
import { useExit } from './hooks.ts';
import { useT } from './i18n/index.ts';
import { NotificationRow } from './NotificationRow.tsx';

interface Props {
  open: boolean;
  narrow: boolean;
  items: NotificationItem[] | null;
  failed: boolean;
  unread: number;
  onClose: () => void;
  onReadAll: () => void;
  onOpenItem: (item: NotificationItem) => void;
  onSeeAll: () => void;
}

export const BUBBLE_LIMIT = 8;
const EXIT_MS = 160;

export function NotificationBubble(props: Props) {
  const { mounted, leaving } = useExit(props.open, EXIT_MS);
  if (!mounted) return null;
  return <BubbleDialog {...props} leaving={leaving} />;
}

function BubbleDialog({ narrow, items, failed, unread, leaving, onClose, onReadAll, onOpenItem, onSeeAll }: Props & { leaving: boolean }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [before] = useState(() => document.activeElement);
  useEffect(() => {
    box.current?.focus();
    return () => { if (before instanceof HTMLElement && before.isConnected) before.focus(); };
  }, [before]);
  const shown = items?.slice(0, BUBBLE_LIMIT) ?? [];
  return (
    <>
      <div className="notif-catcher" onClick={onClose} />
      <div className={`notif-bubble${narrow ? ' notif-top' : ''}${leaving ? ' leaving' : ''}`} role="dialog" aria-label={t('notifications.title')} tabIndex={-1} ref={box}>
        <div className="notif-head">
          <span className="notif-head-title">{t('notifications.title')}</span>
          <span className="notif-head-unread">{t('notifications.unread', unread)}</span>
          <button className="notif-readall" onClick={onReadAll} disabled={unread === 0}>{t('notifications.readAll')}</button>
        </div>
        <div className="notif-list">
          {!items ? <p className="notif-note">{failed ? t('notifications.failed') : t('notifications.loading')}</p>
            : !shown.length ? <p className="notif-note">{t('notifications.empty')}</p>
            : shown.map(item => <NotificationRow key={item.id} item={item} variant="bubble" onOpen={onOpenItem} />)}
        </div>
        <div className="notif-foot"><a href="#/notifications" onClick={onSeeAll}>{t('notifications.seeAll')}</a></div>
      </div>
    </>
  );
}
