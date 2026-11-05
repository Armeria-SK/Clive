export interface SkillTarget { kind: 'skill' | 'draft'; name: string }
export type RunsTab = 'tools' | 'reviews';

export type Route =
  | { page: 'chat'; conversationId: string | null }
  | { page: 'tasks'; taskId: string | null; section?: 'curiosity' }
  | { page: 'today' } | { page: 'notifications' } | { page: 'settings' } | { page: 'memory' }
  | { page: 'runs'; tab?: RunsTab }
  | { page: 'review' } | { page: 'skills'; target?: SkillTarget };

export type Page = Route['page'];

// 設定はモーダルで開くので、後ろには直前に開いていたページを残して描く。直前が無ければ（設定を直接開いたとき）新しい会話。
export const HOME_ROUTE: Route = { page: 'chat', conversationId: null };

export function pageBehind(route: Route, previous: Route | null): Route {
  return route.page === 'settings' ? previous ?? HOME_ROUTE : route;
}

// 通知はリンクの文字列をデータベースに残すので、古い経路もずっと受け付ける。
// 行き先が新しい画面に移る段階では、ここの返り値を変える。
export function parseRoute(hash: string): Route {
  if (hash.startsWith('#/settings')) return { page: 'settings' };
  if (hash.startsWith('#/runs')) return runsRoute(hash);
  if (hash.startsWith('#/memory')) return { page: 'memory' };
  if (hash.startsWith('#/today')) return { page: 'today' };
  if (hash.startsWith('#/notifications')) return { page: 'notifications' };
  if (hash.startsWith('#/review')) return { page: 'review' };
  if (hash.startsWith('#/skills')) return skillsRoute(hash);
  if (hash.startsWith('#/curiosity')) return { page: 'tasks', taskId: null, section: 'curiosity' };
  const task = /^#\/tasks(?:\/([^/]+))?$/u.exec(hash);
  if (task) return { page: 'tasks', taskId: task[1] ? safeDecode(task[1]) : null };
  const m = /^#\/c\/([^/]+)$/u.exec(hash);
  return { page: 'chat', conversationId: m ? safeDecode(m[1]!) : null };
}

// #/skills/<名前> はそのスキル、#/skills/draft/<名前> はその名前のレビュー待ちの下書きを開く。
function skillsRoute(hash: string): Route {
  const draft = /^#\/skills\/draft\/([^/?#]+)/u.exec(hash);
  if (draft) return { page: 'skills', target: { kind: 'draft', name: safeDecode(draft[1]!) } };
  const skill = /^#\/skills\/([^/?#]+)/u.exec(hash);
  return skill ? { page: 'skills', target: { kind: 'skill', name: safeDecode(skill[1]!) } } : { page: 'skills' };
}

// #/runs/tools は道具の表、#/runs/reviews は振り返りの記録。何も付かなければ実行の表。
function runsRoute(hash: string): Route {
  const tab = /^#\/runs\/(tools|reviews)(?:[/?#]|$)/u.exec(hash);
  return tab ? { page: 'runs', tab: tab[1] as RunsTab } : { page: 'runs' };
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
    case 'skills': return route.target ? `#/skills/${route.target.kind === 'draft' ? 'draft/' : ''}${encodeURIComponent(route.target.name)}` : '#/skills';
    case 'runs': return route.tab ? `#/runs/${route.tab}` : '#/runs';
    default: return `#/${route.page}`;
  }
}
