import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Conversation } from './api.ts';
import { routeHash, type Route } from './routes.ts';
import { closeTab, loadTabs, openTab, pruneMissingChats, saveTabs, toTab, type Tab } from './tabs.ts';

// タブは「開いた経路の一覧」だけを持つ。今どれを開いているかは URL のハッシュが唯一の正で、タブはそれに従う。
export function useTabs(route: Route, conversations: Conversation[], conversationsLoaded: boolean) {
  const [tabs, setTabs] = useState<Tab[]>(() => loadTabs());
  const current = toTab(routeHash(route));
  const activeKey = useRef<string | null>(null);
  const append = useRef(false);

  useLayoutEffect(() => {
    if (!current) return;
    const options = { activeKey: activeKey.current, append: append.current };
    setTabs(prev => openTab(prev, current.hash, options));
    append.current = false;
    activeKey.current = current.key;
  }, [current?.key, current?.hash]);

  useEffect(() => { saveTabs(tabs); }, [tabs]);

  const pruned = useRef(false);
  useEffect(() => {
    if (!conversationsLoaded || pruned.current) return;
    pruned.current = true;
    const ids = new Set(conversations.map(c => c.id));
    const keep = activeKey.current;
    setTabs(prev => pruneMissingChats(prev, ids, keep));
  }, [conversations, conversationsLoaded]);

  const close = useCallback((key: string) => {
    const result = closeTab(tabs, key, activeKey.current);
    setTabs(result.tabs);
    if (result.go !== null && location.hash !== result.go) location.hash = result.go;
  }, [tabs]);

  const openNewChat = useCallback(() => {
    if (location.hash === '' || location.hash === '#/' || location.hash === '#') return;
    append.current = true;
    location.hash = '#/';
  }, []);

  return { tabs, activeKey: current?.key ?? null, close, openNewChat };
}
