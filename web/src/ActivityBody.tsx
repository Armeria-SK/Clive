import { useEffect, useState } from 'react';
import { api, type Profile, type RunRow, type Task, type TaskStatus, type WorkerStatus } from './api.ts';
import { finishedToday, lastNoteOf, recentRuns, runOutcome, runsFraction, taskWhen, upNextTasks } from './activity.ts';
import { Avatar } from './Avatar.tsx';
import type { Runtime } from './avatar.ts';
import { useNow } from './hooks.ts';
import { Icon, type IconName } from './icons.tsx';
import { formatDateTime, formatDateTimeSmart, formatElapsed, startOfDay, useT, type PlainKey } from './i18n/index.ts';
import { toast } from './toast.tsx';
import { ZoneNote } from './ZoneNote.tsx';

interface Props {
  profile: Profile | null;
  presence: { runtime: Runtime; sleeping: boolean; line: string };
  worker: WorkerStatus | null;
  onWorker: (worker: WorkerStatus) => void;
  approvals: number;
  waitingCount: number;
  unread: number;
  taskRevision: number;
  runRevision: number;
  runStartedAt: number | undefined;
  onOpenApproval: () => void;
}

const RUN_KIND_KEY: Record<string, PlainKey> = { chat: 'run.kind.chat', task: 'run.kind.task', review: 'run.kind.review' };
const FINISHED_KEY: Partial<Record<TaskStatus, PlainKey>> = { done: 'task.status.done', failed: 'task.status.failed', cancelled: 'task.status.cancelled' };
const NOTE_REFRESH_MS = 10_000;

const taskHref = (id: string) => `#/tasks/${encodeURIComponent(id)}`;

