// 通知の一覧の並べ方。サーバーの API と画面が同じ決まりで並べる。
// 持ち主の判断が要る未読（承認待ち・タスクの質問・タスクの失敗）は、新しい通知が何件続いても件数の上限で押し出さず、一覧の先頭に出す。件数の上限は設けない。
export const NOTIFICATION_LIST_LIMIT = 50;
export const PINNED_KINDS = ['approval_needed', 'task_waiting', 'task_failed'] as const;

export interface Listed { id: number; kind: string; read_at: number | null }

export const isPinned = (n: Listed): boolean => n.read_at === null && (PINNED_KINDS as readonly string[]).includes(n.kind);

// 新しい順に limit 件 + 先頭に出す未読をすべて。同じ id は、先に来たほうを使う
export function arrangeNotifications<T extends Listed>(items: readonly T[], limit: number): T[] {
  const byId = new Map<number, T>();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
  const newestFirst = [...byId.values()].sort((a, b) => b.id - a.id);
  const recent = new Set(newestFirst.slice(0, limit).map(n => n.id));
  const kept = newestFirst.filter(n => recent.has(n.id) || isPinned(n));
  return [...kept.filter(isPinned), ...kept.filter(n => !isPinned(n))];
}
