import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError, type Conversation } from './api.ts';
import { routeHash, type Route } from './routes.ts';
import { closeTab, dropChats, findGoneChats, loadTabs, openTab, saveTabs, toTab, unlistedChatIds, type ChatProbe, type Tab } from './tabs.ts';

// 一覧（100 件まで）の外の会話は、題が一覧に無いので、確かめるついでに題も受け取って、タブの名前にする。
async function probeChat(id: string, found: Record<string, string>): Promise<ChatProbe> {
  try {
    const r = await api.messages(id);
    if (r.conversation.title) found[id] = r.conversation.title;
    return 'exists';
  } catch (error) { return error instanceof ApiError && error.status === 404 ? 'gone' : 'unknown'; }
}

// タブは「開いた経路の一覧」だけを持つ。今どれを開いているかは URL のハッシュが唯一の正で、タブはそれに従う。
export function useTabs(route: Route, conversations: Conversation[], conversationsLoaded: boolean) {
  const [tabs, setTabs] = useState<Tab[]>(() => loadTabs());
  const [titles, setTitles] = useState<Record<string, string>>({});
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

  // 起動後、一覧に無い会話のタブは、サーバーに 1 つずつ尋ねて、404 だったものだけを閉じる
  const pruned = useRef(false);
  const tabsNow = useRef(tabs);
  tabsNow.current = tabs;
  useEffect(() => {
    if (!conversationsLoaded || pruned.current) return;
    pruned.current = true;
    const keep = activeKey.current;
    const candidates = unlistedChatIds(tabsNow.current, new Set(conversations.map(c => c.id)), null);
    if (!candidates.length) return;
    const found: Record<string, string> = {};
    void findGoneChats(candidates, id => probeChat(id, found)).then(gone => {
      if (Object.keys(found).length) setTitles(found);
      if (gone.size) setTabs(prev => dropChats(prev, gone, keep));
    });
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

  return { tabs, titles, activeKey: current?.key ?? null, close, openNewChat };
}
