import { useEffect, useState } from 'react';
import { api, ApiError, type Book, type BookView, type HistoryHit, type MemoryEvent, type MemoryItem } from './api.ts';
import { formatDateTime, formatNumber } from './i18n/index.ts';
import { ZoneNote } from './ZoneNote.tsx';

const BOOK_TITLE: Record<Book, string> = { user: 'ユーザーについての記憶', notes: 'Clive のメモと教訓' };
const ACTION: Record<string, string> = { create: '作成', update: '書き直し', forget: '削除', restore: '復元' };
const ACTOR: Record<string, string> = { clive: 'Clive', user: 'あなた', review: '振り返り' };
const time = (ms: number) => formatDateTime(ms, 'full');

function Item({ item, onChanged, setError }: { item: MemoryItem; onChanged: () => void; setError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.content);
  const [events, setEvents] = useState<MemoryEvent[] | null>(null);
  const run = async (work: () => Promise<unknown>) => {
    setError('');
    try { await work(); onChanged(); } catch (e) { setError(e instanceof ApiError ? e.message : '失敗しました'); }
  };
  return (
    <li className="memory-item">
      {editing ? (
        <div className="row">
          <input value={text} onChange={e => setText(e.target.value)} maxLength={600} aria-label="記憶の内容" />
          <button onClick={() => void run(async () => { await api.editMemory(item.id, text); setEditing(false); })}>保存</button>
          <button className="secondary" onClick={() => { setText(item.content); setEditing(false); }}>やめる</button>
        </div>
      ) : (
        <div className="memory-line">
          <code className="muted">[{item.book === 'user' ? 'u' : 'n'}{item.id}]</code>
          <span className="memory-content">{item.content}</span>
          <span className="memory-actions">
            <button className="link" onClick={() => setEditing(true)}>編集</button>
            <button className="link" onClick={() => void run(() => api.forgetMemory(item.id))}>削除</button>
            <button className="link" onClick={() => void api.memoryEvents(item.id).then(r => setEvents(events ? null : r.events))}>履歴</button>
          </span>
        </div>
      )}
      <p className="muted small">
        {item.origin === 'user' ? 'あなたが追加' : item.origin === 'review' ? '振り返りで追加' : '会話の中で Clive が記憶'}・{time(item.updated_at)}
        {item.source_conversation_id && <> ・<a href={`#/c/${encodeURIComponent(item.source_conversation_id)}`}>元の会話</a></>}
      </p>
      {events && (
        <ul className="memory-events">
          {events.map(e => (
            <li key={e.id}>
              {time(e.created_at)} {ACTOR[e.actor] ?? e.actor}が{ACTION[e.action] ?? e.action}
              {e.action === 'update' && <span className="muted">（前: {e.before}）</span>}
              {e.reason && <span className="muted">（{e.reason}）</span>}
              {!e.undone_at && e.action !== 'restore' && <button className="link" onClick={() => void run(() => api.undoMemory(e.id))}>取り消す</button>}
              {e.undone_at && <span className="muted">（取り消し済み）</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function Memory() {
  const [books, setBooks] = useState<Record<Book, BookView> | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<Record<Book, string>>({ user: '', notes: '' });
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<HistoryHit[] | null>(null);

  const load = () => { void api.memories().then(r => setBooks(r.books)).catch(() => setError('読み込めませんでした')); };
  useEffect(load, []);

  async function add(book: Book) {
    setError('');
    try { await api.addMemory(book, adding[book]); setAdding(a => ({ ...a, [book]: '' })); load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : '追加できませんでした'); }
  }

  if (!books) return <section className="page"><p className="muted">読み込み中…</p></section>;
  return (
    <section className="page">
      <h1>記憶</h1>
      <p className="muted">Clive が会話の中で覚えたことです。次の会話から使われます。上限を超えると、Clive は似た記憶をまとめるか消してから覚えます。<ZoneNote /></p>
      {error && <div className="error-panel"><p>{error}</p></div>}
      {(['user', 'notes'] as const).map(book => {
        const b = books[book];
        return (
          <div key={book} className="book">
            <h2>{BOOK_TITLE[book]} <span className="muted small">{formatNumber(b.used)} / {formatNumber(b.max)} 文字</span></h2>
            <div className="meter" aria-hidden><span style={{ width: `${Math.min(100, (b.used / b.max) * 100)}%` }} className={b.used / b.max > 0.9 ? 'high' : ''} /></div>
            {b.items.length ? <ul className="memory-list">{b.items.map(m => <Item key={m.id} item={m} onChanged={load} setError={setError} />)}</ul> : <p className="muted">まだありません</p>}
            <div className="row">
              <input value={adding[book]} onChange={e => setAdding(a => ({ ...a, [book]: e.target.value }))} placeholder="自分で書き足す" maxLength={600} aria-label={`${BOOK_TITLE[book]}に追加`} />
              <button onClick={() => void add(book)} disabled={!adding[book].trim()}>追加</button>
            </div>
          </div>
        );
      })}

      <h2>過去の会話を探す</h2>
      <form className="row" onSubmit={e => { e.preventDefault(); void api.history(query).then(r => setHits(r.hits)); }}>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="言葉で探す（例: ベクトル検索）" aria-label="過去の会話を検索" />
        <button type="submit" disabled={!query.trim()}>探す</button>
      </form>
      {hits && (hits.length ? (
        <ul className="history-hits">
          {hits.map(h => (
            <li key={h.messageId}>
              <a href={`#/c/${encodeURIComponent(h.conversationId)}`}>{h.title ?? '（無題）'}</a> <span className="muted small">{time(h.createdAt)}・{h.role === 'user' ? 'あなた' : h.role === 'assistant' ? 'Clive' : 'ツール'}</span>
              <p className="snippet">{h.snippet}</p>
            </li>
          ))}
        </ul>
      ) : <p className="muted">見つかりませんでした</p>)}
    </section>
  );
}
