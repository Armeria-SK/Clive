import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type CuriosityItem, type Task } from './api.ts';
import { formatDateTime } from './i18n/index.ts';
import { ZoneNote } from './ZoneNote.tsx';

const errorText = (error: unknown) => (error instanceof ApiError ? error.message : '送れませんでした');

export function ReviewPage({ revision }: { revision: number }) {
  const [data, setData] = useState<{ taskProposals: Task[] } | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const reload = () => setTick(n => n + 1);
  useEffect(() => {
    void api.review().then(setData).catch(() => undefined);
  }, [revision, tick]);
  const act = (p: Promise<unknown>) => { setError(''); void p.then(reload, e => setError(errorText(e))); };

  return (
    <section className="page">
      <h1>レビュー</h1>
      <p><ZoneNote /></p>
      {error && <p className="error-text">{error}</p>}
      <h2>自発タスクの提案</h2>
      {!data ? null : !data.taskProposals.length ? <p className="muted small">提案はありません</p> : (
        <ul className="task-list">{data.taskProposals.map(t => (
          <li key={t.id}>
            <a href={`#/tasks/${t.id}`}>{t.title}</a>
            {t.body && <p className="small muted pre">{t.body}</p>}
            <div className="row">
              <button onClick={() => act(api.taskAction(t.id, 'approve'))}>承認</button>
              <button className="secondary" onClick={() => act(api.taskAction(t.id, 'cancel'))}>断る</button>
            </div>
          </li>
        ))}</ul>
      )}
    </section>
  );
}

const CURIOSITY_STATUS: Record<CuriosityItem['status'], string> = { open: '気になる', researching: '調べている', done: '調べた', dropped: 'やめた' };

export function CuriosityPage({ revision }: { revision: number }) {
  const [items, setItems] = useState<CuriosityItem[] | null>(null);
  const [all, setAll] = useState(false);
  const [topic, setTopic] = useState('');
  const [why, setWhy] = useState('');
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const reload = () => setTick(n => n + 1);
  useEffect(() => { void api.curiosity(all).then(r => setItems(r.items)).catch(() => undefined); }, [all, revision, tick]);
  const act = (p: Promise<unknown>) => { setError(''); void p.then(reload, e => setError(errorText(e))); };
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!topic.trim()) return;
    act(api.addCuriosity(topic.trim(), why.trim() || undefined).then(() => { setTopic(''); setWhy(''); }));
  };
  return (
    <section className="page">
      <h1>好奇心</h1>
      <p className="muted small">Clive が気になっていること。自発行動がオンのとき、Clive が自分で調べます（1日の上限は設定の worker.curiosityPerDay）。</p>
      <p><ZoneNote /></p>
      <form className="task-form" onSubmit={add}>
        <div className="row"><input value={topic} onChange={e => setTopic(e.target.value)} placeholder="気になること" maxLength={200} /><button type="submit" disabled={!topic.trim()}>足す</button></div>
        <input value={why} onChange={e => setWhy(e.target.value)} placeholder="なぜ気になるか（任意）" maxLength={500} />
      </form>
      {error && <p className="error-text">{error}</p>}
      <label className="toggle"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> 調べたもの・やめたものも見る</label>
      {!items ? <p className="muted">読み込み中…</p> : !items.length ? <p className="muted small">ありません</p> : (
        <ul className="task-list">{items.map(i => (
          <li key={i.id} className="task-row">
            <strong>{i.topic}</strong>
            <span className={`badge ${i.status === 'done' ? 'ok' : ''}`}>{CURIOSITY_STATUS[i.status]}</span>
            <span className="muted small">{i.source === 'user' ? 'あなた' : 'Clive'} ・ {formatDateTime(i.updated_at)}</span>
            {i.why && <p className="small muted">{i.why}</p>}
            {i.result && <p className="small pre">{i.result}</p>}
            <p className="row">
              {i.task_id && <a className="small" href={`#/tasks/${i.task_id}`}>タスクを見る</a>}
              {i.status === 'open' && <button className="link" onClick={() => act(api.curiosityTask(i.id))}>今すぐ調べてもらう</button>}
              {(i.status === 'open' || i.status === 'researching') && <button className="link" onClick={() => act(api.updateCuriosity(i.id, { status: 'dropped' }))}>やめる</button>}
              {(i.status === 'done' || i.status === 'dropped') && <button className="link" onClick={() => act(api.updateCuriosity(i.id, { status: 'open' }))}>また気にする</button>}
            </p>
          </li>
        ))}</ul>
      )}
    </section>
  );
}
