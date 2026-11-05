import { ActivityBody } from './ActivityBody.tsx';
import type { Profile, WorkerStatus } from './api.ts';
import type { Runtime } from './avatar.ts';
import { Icon } from './icons.tsx';
import { useT } from './i18n/index.ts';
import { WORKER_STATE_LABEL, workerState } from './pages.ts';

interface Props {
  variant: 'side' | 'page';
  open: boolean;
  overlay: boolean;
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
  onClose: () => void;
}

// 右のパネル「いまの動き」。760px 未満では同じ中身が、左のメニューの「いまの動き」のページになる（variant="page"）。
export function ActivityPanel(props: Props) {
  const t = useT();
  const state = workerState(props.worker);
  const body = (
    <ActivityBody
      profile={props.profile} presence={props.presence} worker={props.worker} onWorker={props.onWorker}
      approvals={props.approvals} waitingCount={props.waitingCount} unread={props.unread}
      taskRevision={props.taskRevision} runRevision={props.runRevision} runStartedAt={props.runStartedAt} onOpenApproval={props.onOpenApproval}
    />
  );
  if (props.variant === 'page') return <div className="activity-page">{body}</div>;
  return (
    <aside className={`pane${props.overlay ? ' pane-overlay' : ''}`} hidden={!props.open} aria-label={t('panel.title')}>
      <div className="pane-head">
        <span className="pane-title">{t('panel.title')}</span>
        <span className="pane-state"><span className={`pane-dot ${state === 'running' || state === 'idle' ? 'on' : 'off'}`} />{t(WORKER_STATE_LABEL[state])}</span>
        <button className="btn btn-ghost btn-icon pane-close" onClick={props.onClose} aria-label={t('panel.close')}><Icon name="x" size={14} /></button>
      </div>
      <div className="pane-body">{body}</div>
    </aside>
  );
}
