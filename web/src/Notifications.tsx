import { useEffect, useState } from 'react';
import { api, type NotificationItem } from './api.ts';
import { fmtTime } from './Tasks.tsx';

const KIND_LABEL: Record<string, string> = {
  task_done: '完了', task_waiting: '返事待ち', task_failed: '失敗', approval_needed: '承認が必要', health_alert: '調子が悪い', info: 'お知らせ',
};

export function NotificationsPage({ revision, onRead }: { revision: number; onRead: (unread: number) => void }) {
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  useEffect(() => { void api.notifications().then(r => { setItems(r.notifications); onRead(r.unread); }).catch(() => undefined); }, [revision, onRead]);
  const readAll = () => void api.readNotifications().then(r => {
    onRead(r.unread);
    setItems(list => list?.map(n => ({ ...n, read_at: n.read_at ?? Date.now() })) ?? null);
  });
  const open = (n: NotificationItem) => { if (!n.read_at) void api.readNotifications([n.id]).then(r => onRead(r.unread)); };
  return (
    <section className="page">
      <h1>通知</h1>
      <div className="row"><button className="secondary" onClick={readAll}>すべて既読にする</button></div>
      {!items ? <p className="muted">読み込み中…</p> : !items.length ? <p className="muted">通知はありません</p> : (
        <ul className="notification-list">
          {items.map(n => (
            <li key={n.id} className={n.read_at ? 'read' : 'unread'}>
              <span className={`badge ${n.kind === 'task_failed' || n.kind === 'health_alert' ? 'bad' : n.kind === 'task_done' ? 'ok' : 'warn'}`}>{KIND_LABEL[n.kind] ?? n.kind}</span>
              {n.link ? <a href={n.link} onClick={() => open(n)}>{n.title}</a> : <strong>{n.title}</strong>}
              <span className="muted small"> {fmtTime(n.created_at)}</span>
              {n.body && <p className="small pre">{n.body}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
