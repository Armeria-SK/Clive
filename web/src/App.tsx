import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type Approval, type Conversation, type Profile, type WorkerStatus } from './api.ts';
import { Avatar } from './Avatar.tsx';
import { presenceOf } from './avatar.ts';
import { Chat, type RunNotice } from './Chat.tsx';
import { useRunEvents, type Draft, type RunEvent } from './events.ts';
import { useT, type DictKey } from './i18n/index.ts';
import { Memory } from './Memory.tsx';
import { NotificationsPage } from './Notifications.tsx';
import { Runs } from './Runs.tsx';
import { Settings } from './Settings.tsx';
import { CuriosityPage, ReviewPage, SkillsPage } from './Review.tsx';
import { TasksPage } from './Tasks.tsx';
import { Today } from './Today.tsx';

type Route =
  | { page: 'chat'; conversationId: string | null }
  | { page: 'tasks'; taskId: string | null }
  | { page: 'today' } | { page: 'notifications' } | { page: 'settings' } | { page: 'runs' } | { page: 'memory' }
  | { page: 'review' } | { page: 'skills' } | { page: 'curiosity' };

function parseRoute(hash: string): Route {
  if (hash.startsWith('#/settings')) return { page: 'settings' };
  if (hash.startsWith('#/runs')) return { page: 'runs' };
  if (hash.startsWith('#/memory')) return { page: 'memory' };
  if (hash.startsWith('#/today')) return { page: 'today' };
  if (hash.startsWith('#/notifications')) return { page: 'notifications' };
  if (hash.startsWith('#/review')) return { page: 'review' };
  if (hash.startsWith('#/skills')) return { page: 'skills' };
  if (hash.startsWith('#/curiosity')) return { page: 'curiosity' };
  const task = /^#\/tasks(?:\/([^/]+))?$/u.exec(hash);
  if (task) return { page: 'tasks', taskId: task[1] ? decodeURIComponent(task[1]) : null };
  const m = /^#\/c\/([^/]+)$/u.exec(hash);
  return { page: 'chat', conversationId: m ? decodeURIComponent(m[1]!) : null };
}

const BROWSER_NOTIFY = new Set(['approval_needed', 'task_waiting']);
const MEMORY_NOTICE = { create: 'notice.memoryCreate', update: 'notice.memoryUpdate', forget: 'notice.memoryForget' } as const satisfies Record<'create' | 'update' | 'forget', DictKey>;

