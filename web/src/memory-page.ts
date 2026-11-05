import type { PlainKey } from './i18n/index.ts';

// 記憶のページの、画面を使わない部分。サーバーの値（出どころ・変更の種類・やった人・発言の役）を辞書のキーに結びつける。

export type MemoryTab = 'user' | 'notes' | 'search';
export const MEMORY_TABS: readonly MemoryTab[] = ['user', 'notes', 'search'];

export const BOOK_TAB_KEY = { user: 'memory.tab.user', notes: 'memory.tab.notes' } as const satisfies Record<'user' | 'notes', PlainKey>;
export const TAB_KEY = { ...BOOK_TAB_KEY, search: 'memory.tab.search' } as const satisfies Record<MemoryTab, PlainKey>;

export function originKey(origin: string): PlainKey {
  if (origin === 'user') return 'memory.origin.user';
  if (origin === 'review') return 'memory.origin.review';
  return 'memory.origin.clive';
}

const ACTION_KEY: Record<string, PlainKey> = {
  create: 'memory.action.create', update: 'memory.action.update', forget: 'memory.action.forget', restore: 'memory.action.restore',
};
const ACTOR_KEY: Record<string, PlainKey> = { clive: 'memory.actor.clive', user: 'memory.actor.user', review: 'memory.actor.review' };
const ROLE_KEY: Record<string, PlainKey> = { user: 'memory.role.user', assistant: 'memory.role.assistant', tool: 'memory.role.tool' };

// 知らない値は、サーバーの文字のまま出す（キーを持たない）。
export const actionKey = (action: string): PlainKey | undefined => ACTION_KEY[action];
export const actorKey = (actor: string): PlainKey | undefined => ACTOR_KEY[actor];
export const roleKey = (role: string): PlainKey | undefined => ROLE_KEY[role];

// 取り消せるのは、まだ取り消していない、復元ではない変更だけ。
export const canUndo = (event: { action: string; undone_at: number | null }): boolean => !event.undone_at && event.action !== 'restore';

// 本の [u12] / [n3] の短い呼び名（Clive が会話の中で使うのと同じ）。
export const memoryRef = (item: { book: string; id: number }): string => `[${item.book === 'user' ? 'u' : 'n'}${item.id}]`;