// 右のパネル「いまの動き」の中身。いちばん上に「きょう」（姿・一言・件数・今日終わったこと）、そのあとデザインの
// ワーカー → 実行中 → 次に動くタスク → 最近の実行。
export function ActivityBody(props: Props) {
  const { profile, presence, worker, onWorker, approvals, waitingCount, unread, taskRevision, runRevision } = props;
  const t = useT();
  const running = worker?.running ?? null;
  const clock = useNow(30_000);
  const tick = useNow(1000, Boolean(running));
  const [tasks, setTasks] = useState<{ active: Task[]; finished: Task[] } | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [note, setNote] = useState('');

  useEffect(() => { void api.tasks().then(setTasks).catch(() => undefined); }, [taskRevision]);
  useEffect(() => { void api.runs().then(r => setRuns(r.runs)).catch(() => undefined); }, [runRevision]);

  const runningTaskId = running?.kind === 'task' ? running.taskId : null;
  useEffect(() => {
    if (!runningTaskId) { setNote(''); return undefined; }
    let alive = true;
    const load = () => void api.task(runningTaskId).then(r => { if (alive) setNote(lastNoteOf(r.events)); }).catch(() => undefined);
    load();
    const timer = setInterval(load, NOTE_REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [runningTaskId, taskRevision]);

  const update = (patch: { paused?: boolean; autonomy?: boolean }) => {
    api.setWorker(patch).then(onWorker).catch(() => toast({ title: t('toast.actionFailed'), icon: 'alert' }));
  };

  const stopRun = (runId: string) => { api.stop(runId).catch(() => toast({ title: t('toast.actionFailed'), icon: 'alert' })); };

  const done = tasks ? finishedToday(tasks.finished, startOfDay(clock)) : [];
  const upNext = tasks ? upNextTasks(tasks.active, clock, { allowSelf: Boolean(worker?.autonomy) }) : [];
  const recent = recentRuns(runs);
  const paused = Boolean(worker?.paused);
  const elapsed = running && props.runStartedAt !== undefined ? formatElapsed(tick - props.runStartedAt) : '';
  const nextWake = !worker ? '—' : paused ? '—' : running ? t('activity.running') : worker.nextWakeAt ? formatDateTimeSmart(Math.max(worker.nextWakeAt, clock), clock) : '—';

  return (
    <div className="act">
      <section className="act-section">
        <div className="act-me">
          {profile && <Avatar shape={profile.shape} color={profile.color} motion={profile.motion} runtime={presence.runtime} sleeping={presence.sleeping} size={56} seed={profile.name} />}
          <div className="act-me-text">
            <span className="act-name">{profile?.name ?? 'Clive'}</span>
            <span className="act-phrase">{presence.line}</span>
          </div>
        </div>
        <div className="act-counts">
          <button className="act-count" onClick={props.onOpenApproval} disabled={approvals === 0}><strong>{approvals}</strong><span>{t('activity.countApprovals')}</span></button>
          <a className="act-count" href="#/tasks"><strong>{waitingCount}</strong><span>{t('activity.countWaiting')}</span></a>
          <a className="act-count" href="#/notifications"><strong>{unread}</strong><span>{t('activity.countUnread')}</span></a>
        </div>
        <ZoneNote />
        <div className="act-block">
          <span className="act-label">{t('activity.finishedToday')}</span>
          {done.length ? (
            <ul className="act-finished">
              {done.map(task => (
                <li key={task.id}>
                  <span className="act-finished-head">
                    <a href={taskHref(task.id)} className="act-finished-title">{task.title}</a>
                    {FINISHED_KEY[task.status] && <span className="tag tag-neutral">{t(FINISHED_KEY[task.status]!)}</span>}
                  </span>
                  {task.result_summary && <span className="act-finished-summary">{task.result_summary}</span>}
                </li>
              ))}
            </ul>
          ) : <span className="act-none">{t('activity.finishedNone')}</span>}
        </div>
      </section>

      <section className="act-section">
        <span className="act-label">{t('activity.worker')}</span>
        {!worker ? null : !worker.enabled ? <span className="act-none">{t('activity.workerDisabled')}</span> : (
          <>
            <div className="act-row-between">
              <span className="act-text">{t('activity.autonomy')}</span>
              <div className="seg">
                {[true, false].map(value => (
                  <label className="seg-opt act-seg" key={String(value)}>
                    <input type="radio" name="activity-autonomy" checked={worker.autonomy === value} onChange={() => update({ autonomy: value })} />
                    {t(value ? 'activity.on' : 'activity.off')}
                  </label>
                ))}
              </div>
            </div>
            <span className="act-hint">{t('activity.autonomyHint')}</span>
            <div className="act-stats">
              <div className="act-stat">
                <span className="act-stat-label">{t('activity.nextWake')}</span>
                <span className="act-stat-value">{nextWake}</span>
              </div>
              <div className="act-stat">
                <span className="act-stat-label">{t('activity.runsLastHour')}</span>
                <span className="act-stat-value">{worker.runsLastHour}<span className="act-stat-max"> / {worker.maxRunsPerHour}</span></span>
                <span className="act-meter"><span style={{ width: `${runsFraction(worker.runsLastHour, worker.maxRunsPerHour)}%` }} /></span>
              </div>
            </div>
            <button className="btn btn-secondary act-pause" onClick={() => update({ paused: !paused })}>
              <Icon name={paused ? 'play' : 'pause'} size={13} />{paused ? t('activity.resume') : t('activity.pause')}
            </button>
          </>
        )}
      </section>

      <section className="act-section">
        <span className="act-label">{t('activity.running')}</span>
        {running ? (
          <div className="act-run">
            <div className="act-run-top">
              <a className="act-run-head" href={running.kind === 'task' && running.taskId ? taskHref(running.taskId) : '#/review'}>
                <span className={`act-run-spin${paused ? '' : ' spin'}`}><Icon name="loader" size={13} /></span>
                <span className="act-run-title">{running.title}</span>
                <span className="act-run-elapsed">{elapsed}</span>
              </a>
              <button className="btn btn-ghost btn-icon act-run-stop" onClick={() => stopRun(running.runId)} aria-label={t('activity.stopRun')} data-tip={t('activity.stopRun')}><Icon name="square" size={12} /></button>
            </div>
            {(paused || note) && <span className="act-run-note swap" key={paused ? 'paused' : note}>{paused ? t('activity.paused') : note}</span>}
            <span className="act-run-line"><span className={paused ? undefined : 'flow'} /></span>
          </div>
        ) : <span className="act-none">{t('activity.runningNone')}</span>}
      </section>

      <section className="act-section">
        <span className="act-label">{t('activity.upNext')}</span>
        {upNext.length ? upNext.map(task => {
          const when = taskWhen(task, clock);
          const icon: IconName = task.status === 'ready' && when.kind === 'priority' ? 'circle' : 'repeat';
          return (
            <a key={task.id} className="act-next" href={taskHref(task.id)}>
              <span className="act-next-icon"><Icon name={icon} size={14} /></span>
              <span className="act-next-title">{task.title}</span>
              <span className="act-next-when">{when.kind === 'priority' ? t('activity.priority', when.priority) : when.kind === 'cron' ? (when.at ? `${when.text} · ${formatDateTimeSmart(when.at, clock)}` : when.text) : formatDateTime(when.at)}</span>
            </a>
          );
        }) : <span className="act-none">{t('activity.upNextNone')}</span>}
      </section>

      <section className="act-section">
        <div className="act-row-between act-baseline">
          <span className="act-label">{t('activity.recentRuns')}</span>
          <a className="act-seeall" href="#/runs">{t('activity.seeAll')}</a>
        </div>
        {recent.length ? recent.map(run => {
          const outcome = runOutcome(run);
          const kindKey = RUN_KIND_KEY[run.kind];
          return (
            <div key={run.id} className="act-recent">
              <span className="act-recent-time">{formatDateTimeSmart(run.started_at, clock)}</span>
              <span className="act-recent-kind">{kindKey ? t(kindKey) : run.kind}{run.model_id && <span className="act-recent-model"> {run.model_id}</span>}</span>
              <span className={`act-recent-result${outcome.kind === 'ok' ? '' : ' bad'}`}>
                <Icon name={outcome.kind === 'ok' ? 'check' : outcome.kind === 'running' ? 'loader' : 'x'} size={11} />
                {outcome.kind === 'ok' ? `${outcome.seconds}s` : outcome.kind === 'running' ? t('activity.runInProgress') : outcome.kind === 'cancelled' ? t('activity.runCancelled') : t('activity.runFailed')}
              </span>
            </div>
          );
        }) : <span className="act-none">{t('activity.recentNone')}</span>}
      </section>
    </div>
  );
}
