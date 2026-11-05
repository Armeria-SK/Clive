import { parseRoute, routeHash, type Page } from './routes.ts';

export interface Tab { key: string; hash: string }

export const MAX_TABS = 10;
const STORAGE_KEY = 'clive.tabs';
export const NEW_CHAT_TAB: Tab = { key: 'chat:new', hash: '#/' };

export function toTab(hash: string): Tab | null {
  const route = parseRoute(hash);
  if (route.page === 'today') return null;
  const key = route.page === 'chat' ? `chat:${route.conversationId ?? 'new'}` : route.page;
  return { key, hash: routeHash(route) };
}

export const isChatTab = (tab: Tab): boolean => tab.key.startsWith('chat:');
export const chatIdOf = (tab: Tab): string | null => (isChatTab(tab) && tab.key !== 'chat:new' ? tab.key.slice(5) : null);
export const pageOfTab = (tab: Tab): Page => (isChatTab(tab) ? 'chat' : tab.key as Page);

function limit(tabs: Tab[], keepKey: string): Tab[] {
  const out = [...tabs];
  while (out.length > MAX_TABS) {
    const drop = out.findIndex(t => t.key !== keepKey);
    if (drop < 0) break;
    out.splice(drop, 1);
  }
  return out;
}

// 経路を開いたときのタブの更新。すでにあるタブは行き先（#/tasks/<id> など）だけ更新する。
// 会話から会話へ移るときは、今の会話のタブを置き換える（append のときだけ並べて足す）。
export function openTab(tabs: Tab[], hash: string, options: { activeKey: string | null; append?: boolean }): Tab[] {
  const target = toTab(hash);
  if (!target) return tabs;
  const at = tabs.findIndex(t => t.key === target.key);
  if (at >= 0) return tabs[at]!.hash === target.hash ? tabs : tabs.map((t, i) => (i === at ? target : t));
  const current = options.append || !isChatTab(target) ? -1 : tabs.findIndex(t => t.key === options.activeKey && isChatTab(t));
  const next = current >= 0 ? tabs.map((t, i) => (i === current ? target : t)) : [...tabs, target];
  return limit(next, target.key);
}

export function closeTab(tabs: Tab[], key: string, activeKey: string | null): { tabs: Tab[]; go: string | null } {
  const at = tabs.findIndex(t => t.key === key);
  if (at < 0) return { tabs, go: null };
  const rest = tabs.filter(t => t.key !== key);
  if (!rest.length) return { tabs: [NEW_CHAT_TAB], go: '#/' };
  if (key !== activeKey) return { tabs: rest, go: null };
  return { tabs: rest, go: rest[Math.min(at, rest.length - 1)]!.hash };
}

// 会話の一覧は 100 件までなので、一覧に無い = 消えた、とは言えない。一覧に無い会話のタブだけを、1 つずつ確かめる対象にする。
export function unlistedChatIds(tabs: readonly Tab[], listedIds: ReadonlySet<string>, keepKey: string | null): string[] {
  return tabs.flatMap(t => {
    const id = chatIdOf(t);
    return id !== null && !listedIds.has(id) && t.key !== keepKey ? [id] : [];
  });
}

export type ChatProbe = 'exists' | 'gone' | 'unknown';

// サーバーが「無い」（404）と答えた会話だけを返す。読めなかったとき（通信の失敗など）は消えたと見なさない。
export async function findGoneChats(ids: readonly string[], probe: (id: string) => Promise<ChatProbe>): Promise<Set<string>> {
  const results = await Promise.all(ids.map(async id => [id, await probe(id).catch((): ChatProbe => 'unknown')] as const));
  return new Set(results.filter(([, verdict]) => verdict === 'gone').map(([id]) => id));
}

export function dropChats(tabs: Tab[], goneIds: ReadonlySet<string>, keepKey: string | null): Tab[] {
  const kept = tabs.filter(t => {
    const id = chatIdOf(t);
    return id === null || !goneIds.has(id) || t.key === keepKey;
  });
  return kept.length === tabs.length ? tabs : kept;
}

export function sanitizeTabs(value: unknown): Tab[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tab = toTab(item);
    if (!tab || seen.has(tab.key)) continue;
    seen.add(tab.key);
    tabs.push(tab);
  }
  return tabs.slice(0, MAX_TABS);
}

export function loadTabs(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Tab[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return raw ? sanitizeTabs(JSON.parse(raw)) : [];
  } catch { return []; }
}

export function saveTabs(tabs: readonly Tab[], storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(tabs.map(t => t.hash))); } catch { }
}

function safeStorage(): Storage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}
