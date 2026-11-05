import { useCallback, useEffect, useId, useState } from 'react';
import { api, ApiError, type Book, type BookView, type HistoryHit, type MemoryEvent, type MemoryItem } from './api.ts';
import { formatDateTime, formatNumber, useT } from './i18n/index.ts';
import { isComposing } from './keys.ts';
import { actionKey, actorKey, BOOK_TAB_KEY, canUndo, MEMORY_TABS, memoryRef, originKey, roleKey, TAB_KEY, type MemoryTab } from './memory-page.ts';
import { usageFraction, usageIsHigh } from './usage.ts';
import { ZoneNote } from './ZoneNote.tsx';
import './styles/memory.css';

const BOOKS: readonly Book[] = ['user', 'notes'];
const SETTINGS_SECTION_KEY = 'clive.settingsSection';
const time = (ms: number) => formatDateTime(ms, 'full');

// 記憶のページ（左の一覧の「記憶」。#/memory）。2 冊の一覧と、過去の会話の検索を、デザインの「スキル・ツール」と同じ並びで出す。
// revision が増えたら（会話の中で記憶が変わったら）読み直す。
export function Memory({ revision = 0 }: { revision?: number }) {
  const t = useT();
  const tabsName = useId();
  const [books, setBooks] = useState<Record<Book, BookView> | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<MemoryTab>('user');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    void api.memories().then(r => { setBooks(r.books); setFailed(false); }).catch(() => setFailed(true));
  }, []);
  useEffect(load, [load, revision]);

  return (
    <section className="view">
      <div className="view-inner">
        <div className="view-head">
          <div className="view-titles">
            <h1 className="view-title">{t('memory.title')}</h1>
            <span className="view-sub">{t('memory.subtitle')}</span>
          </div>
          <div className="seg view-actions" role="radiogroup" aria-label={t('memory.tabs')}>
            {MEMORY_TABS.map(id => (
              <label className="seg-opt mem-seg-opt" key={id}>
                <input type="radio" name={tabsName} checked={tab === id} onChange={() => { setTab(id); setError(''); }} />
                {t(TAB_KEY[id])}
                {id !== 'search' && books && <span className="mem-seg-count">{books[id].items.length}</span>}
              </label>
            ))}
          </div>
        </div>
        <p className="view-zone"><ZoneNote /></p>
        {error && <div className="mem-error" role="alert">{error}</div>}
        {tab === 'search' ? <HistorySearch />
          : !books ? (
            <div className="view-note">
              {failed ? t('memory.loadFailed') : t('memory.loading')}
              {failed && <> <button className="btn btn-secondary" onClick={load}>{t('memory.retry')}</button></>}
            </div>
          )
            : <BookPanel key={tab} book={tab} view={books[tab]} onChanged={load} setError={setError} />}
      </div>
    </section>
  );
}

