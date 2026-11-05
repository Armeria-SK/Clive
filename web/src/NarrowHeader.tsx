import { Icon } from './icons.tsx';
import { useT } from './i18n/index.ts';

interface Props {
  title: string;
  phrase: string;
  connected: boolean;
  hasApproval: boolean;
  unread: number;
  onMenu: () => void;
  onApproval: () => void;
}

export function NarrowHeader({ title, phrase, connected, hasApproval, unread, onMenu, onApproval }: Props) {
  const t = useT();
  return (
    <header className="narrow-head">
      <button className="btn btn-ghost btn-icon narrow-btn" onClick={onMenu} aria-label={t('nav.menu')}><Icon name="menu" size={20} /></button>
      <div className="narrow-title">
        <span className="narrow-name">{title}</span>
        <span className="narrow-phrase">{phrase}</span>
      </div>
      {!connected && <span className="narrow-offline" role="img" aria-label={t('connection.off')} title={t('connection.off')}><Icon name="wifi" size={18} /></span>}
      {hasApproval && (
        <button className="btn btn-ghost btn-icon narrow-btn narrow-accent" onClick={onApproval} aria-label={t('status.approvalsTip')}>
          <Icon name="shield" size={19} /><span className="narrow-dot" />
        </button>
      )}
      <a className="btn btn-ghost btn-icon narrow-btn narrow-bell" href="#/notifications" aria-label={t('status.notifications')}>
        <Icon name="bell" size={19} />
        {unread > 0 && <span className="narrow-count">{unread}</span>}
      </a>
    </header>
  );
}
