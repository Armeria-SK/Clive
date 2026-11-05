import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { Approval, Conversation } from './api.ts';
import { convMark } from './conversation-state.ts';
import type { Draft } from './events.ts';
import { Icon } from './icons.tsx';
import { useT } from './i18n/index.ts';
import { modLabel } from './keys.ts';
import { PAGE_META } from './pages.ts';
import { chatIdOf, isChatTab, pageOfTab, type Tab } from './tabs.ts';

interface Props {
  tabs: Tab[];
  activeKey: string | null;
  conversations: Conversation[];
  drafts: Draft[];
  approvals: Approval[];
  chatTitles: Record<string, string>;
  panelOpen: boolean;
  onClose: (key: string) => void;
  onNewChat: () => void;
  onSearch: () => void;
  onTogglePanel: () => void;
}

export function TabBar({ tabs, activeKey, conversations, drafts, approvals, chatTitles, panelOpen, onClose, onNewChat, onSearch, onTogglePanel }: Props) {
  const t = useT();
  const bar = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ x: 0, w: 0 });

  const measure = useRef(() => undefined as void);
  measure.current = () => {
    const active = bar.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    const next = active ? { x: Math.round(active.offsetLeft), w: Math.round(active.offsetWidth) } : { x: 0, w: 0 };
    setIndicator(prev => (prev.x === next.x && prev.w === next.w ? prev : next));
  };
  useLayoutEffect(() => { measure.current(); });
  useEffect(() => {
    const observer = typeof ResizeObserver === 'function' && bar.current ? new ResizeObserver(() => measure.current()) : null;
    if (observer && bar.current) observer.observe(bar.current);
    void document.fonts?.ready.then(() => measure.current());
    return () => observer?.disconnect();
  }, []);

  const labelOf = (tab: Tab): string => {
    if (!isChatTab(tab)) return t(PAGE_META[pageOfTab(tab)].label);
    const id = chatIdOf(tab);
    if (!id) return t('tab.newChat');
    return conversations.find(c => c.id === id)?.title ?? chatTitles[id] ?? t('conversation.untitled');
  };
  const kbd = `${modLabel()}/`;
  const panelTip = panelOpen ? t('panel.hide') : t('panel.show');

  return (
    <div className="tabbar" ref={bar}>
      <div className="tabs" role="tablist" aria-label={t('tab.list')}>
        {tabs.map(tab => {
          const active = tab.key === activeKey;
          const id = chatIdOf(tab);
          const mark = id === null ? null : convMark(drafts, approvals, id);
          const label = labelOf(tab);
          const close = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); onClose(tab.key); };
          return (
            <div key={tab.key} role="tab" aria-selected={active} className={`tab${active ? ' active' : ''}`} onAuxClick={e => { if (e.button === 1) close(e); }}>
              <a href={tab.hash} className="tab-link" title={label}>
                <span className="tab-icon"><Icon name={isChatTab(tab) ? 'msg' : PAGE_META[pageOfTab(tab)].icon} size={14} /></span>
                <span className="tab-label">{label}</span>
                {mark === 'generating' && <span className="spin tab-state"><Icon name="loader" size={11} /><span className="sr-only">{t('conversation.generating')}</span></span>}
                {mark === 'approval' && <span className="tab-dot"><span className="sr-only">{t('conversation.needsApproval')}</span></span>}
              </a>
              <button className="tab-close" aria-label={t('tab.close')} onClick={close}><Icon name="x" size={12} /></button>
            </div>
          );
        })}
      </div>
      <button className="btn btn-ghost btn-icon tab-tool" onClick={onNewChat} aria-label={t('nav.newChat')} data-tip={t('nav.newChat')} data-tip-pos="below"><Icon name="plus" size={15} /></button>
      <span className="tabbar-fill" />
      <button className="btn btn-ghost btn-icon tab-tool" onClick={onSearch} aria-label={t('nav.search')} data-tip={t('nav.search')} data-kbd={`${modLabel()}K`} data-tip-pos="below"><Icon name="search" size={16} /></button>
      <button
        className={`btn btn-ghost btn-icon tab-tool${panelOpen ? ' on' : ''}`} onClick={onTogglePanel} aria-pressed={panelOpen}
        aria-label={t('panel.title')} data-tip={panelTip} data-kbd={kbd} data-tip-pos="below"
      ><Icon name="panel" size={16} /></button>
      <span className="tab-indicator" style={{ transform: `translateX(${indicator.x}px)`, width: indicator.w }} />
    </div>
  );
}
