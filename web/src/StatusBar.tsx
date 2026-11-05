import type { ReactNode } from 'react';
import type { WorkerStatus } from './api.ts';
import { useNow, useTheme } from './hooks.ts';
import { Icon, type IconName } from './icons.tsx';
import { formatElapsed, useT } from './i18n/index.ts';
import { WORKER_STATE_LABEL, workerState } from './pages.ts';
import { toggleTheme } from './theme.ts';

interface Props {
  connected: boolean;
  worker: WorkerStatus | null;
  runStartedAt: number | undefined;
  approvals: number;
  modelName: string | null;
  unread: number;
  notificationsOpen: boolean;
  onReconnect: () => void;
  onOpenPanel: () => void;
  onOpenRunning: () => void;
  onOpenApproval: () => void;
  onOpenNotifications: () => void;
}

function Item({ icon, iconClass, tip, onClick, children, accent, expanded }: { icon: IconName; iconClass?: string; tip: string; onClick?: () => void; children?: ReactNode; accent?: boolean; expanded?: boolean }) {
  const body = (
    <>
      <span className={`sb-icon${iconClass ? ` ${iconClass}` : ''}`}><Icon name={icon} size={12} /></span>
      {children !== undefined && children !== '' && <span className="sb-label">{children}</span>}
    </>
  );
  if (!onClick) return <span className="sb-item" data-tip={tip}>{body}</span>;
  return <button className={`sb-item${accent ? ' accent' : ''}`} data-tip={tip} aria-label={tip} aria-expanded={expanded} onClick={onClick}>{body}</button>;
}

export function StatusBar(props: Props) {
  const { connected, worker, runStartedAt, approvals, modelName, unread } = props;
  const t = useT();
  const { effective } = useTheme();
  const running = worker?.running ?? null;
  const now = useNow(1000, Boolean(running));
  const state = workerState(worker);
  const stateText = t(WORKER_STATE_LABEL[state]);
  const title = running ? [...running.title].slice(0, 16).join('') + ([...running.title].length > 16 ? '…' : '') : '';
  const elapsed = running && runStartedAt !== undefined ? ` · ${formatElapsed(now - runStartedAt)}` : '';
  return (
    <footer className="statusbar" aria-label={t('status.bar')}>
      <div className="sb-group">
        <Item icon="wifi" iconClass={connected ? 'on' : 'off'} tip={t('status.connectionTip')} onClick={props.onReconnect}>
          <span key={String(connected)} className="swap">{connected ? t('status.connected') : t('status.reconnecting')}</span>
        </Item>
        <Item icon={state === 'paused' ? 'pause' : 'activity'} tip={t('status.workerTip')} onClick={props.onOpenPanel}>
          {worker ? t('status.worker', stateText, worker.runsLastHour, worker.maxRunsPerHour) : ''}
        </Item>
        {running && (
          <Item icon="loader" iconClass={state === 'paused' ? 'on' : 'on spin'} tip={running.kind === 'task' ? t('status.runningTip') : t('status.runningReviewTip')} onClick={props.onOpenRunning}>
            {title}{elapsed}
          </Item>
        )}
      </div>
      <div className="sb-group">
        {approvals > 0 && <Item icon="shield" iconClass="on" tip={t('status.approvalsTip')} onClick={props.onOpenApproval} accent>{t('status.approvals', approvals)}</Item>}
        {modelName && <Item icon="cpu" tip={t('status.modelTip')}><span className="sb-mono">{modelName}</span></Item>}
        <Item icon="bell" iconClass={unread ? 'on' : undefined} tip={t('status.notifications')} onClick={props.onOpenNotifications} expanded={props.notificationsOpen}>{String(unread)}</Item>
        <Item icon={effective === 'dark' ? 'sun' : 'moon'} tip={effective === 'dark' ? t('theme.toLight') : t('theme.toDark')} onClick={toggleTheme} />
      </div>
    </footer>
  );
}
