import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type Approval, type Conversation, type Profile, type WorkerStatus } from './api.ts';
import { ActivityPanel } from './ActivityPanel.tsx';
import { presenceOf } from './avatar.ts';
import { Chat, type RunNotice } from './Chat.tsx';
import { useRunEvents, type Draft, type RunEvent } from './events.ts';
import { useEscapeLayer } from './hooks.ts';
import { useT, type DictKey } from './i18n/index.ts';
import { approvalTargetHash, isChatRun, type RunContext } from './conversation-state.ts';
import { closeTopLayer, shortcutOf } from './keys.ts';
import { layoutModeFor, loadPanelPreference, savePanelPreference, type LayoutMode } from './layout.ts';
import { Memory } from './Memory.tsx';
import { NarrowHeader } from './NarrowHeader.tsx';
import { NotificationsPage } from './Notifications.tsx';
import { PAGE_META, pickChatModel } from './pages.ts';
import { chatHash, parseRoute } from './routes.ts';
import { Runs } from './Runs.tsx';
import { Settings } from './Settings.tsx';
import { Sidebar } from './Sidebar.tsx';
import { StatusBar } from './StatusBar.tsx';
import { TabBar } from './TabBar.tsx';
import { toast, ToastHost } from './toast.tsx';
import { Tooltip } from './Tooltip.tsx';
import { CuriosityPage, ReviewPage, SkillsPage } from './Review.tsx';
import { TasksPage } from './Tasks.tsx';
import { useTabs } from './useTabs.ts';

const RUN_LOOKUP_RETRY_MS = 1500;
const BROWSER_NOTIFY = new Set(['approval_needed', 'task_waiting']);
const MEMORY_NOTICE = { create: 'notice.memoryCreate', update: 'notice.memoryUpdate', forget: 'notice.memoryForget' } as const satisfies Record<'create' | 'update' | 'forget', DictKey>;
const MEMORY_TOAST = { create: 'toast.memoryCreate', update: 'toast.memoryUpdate', forget: 'toast.memoryForget' } as const satisfies Record<'create' | 'update' | 'forget', DictKey>;

