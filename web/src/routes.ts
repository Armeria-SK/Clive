export type Route =
  | { page: 'chat'; conversationId: string | null }
  | { page: 'tasks'; taskId: string | null }
  | { page: 'today' } | { page: 'notifications' } | { page: 'settings' } | { page: 'runs' } | { page: 'memory' }
  | { page: 'review' } | { page: 'skills' } | { page: 'curiosity' };

export type Page = Route['page'];

// 通知はリンクの文字列をデータベースに残すので、古い経路もずっと受け付ける。
// 行き先が新しい画面に移る段階では、ここの返り値を変える。
export function parseRoute(hash: string): Route {
  if (hash.startsWith('#/settings')) return { page: 'settings' };
  if (hash.startsWith('#/runs')) return { page: 'runs' };
  if (hash.startsWith('#/memory')) return { page: 'memory' };
  if (hash.startsWith('#/today')) return { page: 'today' };
  if (hash.startsWith('#/notifications')) return { page: 'notifications' };
  if (hash.startsWith('#/review')) return { page: 'review' };
  if (hash.startsWith('#/skills')) return { page: 'skills' };
  if (hash.startsWith('#/curiosity')) return { page: 'curiosity' };
  const task = /^#\/tasks(?:\/([^/]+))?$/u.exec(hash);
  if (task) return { page: 'tasks', taskId: task[1] ? safeDecode(task[1]) : null };
  const m = /^#\/c\/([^/]+)$/u.exec(hash);
  return { page: 'chat', conversationId: m ? safeDecode(m[1]!) : null };
}

function safeDecode(part: string): string {
  try { return decodeURIComponent(part); } catch { return part; }
}

export function chatHash(conversationId: string | null): string {
  return conversationId ? `#/c/${encodeURIComponent(conversationId)}` : '#/';
}

export function routeHash(route: Route): string {
  switch (route.page) {
    case 'chat': return chatHash(route.conversationId);
    case 'tasks': return route.taskId ? `#/tasks/${encodeURIComponent(route.taskId)}` : '#/tasks';
    default: return `#/${route.page}`;
  }
}
