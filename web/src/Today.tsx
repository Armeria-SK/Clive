import { useEffect, useState } from 'react';
import { api, type Profile, type Task, type WorkerStatus } from './api.ts';
import { Avatar } from './Avatar.tsx';
import type { Runtime } from './avatar.ts';
import { fmtTime, STATUS_LABEL, WorkerBar } from './Tasks.tsx';

interface Props {
  profile: Profile | null;
  presence: { runtime: Runtime; sleeping: boolean; line: string };
  approvals: number;
  unread: number;
  worker: WorkerStatus | null;
  onWorker: (w: WorkerStatus) => void;
  revision: number;
}

export function Today({ profile, presence, approvals, unread, worker, onWorker, revision }: Props) {
  const [tasks, setTasks] = useState<{ active: Task[]; finished: Task[] } | null>(null);
  useEffect(() => { void api.tasks().then(setTasks).catch(() => undefined); }, [revision]);
  const active = tasks?.active ?? [];
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const finishedToday = (tasks?.finished ?? []).filter(t => (t.completed_at ?? 0) >= startOfDay.getTime());
  const upcoming = active.filter(t => t.run_at && t.run_at > Date.now()).sort((a, b) => a.run_at! - b.run_at!).slice(0, 5);
  const count = (label: string, n: number, href: string) => <a className="count" href={href}><strong>{n}</strong><span>{label}</span></a>;
  return (
    <section className="page">
      <div className="presence">
        {profile && <Avatar shape={profile.shape} color={profile.color} motion={profile.motion} runtime={presence.runtime} sleeping={presence.sleeping} size={96} seed={profile.name} />}
        <div>
          <h1>{profile?.name ?? 'Clive'}</h1>
          <p>{presence.line}</p>
        </div>
      </div>
      <WorkerBar worker={worker} onChange={onWorker} />
      <div className="counts">
        {count('進行中のタスク', active.filter(t => t.status === 'ready' || t.status === 'running').length, '#/tasks')}
        {count('返事待ち', active.filter(t => t.status === 'waiting').length, '#/tasks')}
        {count('承認待ち', approvals, '#/tasks')}
        {count('未読の通知', unread, '#/notifications')}
      </div>
      <h2>今日終わったこと</h2>
      {finishedToday.length ? (
        <ul className="task-list">{finishedToday.map(t => (
          <li key={t.id}><a href={`#/tasks/${t.id}`}>{t.title}</a> <span className="badge">{STATUS_LABEL[t.status]}</span>{t.result_summary && <p className="small muted">{t.result_summary}</p>}</li>
        ))}</ul>
      ) : <p className="muted small">まだありません</p>}
      <h2>次の予定</h2>
      {upcoming.length ? (
        <ul className="task-list">{upcoming.map(t => (
          <li key={t.id}><a href={`#/tasks/${t.id}`}>{t.title}</a> <span className="muted small">{fmtTime(t.run_at)}{t.cron_text ? `（${t.cron_text}）` : ''}</span></li>
        ))}</ul>
      ) : <p className="muted small">予定はありません</p>}
    </section>
  );
}