export function App() {
  const t = useT();
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [notices, setNotices] = useState<Record<string, RunNotice[]>>({});
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [unread, setUnread] = useState(0);
  const [waiting, setWaiting] = useState<Set<string>>(new Set());
  const [taskRevision, setTaskRevision] = useState(0);
  const [notificationRevision, setNotificationRevision] = useState(0);
  const [celebrating, setCelebrating] = useState(false);
  const celebrateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refreshList = useCallback(() => { void api.conversations().then(r => setConversations(r.conversations)).catch(() => undefined); }, []);
  const refreshApprovals = useCallback(() => { void api.approvals().then(r => setApprovals(r.approvals)).catch(() => undefined); }, []);
  const refreshWorker = useCallback(() => { void api.worker().then(setWorker).catch(() => undefined); }, []);
  const refreshTasks = useCallback(() => {
    void api.tasks().then(r => setWaiting(new Set(r.active.filter(t => t.status === 'waiting').map(t => t.id)))).catch(() => undefined);
    void api.notifications().then(r => setUnread(r.unread)).catch(() => undefined);
  }, []);
  useEffect(() => {
    refreshList(); refreshApprovals(); refreshWorker(); refreshTasks();
    void api.profile().then(setProfile).catch(() => undefined);
  }, [refreshList, refreshApprovals, refreshWorker, refreshTasks]);
  // 静かな時間帯や次に起きる時刻は時間とともに変わるので、ときどき取り直す
  useEffect(() => { const t = setInterval(refreshWorker, 30_000); return () => clearInterval(t); }, [refreshWorker]);
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const addNotice = (conversationId: string, notice: RunNotice) =>
    setNotices(current => ({ ...current, [conversationId]: [...(current[conversationId] ?? []), notice].slice(-8) }));
  const bump = (conversationId: string) => setRevisions(current => ({ ...current, [conversationId]: (current[conversationId] ?? 0) + 1 }));

  const onEvent = useCallback((e: RunEvent) => {
    switch (e.type) {
      case 'run.start':
        setDrafts(ds => [...ds.filter(d => d.runId !== e.runId), { runId: e.runId, conversationId: e.conversationId, modelId: e.modelId, text: '' }]);
        break;
      case 'model.switch':
        setDrafts(ds => ds.map(d => d.runId === e.runId ? { ...d, modelId: e.to, text: '' } : d));
        addNotice(e.conversationId, { runId: e.runId, kind: 'switch', message: t('notice.modelSwitch', e.from, e.to, e.reason) });
        break;
      case 'text.delta':
        setDrafts(ds => ds.map(d => d.runId === e.runId ? { ...d, text: d.text + e.text } : d));
        break;
      case 'warning':
        addNotice(e.conversationId, { runId: e.runId, kind: 'warning', message: e.message });
        break;
      case 'message.saved':
        bump(e.conversationId);
        if (e.role === 'user') refreshList();
        if (e.role === 'assistant') setDrafts(ds => ds.map(d => d.runId === e.runId ? { ...d, text: '' } : d));
        break;
      case 'tool.call':
        setDrafts(ds => ds.map(d => d.runId === e.runId ? { ...d, activeTool: e.name } : d));
        break;
      case 'tool.result':
        setDrafts(ds => ds.map(d => d.runId === e.runId ? { ...d, activeTool: undefined } : d));
        if (e.decision === 'deny') addNotice(e.conversationId, { runId: e.runId, kind: 'warning', message: t('notice.toolDenied', e.name, e.preview.split('\n').slice(1, 3).join(' ')) });
        break;
      case 'approval.requested':
        setApprovals(list => [...list.filter(a => a.id !== e.approval.id), { ...e.approval, runId: e.runId, conversationId: e.conversationId }]);
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(t('browser.approvalNeeded'), { body: e.approval.title });
        break;
      case 'approval.resolved':
        setApprovals(list => list.filter(a => a.id !== e.approvalId));
        break;
      case 'memory.changed':
        addNotice(e.conversationId, { runId: e.runId, kind: 'memory', message: t(MEMORY_NOTICE[e.action], e.content), eventId: e.eventId });
        break;
      case 'run.end':
        setDrafts(ds => ds.filter(d => d.runId !== e.runId));
        bump(e.conversationId);
        refreshList();
        refreshWorker();
        if (!e.ok && e.errorKind !== 'cancelled') {
          addNotice(e.conversationId, { runId: e.runId, kind: 'error', message: t('notice.runFailed', e.errorMessage ?? e.errorKind ?? ''), hint: e.detail?.hint });
        }
        break;
      case 'task.changed':
        setTaskRevision(n => n + 1);
        setWaiting(current => {
          const next = new Set(current);
          if (e.task.status === 'waiting') next.add(e.task.id); else next.delete(e.task.id);
          return next;
        });
        if (e.task.status === 'done') {
          setCelebrating(true);
          clearTimeout(celebrateTimer.current);
          celebrateTimer.current = setTimeout(() => setCelebrating(false), 1200);
        }
        refreshWorker();
        break;
      case 'notification':
        setUnread(n => n + 1);
        setNotificationRevision(n => n + 1);
        if (BROWSER_NOTIFY.has(e.notification.kind) && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(t('browser.notification', e.notification.title), { body: e.notification.body ?? '' });
        }
        break;
    }
  }, [t, refreshList, refreshWorker]);

  const onResync = useCallback((serverDrafts: Draft[]) => {
    setDrafts(serverDrafts);
    setRevisions(current => Object.fromEntries(Object.entries(current).map(([k, v]) => [k, v + 1])));
    setTaskRevision(n => n + 1);
    refreshList(); refreshApprovals(); refreshWorker(); refreshTasks();
  }, [refreshList, refreshApprovals, refreshWorker, refreshTasks]);

  // 承認待ちや返事待ちに気づけるよう、初回だけブラウザ通知の許可を求める（拒否されたらそれまで）
  useEffect(() => {
    if ((approvals.length || waiting.size) && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
  }, [approvals.length, waiting.size]);

  const connected = useRunEvents(onEvent, onResync);
  const current = route.page === 'chat' ? route.conversationId : null;
  const presence = presenceOf({
    generating: drafts.some(d => d.runId !== worker?.running?.runId),
    runningTask: worker?.running?.title ?? null,
    approvals: approvals.length,
    waitingTasks: waiting.size,
    paused: Boolean(worker?.paused),
    quiet: Boolean(worker?.quiet && worker.autonomy),
    celebrating,
  });
  const navLink = (href: string, page: Route['page'], label: string, extra?: ReactNode) =>
    <a href={href} className={route.page === page ? 'active' : ''}>{label}{extra}</a>;

  return (
    <div className="layout">
      <nav className="sidebar">
        <a className="brand" href="#/today" title={presence.line}>
          {profile
            ? <Avatar shape={profile.shape} color={profile.color} motion={profile.motion} runtime={presence.runtime} sleeping={presence.sleeping} size={28} seed={profile.name} />
            : <img src="/icon.svg" alt="" width={24} height={24} />}
          <span>{profile?.name ?? 'Clive'}</span>
          <span className={`dot ${connected ? 'on' : 'off'}`} title={connected ? t('connection.on') : t('connection.off')} />
        </a>
        <a className="new" href="#/">{t('nav.newChat')}</a>
        <ul className="conversations">
          {conversations.map(c => (
            <li key={c.id} className={c.id === current ? 'active' : ''}>
              <a href={`#/c/${encodeURIComponent(c.id)}`}>{c.title ?? t('conversation.untitled')}</a>
              {approvals.some(a => a.conversationId === c.id) && <span className="tag attention" title={t('conversation.needsApprovalTip')}>{t('conversation.needsApproval')}</span>}
              {drafts.some(d => d.conversationId === c.id) && <span className="dot on" title={t('conversation.generating')} />}
            </li>
          ))}
        </ul>
        <div className="nav-bottom">
          {navLink('#/today', 'today', t('nav.today'))}
          {navLink('#/tasks', 'tasks', t('nav.tasks'), waiting.size > 0 ? <span className="tag attention">{t('nav.tasksWaiting', waiting.size)}</span> : null)}
          {navLink('#/notifications', 'notifications', t('nav.notifications'), unread > 0 ? <span className="count-badge">{unread}</span> : null)}
          {navLink('#/review', 'review', t('nav.review'))}
          {navLink('#/memory', 'memory', t('nav.memory'))}
          {navLink('#/skills', 'skills', t('nav.skills'))}
          {navLink('#/curiosity', 'curiosity', t('nav.curiosity'))}
          {navLink('#/settings', 'settings', t('nav.settings'))}
          {navLink('#/runs', 'runs', t('nav.runs'))}
        </div>
      </nav>
      <main>
        {route.page === 'chat' && (
          <Chat
            key={current ?? 'new'}
            conversationId={current}
            drafts={drafts}
            notices={current ? notices[current] ?? [] : []}
            approvals={current ? approvals.filter(a => a.conversationId === current) : []}
            revision={current ? revisions[current] ?? 0 : 0}
            onCreated={id => { location.hash = `#/c/${encodeURIComponent(id)}`; refreshList(); }}
            onClearNotices={id => setNotices(n => ({ ...n, [id]: [] }))}
          />
        )}
        {route.page === 'today' && <Today profile={profile} presence={presence} approvals={approvals.length} unread={unread} worker={worker} onWorker={setWorker} revision={taskRevision} />}
        {route.page === 'tasks' && <TasksPage key={route.taskId ?? 'list'} taskId={route.taskId} revision={taskRevision + approvals.length} worker={worker} onWorker={setWorker} />}
        {route.page === 'notifications' && <NotificationsPage revision={notificationRevision} onRead={setUnread} />}
        {route.page === 'settings' && <Settings onProfile={setProfile} />}
        {route.page === 'runs' && <Runs />}
        {route.page === 'memory' && <Memory />}
        {route.page === 'review' && <ReviewPage revision={taskRevision + notificationRevision} />}
        {route.page === 'skills' && <SkillsPage />}
        {route.page === 'curiosity' && <CuriosityPage revision={taskRevision} />}
      </main>
    </div>
  );
}
