import type { Profile, WorkerStatus } from './api.ts';
import type { Runtime } from './avatar.ts';
import { Icon } from './icons.tsx';
import { useT } from './i18n/index.ts';
import { WORKER_STATE_LABEL, workerState } from './pages.ts';
import { Today } from './Today.tsx';

interface Props {
  variant: 'side' | 'page';
  open: boolean;
  overlay: boolean;
  profile: Profile | null;
  presence: { runtime: Runtime; sleeping: boolean; line: string };
  approvals: number;
  unread: number;
  worker: WorkerStatus | null;
  onWorker: (w: WorkerStatus) => void;
  revision: number;
  onClose: () => void;
}

// 右のパネル「いまの動き」の枠。中身は段階 6 で作り直すまで、今の「きょう」をそのまま入れる。
export function ActivityPanel(props: Props) {
  const t = useT();
  const state = workerState(props.worker);
  const body = (
    <Today
      profile={props.profile} presence={props.presence} approvals={props.approvals} unread={props.unread}
      worker={props.worker} onWorker={props.onWorker} revision={props.revision}
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
