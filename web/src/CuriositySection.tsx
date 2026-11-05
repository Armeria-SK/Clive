import { useEffect, useState, type FormEvent } from 'react';
import { api, type CuriosityItem } from './api.ts';
import { formatDateTime, useT } from './i18n/index.ts';
import { usePending } from './pending.ts';
import { SectionHead } from './TaskSection.tsx';
import { CURIOSITY_STATUS_KEY } from './task-meta.ts';
import { reportTaskError } from './task-actions.ts';

interface Props {
  open: boolean;
  revision: number;
  onToggle: () => void;
}

const isActive = (item: CuriosityItem): boolean => item.status === 'open' || item.status === 'researching';

// タスクの一番下の「気になること」。Clive が気になっていることの一覧・追加・今すぐ調べてもらう・やめる。
export function CuriositySection({ open, revision, onToggle }: Props) {
  const t = useT();
  const [items, setItems] = useState<CuriosityItem[] | null>(null);
  const [all, setAll] = useState(false);
  const [topic, setTopic] = useState('');
  const [why, setWhy] = useState('');
  const [tick, setTick] = useState(0);
  const { pending, run } = usePending();
  const reload = () => setTick(n => n + 1);

  useEffect(() => { void api.curiosity(all).then(r => setItems(r.items)).catch(() => undefined); }, [all, revision, tick]);

  // 追加と、1 件ごとの操作は、それぞれ 1 つずつ（送信中は同じものを 2 回送らない）
  const act = (key: string, send: () => Promise<unknown>) => run(key, async () => {
    try { await send(); reload(); } catch (error) { reportTaskError(error); }
  });
  const add = (e: FormEvent) => {
    e.preventDefault();
    const text = topic.trim();
    if (!text) return;
    void act('add', async () => { await api.addCuriosity(text, why.trim() || undefined); setTopic(''); setWhy(''); });
  };
  const count = items ? items.filter(isActive).length : 0;

  return (
    <div className={`tk-sec${open ? ' open' : ''}`} id="tk-curiosity">
      <SectionHead open={open} label={t('tasks.section.curiosity')} count={count} hint={t('tasks.section.curiosity.hint')} onToggle={onToggle} />
      {open && (
        <div className="tk-curbody">
          <p className="tk-note">{t('curiosity.note')}</p>
          <form className="tk-curform" onSubmit={add}>
            <input className="input" value={topic} onChange={e => setTopic(e.target.value)} placeholder={t('curiosity.topic')} aria-label={t('curiosity.topic')} maxLength={200} />
            <input className="input" value={why} onChange={e => setWhy(e.target.value)} placeholder={t('curiosity.why')} aria-label={t('curiosity.why')} maxLength={500} />
            <button className="btn btn-primary" type="submit" disabled={pending.has('add') || !topic.trim()}>{t('curiosity.add')}</button>
          </form>
          <label className="tk-showall"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} />{t('curiosity.showAll')}</label>
          {!items ? <p className="tk-note">{t('tasks.loading')}</p> : !items.length ? <p className="tk-note">{t('curiosity.empty')}</p> : (
            <div className="tk-curlist">
              {items.map(item => (
                <div key={item.id} className="tk-cur">
                  <div className="tk-cur-head">
                    <span className="tk-cur-topic">{item.topic}</span>
                    <span className={`tk-tag${item.status === 'done' ? ' ok' : item.status === 'dropped' ? '' : ' accent'}`}>{t(CURIOSITY_STATUS_KEY[item.status])}</span>
                    <span className="tk-cur-meta">{item.source === 'user' ? t('tasks.origin.user') : t('tasks.origin.self')} · {formatDateTime(item.updated_at)}</span>
                  </div>
                  {item.why && <p className="tk-cur-why">{item.why}</p>}
                  {item.result && <p className="tk-cur-result">{item.result}</p>}
                  <div className="tk-cur-actions">
                    {item.task_id && <a href={`#/tasks/${encodeURIComponent(item.task_id)}`}>{t('curiosity.viewTask')}</a>}
                    {item.status === 'open' && <button className="btn btn-secondary" disabled={pending.has(`item:${item.id}`)} onClick={() => void act(`item:${item.id}`, () => api.curiosityTask(item.id))}>{t('curiosity.research')}</button>}
                    {isActive(item) && <button className="btn btn-ghost" disabled={pending.has(`item:${item.id}`)} onClick={() => void act(`item:${item.id}`, () => api.updateCuriosity(item.id, { status: 'dropped' }))}>{t('curiosity.drop')}</button>}
                    {(item.status === 'done' || item.status === 'dropped') && <button className="btn btn-ghost" disabled={pending.has(`item:${item.id}`)} onClick={() => void act(`item:${item.id}`, () => api.updateCuriosity(item.id, { status: 'open' }))}>{t('curiosity.reopen')}</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
