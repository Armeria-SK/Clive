import { useEffect, useState } from 'react';
import { api, type Conversation } from './api.ts';
import { useNow } from './hooks.ts';
import { formatRelativeCompact, useT } from './i18n/index.ts';
import { chatHash } from './routes.ts';

interface Props {
  // アーカイブ・戻す・削除のたびに増える（一覧を取り直す合図）
  revision: number;
  onRestore: (conversation: Conversation) => void;
  onDelete: (conversation: Conversation) => void;
}

// アーカイブした会話の一覧。題で探せる。開いて読める・元に戻す・削除（確かめを挟む）
export function ArchivedPage({ revision, onRestore, onDelete }: Props) {
  const t = useT();
  const now = useNow(30_000);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void api.archivedConversations(query).then(
        r => { if (live) { setItems(r.conversations); setFailed(false); } },
        () => { if (live) setFailed(true); },
      );
    }, query ? 200 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [query, revision]);

  return (
    <section className="view">
      <div className="view-inner">
        <div className="view-head">
          <div className="view-titles">
            <h1 className="view-title">{t('archived.title')}</h1>
            <span className="view-sub">{t('archived.subtitle')}</span>
          </div>
        </div>
        <input type="search" className="input archived-search" value={query} placeholder={t('archived.search')} aria-label={t('archived.search')} onChange={e => setQuery(e.target.value)} />
        {items === null ? <p className="view-note">{failed ? t('archived.failed') : t('archived.loading')}</p>
          : !items.length ? <p className="view-note">{query.trim() ? t('archived.noMatch') : t('archived.empty')}</p>
          : (
            <ul className="archived-list">
              {items.map(c => (
                <li key={c.id} className="archived-row">
                  <a className="archived-open" href={chatHash(c.id)}>
                    <span className="archived-title">{c.title ?? t('conversation.untitled')}</span>
                    <span className="archived-time">{formatRelativeCompact(c.last_message_at, now)}</span>
                  </a>
                  <button type="button" className="btn btn-secondary" onClick={() => onRestore(c)}>{t('archived.restore')}</button>
                  <button type="button" className="btn btn-ghost archived-delete" onClick={() => onDelete(c)}>{t('conv.delete')}</button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </section>
  );
}
