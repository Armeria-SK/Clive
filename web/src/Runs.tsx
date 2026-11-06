import { useCallback, useEffect, useState } from 'react';
import { api, type ReviewJob, type RunRow, type ToolCallRow } from './api.ts';
import { Icon } from './icons.tsx';
import { formatDateTime, useT } from './i18n/index.ts';
import type { RunsTab } from './routes.ts';
import {
  changeLabel, decidedByLabel, decisionLabel, decisionTag, formatTokens, jobStatusLabel, jobTag, jobTriggerLabel, LOG_LIMIT, LOG_VIEWS, logHash, runDetail,
  runKindLabel, runSeconds, runStatus, toolStatus, type LogView, type Status,
} from './runlog-meta.ts';
import { ZoneNote } from './ZoneNote.tsx';

interface Props {
  tab?: RunsTab | undefined;
  // 実行が始まる・終わるたびに変わる値。変わったら、見ている表を取り直す。
  refreshKey: string;
}

type Loaded<T> = { items: T[] } | 'failed' | null;
const itemsOf = <T,>(value: Loaded<T>): T[] | null => (value && value !== 'failed' ? value.items : null);

function StatusCell({ status }: { status: Status }) {
  return (
    <span className={`lg-result ${status.tone}`}>
      <span className={status.tone === 'wait' && status.icon === 'loader' ? 'spin lg-spin' : 'lg-icon'}><Icon name={status.icon} size={12} /></span>
      {status.label}
    </span>
  );
}

function Head({ labels }: { labels: string[] }) {
  return <>{labels.map((label, i) => <span key={i} role="columnheader" className="lg-head">{label}</span>)}</>;
}

function RunsTable({ runs }: { runs: RunRow[] }) {
  const t = useT();
  return (
    <div className="lg-table lg-runs" role="table">
      <div role="row" className="lg-row">
        <Head labels={[t('runs.col.time'), t('runs.col.kind'), t('runs.col.model'), t('runs.col.result'), t('runs.col.secs'), t('runs.col.detail')]} />
      </div>
      {runs.map(run => (
        <div role="row" className="lg-row" key={run.id}>
          <span role="cell" className="lg-cell">{formatDateTime(run.started_at, 'precise')}</span>
          <span role="cell" className="lg-cell">{runKindLabel(run.kind)}</span>
          <span role="cell" className="lg-cell lg-mono" title={run.model_id ?? undefined}>{run.model_id ?? '—'}</span>
          <span role="cell" className="lg-cell"><StatusCell status={runStatus(run)} /></span>
          <span role="cell" className="lg-cell lg-num">{runSeconds(run.duration_ms)}</span>
          <span role="cell" className="lg-cell lg-detail">{runDetail(run)}</span>
        </div>
      ))}
    </div>
  );
}

function ToolsTable({ calls }: { calls: ToolCallRow[] }) {
  const t = useT();
  return (
    <div className="lg-table lg-tools" role="table">
      <div role="row" className="lg-row">
        <Head labels={[t('runs.col.time'), t('runs.col.tool'), t('runs.col.decision'), t('runs.col.by'), t('runs.col.result')]} />
      </div>
      {calls.map(call => (
        <div role="row" className="lg-row" key={call.id}>
          <span role="cell" className="lg-cell">{formatDateTime(call.created_at, 'precise')}</span>
          <span role="cell" className="lg-cell lg-mono" title={call.tool}>{call.tool}</span>
          <span role="cell" className="lg-cell"><span className={`tag ${decisionTag(call.decision)}`}>{decisionLabel(call.decision)}</span></span>
          <span role="cell" className="lg-cell">
            {decidedByLabel(call.decided_by)}
            {call.autoReason && <span className="lg-sub" title={`${t('runs.autoReason')}: ${call.autoReason}`}>{call.autoReason}</span>}
            {call.grantFolder && <span className="lg-sub" title={call.grantFolder}>{t('runs.grantFolder', call.grantFolder)}</span>}
          </span>
          <span role="cell" className="lg-cell"><StatusCell status={toolStatus(call.ok)} /></span>
        </div>
      ))}
    </div>
  );
}

