import type { IconName } from './icon-paths.ts';

export type PaletteGroupKey = 'actions' | 'conversations' | 'tasks' | 'skills';

export interface PaletteItem {
  id: string;
  label: string;
  sub: string;
  hint: string;
  icon: IconName;
  run: () => void;
}

export interface PaletteGroup { key: PaletteGroupKey; label: string; items: PaletteItem[] }

// 空欄のとき、操作はすべて、会話・タスク・スキルは 4 件ずつ（デザインの動き）。
export const EMPTY_QUERY_LIMIT = 4;

const fold = (text: string): string => text.normalize('NFKC').toLowerCase();

export function filterPalette(groups: readonly PaletteGroup[], query: string): PaletteGroup[] {
  const q = fold(query.trim());
  return groups
    .map(group => ({ ...group, items: group.items.filter(item => !q || fold(`${item.label} ${item.sub}`).includes(q)) }))
    .filter(group => group.items.length > 0)
    .map(group => (!q && group.key !== 'actions' ? { ...group, items: group.items.slice(0, EMPTY_QUERY_LIMIT) } : group));
}

export const flattenPalette = (groups: readonly PaletteGroup[]): PaletteItem[] => groups.flatMap(group => group.items);

// ↑↓ は端で止まる（巻き戻らない）。
export function moveIndex(index: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, index + delta));
}
