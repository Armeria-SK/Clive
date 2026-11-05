import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import type { Approval, Conversation, Profile } from './api.ts';
import { Avatar } from './Avatar.tsx';
import type { Runtime } from './avatar.ts';
import { conversationCountLabel, convMark } from './conversation-state.ts';
import type { Draft } from './events.ts';
import { useNow, useTheme } from './hooks.ts';
import { Icon, type IconName } from './icons.tsx';
import { formatRelativeCompact, useT, type PlainKey } from './i18n/index.ts';
import { modLabel } from './keys.ts';
import type { LayoutMode } from './layout.ts';
import { chatHash, type Page, type Route } from './routes.ts';
import { toggleTheme } from './theme.ts';

interface Props {
  mode: LayoutMode;
  drawerOpen: boolean;
  route: Route;
  profile: Profile | null;
  presence: { runtime: Runtime; sleeping: boolean; line: string };
  conversations: Conversation[];
  conversationsLoaded: boolean;
  drafts: Draft[];
  approvals: Approval[];
  waitingCount: number;
  restartRequired: boolean;
  onNavigate: () => void;
  onNewChat: () => void;
  onSearch: () => void;
  onAvatar: () => void;
}

interface NavItem { page: Page | 'new' | 'search'; href: string; label: PlainKey; icon: IconName; badge?: ReactNode; badgeLabel?: string }

const PAGE_LINKS: ReadonlyArray<{ page: Page; label: PlainKey; icon: IconName }> = [
  { page: 'tasks', label: 'nav.tasks', icon: 'tasks' },
  { page: 'skills', label: 'nav.skills', icon: 'wrench' },
  { page: 'runs', label: 'nav.runs', icon: 'activity' },
  { page: 'memory', label: 'nav.memory', icon: 'bookmark' },
  { page: 'settings', label: 'nav.settings', icon: 'sliders' },
];

export function Sidebar(props: Props) {
  const { mode, drawerOpen, route, profile, presence, conversations, conversationsLoaded, drafts, approvals, waitingCount, restartRequired } = props;
  const t = useT();
  const { effective } = useTheme();
  const now = useNow(30_000);
  const activeId = route.page === 'chat' ? route.conversationId : null;

  const seen = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());
  const isFresh = (id: string) => fresh.current.has(id) || (seen.current !== null && !seen.current.has(id));
  useEffect(() => {
    if (!conversationsLoaded) return;
    if (seen.current) for (const c of conversations) if (!seen.current.has(c.id)) fresh.current.add(c.id);
    seen.current = new Set(conversations.map(c => c.id));
  }, [conversations, conversationsLoaded]);

  const items: NavItem[] = [
    { page: 'new', href: '#/', label: 'nav.newChat', icon: 'plus' },
    { page: 'search', href: '', label: 'nav.search', icon: 'search' },
    ...PAGE_LINKS.map((p): NavItem => ({ page: p.page, href: `#/${p.page}`, label: p.label, icon: p.icon })),
  ];
  const withBadges = items.map((item): NavItem => {
    if (item.page === 'tasks' && waitingCount > 0) return { ...item, badge: waitingCount, badgeLabel: t('nav.tasksWaiting', waitingCount) };
    if (item.page === 'settings' && restartRequired) return { ...item, badge: '!', badgeLabel: t('nav.settingsRestart') };
    return item;
  });
  if (mode === 'narrow') withBadges.push({ page: 'today', href: '#/today', label: 'nav.activity', icon: 'panel' });

  const click = (e: MouseEvent, item: NavItem) => {
    if (item.page === 'new') { e.preventDefault(); props.onNewChat(); }
    props.onNavigate();
  };
  const hidden = mode === 'narrow' && !drawerOpen;

  return (
    <aside className={`side${mode === 'narrow' ? ' side-drawer' : ''}${drawerOpen ? ' open' : ''}${mode === 'mid' ? ' side-mid' : ''}`} hidden={hidden}>
      <div className="side-head">
        <button className="side-avatar" onClick={props.onAvatar} aria-label={t('panel.open')} data-tip={t('panel.open')} data-tip-pos="right">
          {profile
            ? <Avatar shape={profile.shape} color={profile.color} motion={profile.motion} runtime={presence.runtime} sleeping={presence.sleeping} size={30} seed={profile.name} />
            : <img src="/icon.svg" alt="" width={26} height={26} />}
        </button>
        <div className="side-id">
          <span className="side-name">{profile?.name ?? 'Clive'}</span>
          <span className="side-phrase swap" key={presence.line}>{presence.line}</span>
        </div>
      </div>

      <nav className="side-nav" aria-label={t('nav.pages')}>
        {withBadges.map(item => {
          const active = item.page === route.page;
          const body = (
            <>
              <span className="nav-icon"><Icon name={item.icon} size={16} /></span>
              <span className="nav-label">{t(item.label)}</span>
              {item.page === 'search' && mode !== 'narrow' && <span className="nav-kbd">{modLabel()}K</span>}
              {item.badge !== undefined && <span className="nav-badge" aria-label={item.badgeLabel} data-tip={item.badgeLabel} data-tip-pos="right">{item.badge}</span>}
            </>
          );
          if (item.page === 'search') return <button key={item.page} className="nav-item" onClick={() => { props.onNavigate(); props.onSearch(); }}>{body}</button>;
          return (
            <a key={item.page} href={item.href} className={`nav-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} onClick={e => click(e, item)}>
              {body}
            </a>
          );
        })}
      </nav>

      <div className="side-section">
        <span className="side-section-label">{t('nav.conversations')}</span>
        <span className="side-section-count">{conversationCountLabel(conversations.length)}</span>
      </div>
      <ul className="side-convs">
        {conversations.map(c => {
          const mark = convMark(drafts, approvals, c.id);
          const active = c.id === activeId;
          return (
            <li key={c.id} className={isFresh(c.id) ? 'flash' : undefined}>
              <a href={chatHash(c.id)} className={`conv${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} onClick={props.onNavigate}>
                <span className="conv-state">
                  {mark === 'generating' && <span className="spin" data-tip={t('conversation.generating')} data-tip-pos="right"><Icon name="loader" size={12} /><span className="sr-only">{t('conversation.generating')}</span></span>}
                  {mark === 'approval' && (
                    <span data-tip={t('conversation.needsApprovalTip')} data-tip-pos="right">
                      <span className="conv-dot" /><span className="conv-dot ping" /><span className="sr-only">{t('conversation.needsApproval')}</span>
                    </span>
                  )}
                </span>
                <span className="conv-title">{c.title ?? t('conversation.untitled')}</span>
                <span className="conv-time">{formatRelativeCompact(c.last_message_at, now)}</span>
              </a>
            </li>
          );
        })}
      </ul>

      {mode === 'narrow' && (
        <div className="side-foot">
          <button className="btn btn-ghost" onClick={toggleTheme}>
            <Icon name={effective === 'dark' ? 'sun' : 'moon'} size={16} />
            {effective === 'dark' ? t('theme.toLight') : t('theme.toDark')}
          </button>
        </div>
      )}
    </aside>
  );
}