export function App() {
  const t = useT();
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
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
  const [modelName, setModelName] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [runStarts, setRunStarts] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<LayoutMode>(() => layoutModeFor(window.innerWidth));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(() => loadPanelPreference());
  const celebrateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const taskStatus = useRef(new Map<string, string>());
  const lastChatHash = useRef('#/');
  const taskConversations = useRef(new Map<string, string>());

  const refreshList = useCallback(() => {
    void api.conversations().then(r => { setConversations(r.conversations); setConversationsLoaded(true); }).catch(() => undefined);
  }, []);
  const refreshApprovals = useCallback(() => { void api.approvals().then(r => setApprovals(r.approvals)).catch(() => undefined); }, []);
  const refreshWorker = useCallback(() => { void api.worker().then(setWorker).catch(() => undefined); }, []);
  const refreshTasks = useCallback(() => {
    void api.tasks().then(r => {
      setWaiting(new Set(r.active.filter(x => x.status === 'waiting').map(x => x.id)));
      for (const task of r.active) {
        taskStatus.current.set(task.id, task.status);
        if (task.conversation_id) taskConversations.current.set(task.conversation_id, task.id);
      }
    }).catch(() => undefined);
    void api.notifications().then(r => setUnread(r.unread)).catch(() => undefined);
  }, []);
  const refreshMeta = useCallback(() => {
    void api.models().then(r => setModelName(pickChatModel(r.models, r.routing))).catch(() => undefined);
    void api.settings().then(s => setRestartRequired(s.restartRequired)).catch(() => undefined);
  }, []);
  useEffect(() => {
    refreshList(); refreshApprovals(); refreshWorker(); refreshTasks(); refreshMeta();
    void api.profile().then(setProfile).catch(() => undefined);
  }, [refreshList, refreshApprovals, refreshWorker, refreshTasks, refreshMeta]);
  // 静かな時間帯や次に起きる時刻は時間とともに変わるので、ときどき取り直す
  useEffect(() => { const timer = setInterval(refreshWorker, 30_000); return () => clearInterval(timer); }, [refreshWorker]);
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  // 設定を保存したあと（設定の画面を離れたとき）に、再起動の要否とモデルを読み直す
  const wasSettings = useRef(false);
  useEffect(() => {
    if (wasSettings.current && route.page !== 'settings') refreshMeta();
    wasSettings.current = route.page === 'settings';
  }, [route.page, refreshMeta]);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const update = () => setMode(layoutModeFor(el.offsetWidth || window.innerWidth));
    update();
    if (typeof ResizeObserver !== 'function') { addEventListener('resize', update); return () => removeEventListener('resize', update); }
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setDrawerOpen(false);
    if (mode === 'mid') setPanelOpen(false);
    else if (mode === 'wide') setPanelOpen(loadPanelPreference());
  }, [mode]);

  const current = route.page === 'chat' ? route.conversationId : null;
  const tabState = useTabs(route, conversations, conversationsLoaded);
  useEffect(() => { if (route.page === 'chat') lastChatHash.current = chatHash(route.conversationId); }, [route]);

  // 「いまの動き」は、広い画面では右のパネル。#/today（古い通知のリンクなど）は、パネルを開いて直前の会話に戻す
  useEffect(() => {
    if (route.page !== 'today' || mode === 'narrow') return;
    setPanelOpen(true);
    history.replaceState(null, '', lastChatHash.current);
    setRoute(parseRoute(lastChatHash.current));
  }, [route.page, mode]);
  useEffect(() => { setDrawerOpen(false); }, [route]);
  useEscapeLayer('drawer', drawerOpen, () => setDrawerOpen(false));

  const panelRef = useRef(panelOpen); panelRef.current = panelOpen;
  const modeRef = useRef(mode); modeRef.current = mode;
  const showPanel = useCallback((open: boolean) => {
    setPanelOpen(open);
    if (modeRef.current === 'wide') savePanelPreference(open);
  }, []);
  const togglePanel = useCallback(() => { if (modeRef.current !== 'narrow') showPanel(!panelRef.current); }, [showPanel]);
  const openPanel = useCallback(() => {
    if (modeRef.current === 'narrow') location.hash = '#/today';
    else showPanel(true);
  }, [showPanel]);

  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const currentRef = useRef(current); currentRef.current = current;
  const conversationsRef = useRef(conversations); conversationsRef.current = conversations;
  const workerRef = useRef(worker); workerRef.current = worker;
  const runContext = (): RunContext => ({ taskConversations: taskConversations.current, running: workerRef.current?.running ?? null });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutOf(e);
      if (action === 'togglePanel') { e.preventDefault(); togglePanel(); return; }
      if (action !== 'escape') return;
      if (closeTopLayer()) { e.preventDefault(); return; }
      // 返事を止めるのは、入力欄にフォーカスがあるときだけ
      if (!(document.activeElement instanceof HTMLElement) || !document.activeElement.hasAttribute('data-composer')) return;
      const draft = draftsRef.current.find(d => d.conversationId === currentRef.current);
      if (draft) void api.stop(draft.runId);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [togglePanel]);

  const addNotice = (conversationId: string, notice: RunNotice) =>
    setNotices(state => ({ ...state, [conversationId]: [...(state[conversationId] ?? []), notice].slice(-8) }));
  const bump = (conversationId: string) => setRevisions(state => ({ ...state, [conversationId]: (state[conversationId] ?? 0) + 1 }));
  const approvalTarget = useCallback((a: Pick<Approval, 'conversationId' | 'runId'>) => approvalTargetHash(a, runContext()), []);

  const onEvent = useCallback((e: RunEvent) => {
    switch (e.type) {
      case 'run.start':
        setDrafts(ds => [...ds.filter(d => d.runId !== e.runId), { runId: e.runId, conversationId: e.conversationId, modelId: e.modelId, text: '' }]);
        setRunStarts(starts => ({ ...starts, [e.runId]: Date.now() }));
        refreshWorker();
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
        // 今見ている会話なら、承認の札がそこにあるので知らせない
        if (!(currentRef.current === e.conversationId && !document.hidden)) {
          toast({
            kind: 'approval', title: t('toast.approvalNeeded'), body: e.approval.title,
            action: { label: t('toast.open'), run: () => { location.hash = approvalTarget({ conversationId: e.conversationId, runId: e.runId }); } },
          });
        }
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(t('browser.approvalNeeded'), { body: e.approval.title });
        break;
      case 'approval.resolved':
        setApprovals(list => list.filter(a => a.id !== e.approvalId));
        break;
      case 'memory.changed':
        addNotice(e.conversationId, { runId: e.runId, kind: 'memory', message: t(MEMORY_NOTICE[e.action], e.content), eventId: e.eventId });
        toast({ kind: 'memory', title: t(MEMORY_TOAST[e.action]), body: e.content });
        break;
      case 'run.end': {
        setDrafts(ds => ds.filter(d => d.runId !== e.runId));
        setRunStarts(({ [e.runId]: _ended, ...rest }) => rest);
        bump(e.conversationId);
        refreshList();
        refreshWorker();
        if (!e.ok && e.errorKind !== 'cancelled') {
          addNotice(e.conversationId, { runId: e.runId, kind: 'error', message: t('notice.runFailed', e.errorMessage ?? e.errorKind ?? ''), hint: e.detail?.hint });
        }
        if (e.ok && isChatRun(e.runId, e.conversationId, runContext()) && (document.hidden || currentRef.current !== e.conversationId)) {
          const title = conversationsRef.current.find(c => c.id === e.conversationId)?.title ?? t('conversation.untitled');
          toast({
            kind: 'done', icon: 'msg', title: t('toast.replyReady'), body: title,
            action: { label: t('toast.open'), run: () => { location.hash = chatHash(e.conversationId); } },
          });
        }
        break;
      }
      case 'task.changed': {
        setTaskRevision(n => n + 1);
        setWaiting(state => {
          const next = new Set(state);
          if (e.task.status === 'waiting') next.add(e.task.id); else next.delete(e.task.id);
          return next;
        });
        if (e.task.conversation_id) taskConversations.current.set(e.task.conversation_id, e.task.id);
        const before = taskStatus.current.get(e.task.id);
        taskStatus.current.set(e.task.id, e.task.status);
        if (e.task.status === 'done') {
          setCelebrating(true);
          clearTimeout(celebrateTimer.current);
          celebrateTimer.current = setTimeout(() => setCelebrating(false), 1200);
          if (before !== undefined && before !== 'done') {
            toast({
              kind: 'done', title: t('toast.taskDone'), body: e.task.title,
              action: { label: t('toast.open'), run: () => { location.hash = `#/tasks/${encodeURIComponent(e.task.id)}`; } },
            });
          }
        }
        refreshWorker();
        break;
      }
      case 'notification':
        setUnread(n => n + 1);
        setNotificationRevision(n => n + 1);
        if (BROWSER_NOTIFY.has(e.notification.kind) && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(t('browser.notification', e.notification.title), { body: e.notification.body ?? '' });
        }
        break;
    }
  }, [t, refreshList, refreshWorker, approvalTarget]);

  const onResync = useCallback((serverDrafts: Draft[]) => {
    setDrafts(serverDrafts);
    setRevisions(state => Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v + 1])));
    setTaskRevision(n => n + 1);
    refreshList(); refreshApprovals(); refreshWorker(); refreshTasks(); refreshMeta();
  }, [refreshList, refreshApprovals, refreshWorker, refreshTasks, refreshMeta]);

  // 承認待ちや返事待ちに気づけるよう、初回だけブラウザ通知の許可を求める（拒否されたらそれまで）
  useEffect(() => {
    if ((approvals.length || waiting.size) && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
  }, [approvals.length, waiting.size]);

  // 実行中の経過時間: 見ている間に始まったものは run.start を受けた時刻、読み直したときは実行の記録の started_at
  const runningId = worker?.running?.runId;
  // 実行の記録がまだ無い・読めなかったときは、1 度だけ少し待ってやり直す
  useEffect(() => {
    if (!runningId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lookup = (retriesLeft: number) => {
      const retry = () => { if (!cancelled && retriesLeft > 0) timer = setTimeout(() => lookup(retriesLeft - 1), RUN_LOOKUP_RETRY_MS); };
      void api.runs().then(r => {
        if (cancelled) return;
        const run = r.runs.find(x => x.id === runningId);
        if (run) setRunStarts(starts => (starts[runningId] === undefined ? { ...starts, [runningId]: run.started_at } : starts));
        else retry();
      }).catch(retry);
    };
    lookup(1);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [runningId]);

  const { connected, reconnect } = useRunEvents(onEvent, onResync);
  const presence = presenceOf({
    generating: drafts.some(d => d.runId !== worker?.running?.runId),
    runningTask: worker?.running?.title ?? null,
    approvals: approvals.length,
    waitingTasks: waiting.size,
    paused: Boolean(worker?.paused),
    quiet: Boolean(worker?.quiet && worker.autonomy),
    celebrating,
  });

  const narrow = mode === 'narrow';
  const firstApproval = approvals[0];
  const openApproval = () => { if (firstApproval) location.hash = approvalTarget(firstApproval); };
  const openRunning = () => {
    const running = worker?.running;
    if (running) location.hash = running.kind === 'task' && running.taskId ? `#/tasks/${encodeURIComponent(running.taskId)}` : '#/review';
  };
  const title = route.page === 'chat'
    ? (current ? conversations.find(c => c.id === current)?.title ?? t('conversation.untitled') : t('tab.newChat'))
    : t(PAGE_META[route.page].label);
  const pane = (
    <ActivityPanel
      variant={narrow ? 'page' : 'side'} open={panelOpen} overlay={mode === 'mid'} profile={profile} presence={presence}
      approvals={approvals.length} unread={unread} worker={worker} onWorker={setWorker} revision={taskRevision} onClose={() => showPanel(false)}
    />
  );
  const viewKey = route.page === 'chat' ? `chat:${current ?? 'new'}` : route.page;

  return (
    <div className="shell" ref={rootRef} data-mode={mode}>
      <div className="shell-body">
        <Sidebar
          mode={mode} drawerOpen={drawerOpen} route={route} profile={profile} presence={presence}
          conversations={conversations} conversationsLoaded={conversationsLoaded} drafts={drafts} approvals={approvals}
          waitingCount={waiting.size} unread={unread} restartRequired={restartRequired}
          onNavigate={() => setDrawerOpen(false)} onNewChat={tabState.openNewChat} onAvatar={openPanel}
        />
        {narrow && drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
        <main className="main">
          {narrow
            ? <NarrowHeader title={title} phrase={presence.line} connected={connected} hasApproval={approvals.length > 0} unread={unread} onMenu={() => setDrawerOpen(true)} onApproval={openApproval} />
            : (
              <TabBar
                tabs={tabState.tabs} activeKey={tabState.activeKey} conversations={conversations} drafts={drafts} approvals={approvals}
                panelOpen={panelOpen} onClose={tabState.close} onNewChat={tabState.openNewChat} onTogglePanel={togglePanel}
              />
            )}
          <div className="content" key={viewKey}>
            {route.page === 'chat' && (
              <Chat
                key={current ?? 'new'}
                conversationId={current}
                drafts={drafts}
                notices={current ? notices[current] ?? [] : []}
                approvals={current ? approvals.filter(a => a.conversationId === current) : []}
                revision={current ? revisions[current] ?? 0 : 0}
                onCreated={id => { location.hash = chatHash(id); refreshList(); }}
                onClearNotices={id => setNotices(n => ({ ...n, [id]: [] }))}
              />
            )}
            {route.page === 'today' && narrow && pane}
            {route.page === 'tasks' && <TasksPage key={route.taskId ?? 'list'} taskId={route.taskId} revision={taskRevision + approvals.length} worker={worker} onWorker={setWorker} />}
            {route.page === 'notifications' && <NotificationsPage revision={notificationRevision} onRead={setUnread} />}
            {route.page === 'settings' && <Settings onProfile={setProfile} />}
            {route.page === 'runs' && <Runs />}
            {route.page === 'memory' && <Memory />}
            {route.page === 'review' && <ReviewPage revision={taskRevision + notificationRevision} />}
            {route.page === 'skills' && <SkillsPage />}
            {route.page === 'curiosity' && <CuriosityPage revision={taskRevision} />}
          </div>
        </main>
        {!narrow && pane}
      </div>
      {!narrow && (
        <StatusBar
          connected={connected} worker={worker} runStartedAt={runningId ? runStarts[runningId] : undefined} approvals={approvals.length}
          modelName={modelName} unread={unread} onReconnect={reconnect} onOpenPanel={openPanel} onOpenRunning={openRunning}
          onOpenApproval={openApproval} onOpenNotifications={() => { location.hash = '#/notifications'; }}
        />
      )}
      <ToastHost mode={mode} />
      <Tooltip disabled={narrow} />
    </div>
  );
}