function BookPanel({ book, view, onChanged, setError }: { book: Book; view: BookView; onChanged: () => void; setError: (message: string) => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const title = t(BOOK_TAB_KEY[book]);
  const fraction = usageFraction(view.used, view.max);

  async function add() {
    if (!text.trim()) return;
    setError('');
    try { await api.addMemory(book, text); setText(''); onChanged(); }
    catch (e) { setError(e instanceof ApiError ? e.message : t('memory.addFailed')); }
  }
  const openLimits = () => {
    try { sessionStorage.setItem(SETTINGS_SECTION_KEY, 'memory'); } catch { }
    location.hash = '#/settings';
  };

  return (
    <>
      <div className="mem-usage">
        <div className="mem-usage-line">
          <span className="mem-usage-text">{t('memory.usage', formatNumber(view.used), formatNumber(view.max))}</span>
          <button className="btn btn-ghost" onClick={openLimits}>{t('memory.limitLink')}</button>
        </div>
        <div className="mem-meter" aria-hidden="true"><div className={usageIsHigh(view.used, view.max) ? 'high' : undefined} style={{ width: `${fraction * 100}%` }} /></div>
        <span className="mem-hint">{t('memory.limitNote')}</span>
      </div>
      <div className="mem-add">
        <input
          className="input" value={text} onChange={e => setText(e.target.value)} placeholder={t('memory.add.placeholder')} maxLength={600} aria-label={t('memory.add.label', title)}
          onKeyDown={e => { if (e.key === 'Enter' && !isComposing(e.nativeEvent)) { e.preventDefault(); void add(); } }}
        />
        <button className="btn btn-secondary" onClick={() => void add()} disabled={!text.trim()}>{t('memory.add.button')}</button>
      </div>
      {view.items.length
        ? <ul className="mem-list">{view.items.map(item => <Item key={item.id} item={item} onChanged={onChanged} setError={setError} />)}</ul>
        : <p className="view-note">{t('memory.empty')}</p>}
    </>
  );
}

function Item({ item, onChanged, setError }: { item: MemoryItem; onChanged: () => void; setError: (message: string) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.content);
  const [events, setEvents] = useState<MemoryEvent[] | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);

  const run = async (work: () => Promise<unknown>) => {
    setError('');
    try { await work(); onChanged(); } catch (e) { setError(e instanceof ApiError ? e.message : t('memory.actionFailed')); }
  };
  const toggleHistory = () => {
    if (events) { setEvents(null); return; }
    setHistoryFailed(false);
    void api.memoryEvents(item.id).then(r => setEvents(r.events)).catch(() => setHistoryFailed(true));
  };
  const save = () => void run(async () => { await api.editMemory(item.id, text); setEditing(false); });
  const label = (key: ReturnType<typeof actionKey>, raw: string) => (key ? t(key) : raw);

  return (
    <li className="mem-item">
      {editing ? (
        <div className="mem-edit">
          <input
            className="input" value={text} onChange={e => setText(e.target.value)} maxLength={600} aria-label={t('memory.contentLabel')} autoFocus
            onKeyDown={e => { if (e.key === 'Enter' && !isComposing(e.nativeEvent)) { e.preventDefault(); save(); } }}
          />
          <button className="btn btn-primary" onClick={save} disabled={!text.trim()}>{t('memory.save')}</button>
          <button className="btn btn-ghost" onClick={() => { setText(item.content); setEditing(false); }}>{t('memory.cancel')}</button>
        </div>
      ) : (
        <div className="mem-row">
          <span className="mem-content">{item.content}</span>
          <span className="mem-actions">
            <button className="btn btn-ghost" onClick={() => setEditing(true)}>{t('memory.edit')}</button>
            <button className="btn btn-ghost" onClick={() => void run(() => api.forgetMemory(item.id))}>{t('memory.forget')}</button>
            <button className="btn btn-ghost" onClick={toggleHistory} aria-expanded={events !== null}>{t('memory.history')}</button>
          </span>
        </div>
      )}
      <div className="mem-meta">
        <span className="mem-ref">{memoryRef(item)}</span>
        <span>{t(originKey(item.origin))}</span>
        <span>{time(item.updated_at)}</span>
        {item.source_conversation_id && <a href={`#/c/${encodeURIComponent(item.source_conversation_id)}`}>{t('memory.sourceConversation')}</a>}
      </div>
      {historyFailed && <p className="mem-hint">{t('memory.event.loadFailed')}</p>}
      {events && (
        <ul className="mem-events">
          {events.map(e => (
            <li key={e.id}>
              <span>{t('memory.event.line', time(e.created_at), label(actorKey(e.actor), e.actor), label(actionKey(e.action), e.action))}</span>
              {e.action === 'update' && e.before !== null && <span className="mem-dim">{t('memory.event.before', e.before)}</span>}
              {e.reason && <span className="mem-dim">（{e.reason}）</span>}
              {canUndo(e) && <button className="btn btn-ghost" onClick={() => void run(async () => { await api.undoMemory(e.id); setEvents(null); })}>{t('memory.event.undo')}</button>}
              {Boolean(e.undone_at) && <span className="mem-dim">{t('memory.event.undone')}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function HistorySearch() {
  const t = useT();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<HistoryHit[] | null>(null);
  const [failed, setFailed] = useState(false);

  const search = () => {
    if (!query.trim()) return;
    setFailed(false);
    void api.history(query).then(r => setHits(r.hits)).catch(() => { setHits(null); setFailed(true); });
  };

  return (
    <>
      <span className="mem-hint">{t('memory.search.hint')}</span>
      <div className="mem-add">
        <input
          className="input" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('memory.search.placeholder')} aria-label={t('memory.search.label')}
          onKeyDown={e => { if (e.key === 'Enter' && !isComposing(e.nativeEvent)) { e.preventDefault(); search(); } }}
        />
        <button className="btn btn-secondary" onClick={search} disabled={!query.trim()}>{t('memory.search.button')}</button>
      </div>
      {failed && <p className="view-note">{t('memory.search.failed')}</p>}
      {hits && (hits.length ? (
        <ul className="mem-list">
          {hits.map(h => {
            const role = roleKey(h.role);
            return (
              <li key={h.messageId} className="mem-item">
                <div className="mem-row">
                  <a className="mem-hit-title" href={`#/c/${encodeURIComponent(h.conversationId)}`}>{h.title ?? t('conversation.untitled')}</a>
                  <span className="mem-hit-meta">{time(h.createdAt)} · {role ? t(role) : h.role}</span>
                </div>
                <p className="mem-snippet">{h.snippet}</p>
              </li>
            );
          })}
        </ul>
      ) : <p className="view-note">{t('memory.search.none')}</p>)}
    </>
  );
}