function ReviewList({ jobs }: { jobs: ReviewJob[] }) {
  const t = useT();
  return (
    <div className="lg-jobs">
      {jobs.map(job => (
        <article className="lg-job" key={job.id}>
          <div className="lg-job-head">
            <span className="lg-job-time">{formatDateTime(job.created_at)}</span>
            <span className="lg-job-trigger">{jobTriggerLabel(job.trigger)}</span>
            <span className={`tag ${jobTag(job.status)}`}>
              {job.status === 'running' && <span className="spin lg-spin"><Icon name="loader" size={11} /></span>}
              {jobStatusLabel(job.status)}
            </span>
          </div>
          {job.note && <p className="lg-job-note">{job.note}</p>}
          {job.changes.length > 0 && (
            <ul className="lg-changes">
              {job.changes.map(change => (
                <li key={change.id} className={change.undone_at ? 'undone' : undefined}>
                  <span className="lg-change-kind">{changeLabel(change.action)}</span>
                  <span className="lg-change-text">{change.after ?? change.before}</span>
                  {change.undone_at ? <span className="lg-change-undone">{t('runs.reviews.undone')}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </div>
  );
}

// 実行ログ。実行・道具・振り返りの 3 つの表を切り替える。切り替えは経路（#/runs[/tools|/reviews]）が唯一の正。
export function Runs({ tab, refreshKey }: Props) {
  const t = useT();
  const view: LogView = tab ?? 'runs';
  const [runs, setRuns] = useState<Loaded<RunRow>>(null);
  const [calls, setCalls] = useState<Loaded<ToolCallRow>>(null);
  const [jobs, setJobs] = useState<Loaded<ReviewJob>>(null);
  const [pending, setPending] = useState(0);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(n => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const fail = (set: (v: 'failed') => void) => () => { if (!cancelled) set('failed'); };
    if (view === 'runs') api.runs().then(r => { if (!cancelled) setRuns({ items: r.runs }); }, fail(setRuns));
    else if (view === 'tools') api.toolCalls().then(r => { if (!cancelled) setCalls({ items: r.toolCalls }); }, fail(setCalls));
    else api.reviews().then(r => { if (!cancelled) { setJobs({ items: r.jobs }); setPending(r.pending); } }, fail(setJobs));
    return () => { cancelled = true; };
  }, [view, refreshKey, tick]);

  const current: Loaded<unknown> = view === 'runs' ? runs : view === 'tools' ? calls : jobs;
  const items = itemsOf(current);

  return (
    <section className="view">
      <div className="view-inner lg-inner">
        <div className="view-head">
          <div className="view-titles">
            <h1 className="view-title">{t('runs.title')}</h1>
            <span className="view-sub">{t('runs.subtitle')}</span>
          </div>
          <div className="view-actions">
            {view === 'reviews' && pending > 0 && <span className="view-count">{t('runs.reviews.pending', pending)}</span>}
            <button className="btn btn-secondary" onClick={refresh}><Icon name="refresh" size={13} />{t('runs.refresh')}</button>
            <div className="seg lg-seg" role="radiogroup" aria-label={t('runs.segLabel')}>
              {LOG_VIEWS.map(v => (
                <label className="seg-opt" key={v}>
                  <input type="radio" name="log-view" checked={view === v} onChange={() => { location.hash = logHash(v); }} />
                  {t(`runs.seg.${v}`)}
                </label>
              ))}
            </div>
          </div>
        </div>
        <p className="view-zone"><ZoneNote /></p>

        {view === 'reviews' && (
          <p className="view-note">{t('runs.reviews.intro')} <a href="#/memory">{t('runs.reviews.openMemory')}</a></p>
        )}
        {!items ? <p className="view-note">{current === 'failed' ? t('runs.loadFailed') : t('runs.loading')}</p>
          : !items.length ? <p className="view-note">{t(view === 'reviews' ? 'runs.reviews.empty' : 'runs.empty')}</p>
          : (
            <div className="lg-scroll">
              {view === 'runs' && <RunsTable runs={itemsOf(runs) ?? []} />}
              {view === 'tools' && <ToolsTable calls={itemsOf(calls) ?? []} />}
              {view === 'reviews' && <ReviewList jobs={itemsOf(jobs) ?? []} />}
            </div>
          )}
        {items && view !== 'reviews' && items.length >= LOG_LIMIT && <p className="view-note">{t('runs.limit', items.length)}</p>}
      </div>
    </section>
  );
}
