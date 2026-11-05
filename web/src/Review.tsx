import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type ReviewJob, type SkillDraft, type SkillSummary } from './api.ts';
import { formatDateTime } from './i18n/index.ts';
import { ZoneNote } from './ZoneNote.tsx';

const errorText = (error: unknown) => (error instanceof ApiError ? error.message : '送れませんでした');

export function ReviewPage({ revision }: { revision: number }) {
  const [data, setData] = useState<{ skillDrafts: SkillDraft[] } | null>(null);
  const [jobs, setJobs] = useState<{ jobs: ReviewJob[]; pending: number } | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const reload = () => setTick(n => n + 1);
  useEffect(() => {
    void api.review().then(setData).catch(() => undefined);
    void api.reviews().then(setJobs).catch(() => undefined);
  }, [revision, tick]);
  const act = (p: Promise<unknown>) => { setError(''); void p.then(reload, e => setError(errorText(e))); };

  return (
    <section className="page">
      <h1>レビュー</h1>
      <p><ZoneNote /></p>
      {error && <p className="error-text">{error}</p>}
      <h2>スキルの下書き</h2>
      {!data ? <p className="muted">読み込み中…</p> : !data.skillDrafts.length ? <p className="muted small">承認待ちの下書きはありません</p> : data.skillDrafts.map(d => (
        <div key={d.id} className="draft">
          <p><strong>{d.name}</strong> <span className="badge">{d.current ? '修正' : '新規'}</span> <span className="muted small">{formatDateTime(d.created_at)}</span></p>
          {d.reason && <p className="small">理由: {d.reason}</p>}
          <div className={d.current ? 'diff' : ''}>
            {d.current && (
              <div><p className="muted small">いまの内容</p><p className="small">{d.current.description}</p><pre>{d.current.body}</pre></div>
            )}
            <div><p className="muted small">{d.current ? '直したあと' : '内容'}</p><p className="small">{d.description}</p><pre>{d.body}</pre></div>
          </div>
          <div className="row">
            <button onClick={() => act(api.approveDraft(d.id))}>承認して有効にする</button>
            <button className="secondary" onClick={() => act(api.rejectDraft(d.id))}>却下</button>
          </div>
        </div>
      ))}

      <h2>振り返りの記録{jobs?.pending ? <span className="muted small">（待ち {jobs.pending} 件）</span> : null}</h2>
      <p className="muted small">会話やタスクの後に、Clive が記憶を整理した記録です。変更は「記憶」の画面から取り消せます。</p>
      {!jobs ? null : !jobs.jobs.length ? <p className="muted small">まだありません</p> : (
        <ul className="task-events">{jobs.jobs.map(j => (
          <li key={j.id}>
            <span className="muted small">{formatDateTime(j.created_at)} {j.triggerLabel} ・ {j.status === 'done' ? '済み' : j.status === 'failed' ? '失敗' : j.status === 'running' ? '実行中' : '待ち'}</span>
            {j.note && <span className="pre"> {j.note}</span>}
            {j.changes.length > 0 && <ul className="small">{j.changes.map(c => (
              <li key={c.id}>{c.action === 'create' ? '足した' : c.action === 'update' ? '直した' : c.action === 'forget' ? '消した' : c.action === 'restore' ? '戻した' : c.action}: {c.after ?? c.before}{c.undone_at ? '（取り消し済み）' : ''}</li>
            ))}</ul>}
          </li>
        ))}</ul>
      )}
    </section>
  );
}

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [editing, setEditing] = useState<{ name: string; description: string; body: string; isNew: boolean } | null>(null);
  const [error, setError] = useState('');
  const load = () => void api.skills().then(r => setSkills(r.skills)).catch(() => undefined);
  useEffect(load, []);
  const open = (name: string) => void api.skill(name).then(r => setEditing({ name, description: r.skill.description, body: r.skill.body, isNew: false }));
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setError('');
    void api.saveSkill(editing.name, editing.description, editing.body).then(() => { setEditing(null); load(); }, err => setError(errorText(err)));
  };
  return (
    <section className="page">
      <h1>スキル</h1>
      <p className="muted small">Clive の手順書です。名前と説明は会話のはじめに Clive に渡り、本文は必要なときに読まれます。Clive が作ったものは「レビュー」で承認すると、ここに入ります。</p>
      <p><ZoneNote /></p>
      <div className="row"><button className="secondary" onClick={() => setEditing({ name: '', description: '', body: '', isNew: true })}>新しく書く</button></div>
      {editing && (
        <form className="task-form" onSubmit={save}>
          {editing.isNew ? <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="名前（英小文字・数字・ハイフン。例: weekly-report）" /> : <strong>{editing.name}</strong>}
          <input value={editing.description} onChange={e => setEditing({ ...editing, description: e.target.value })} placeholder="いつ使うか（1文）" maxLength={300} />
          <textarea value={editing.body} onChange={e => setEditing({ ...editing, body: e.target.value })} rows={12} placeholder="手順" />
          <div className="row">
            <button type="submit">保存</button>
            <button type="button" className="secondary" onClick={() => setEditing(null)}>やめる</button>
            {!editing.isNew && <button type="button" className="stop" onClick={() => { if (confirm(`${editing.name} を削除しますか？`)) void api.deleteSkill(editing.name).then(() => { setEditing(null); load(); }); }}>削除</button>}
          </div>
          {error && <p className="error-text">{error}</p>}
        </form>
      )}
      {!skills ? <p className="muted">読み込み中…</p> : !skills.length ? <p className="muted small">スキルはまだありません</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>名前</th><th>説明</th><th>使った回数</th><th>最後に使った</th></tr></thead>
          <tbody>{skills.map(s => (
            <tr key={s.name}><td><button className="link" onClick={() => open(s.name)}>{s.name}</button></td><td>{s.description}</td><td>{s.uses}</td><td>{formatDateTime(s.lastUsedAt)}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}
