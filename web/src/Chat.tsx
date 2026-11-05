import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, type Approval, type Message, type ModelView, type Profile, type UploadView } from './api.ts';
import { ApprovalDock } from './ApprovalCard.tsx';
import { decideApproval } from './approval-decide.ts';
import {
  advanceApprovalGate, approvalEnterAllowed, contextCardOf, enterApprovalId, isNearBottom, isRenameWithoutTitle, joinsToolRun, renameTitleOf, restartApprovalGate, runOverflowOf, sendFailureOf, sendTarget, toolInputSummary,
  type ApprovalGate, type ChatItemKind, type ChatRunRow, type ContextCardData, type SendFailure, type SlashCommand,
} from './chat-logic.ts';
import { ChatDialog } from './ChatDialog.tsx';
import {
  AssistantMessage, EmptyChat, FailureCard, LiveReply, MemoryRow, NoteRow, PreSendCard, RunningTool, SendErrorCard, ThinkingRow, ToolMessage, UserMessage,
} from './ChatMessages.tsx';
import { Composer } from './Composer.tsx';
import type { Draft } from './events.ts';
import { useT } from './i18n/index.ts';
import type { IconName } from './icons.tsx';
import { toast } from './toast.tsx';

export { ApprovalCard } from './ApprovalCard.tsx';
export { ToolMessage } from './ChatMessages.tsx';

export interface RunNotice {
  runId: string;
  kind: 'warning' | 'error' | 'switch' | 'memory' | 'compaction' | 'stopped';
  message: string;
  hint?: string | undefined;
  retryable?: boolean;
  eventId?: number;
  code?: string | undefined;
  errorKind?: string | undefined;
  measured?: number | undefined;
  required?: number | undefined;
}

export type ConversationChange = { kind: 'renamed' | 'archived'; id: string };

interface Props {
  conversationId: string | null;
  profile: Profile | null;
  modelName: string | null;
  drafts: Draft[];
  runStarts: Record<string, number>;
  notices: RunNotice[];
  approvals: Approval[];
  revision: number;
  onCreated: (id: string) => void;
  onClearNotices: (conversationId: string) => void;
  onNewChat: () => void;
  onConversationChanged: (change: ConversationChange) => void;
}

interface Failure extends SendFailure { card: ContextCardData | null }

let runsRequest: Promise<ChatRunRow[]> | null = null;

function fetchRecentRuns(): Promise<ChatRunRow[]> {
  runsRequest ??= api.runs(500).then(result => result.runs).finally(() => { runsRequest = null; });
  return runsRequest;
}

function useRunStart(draft: Draft | undefined, runStarts: Record<string, number>): number | null {
  const [fetched, setFetched] = useState<Record<string, number>>({});
  const runId = draft?.runId;
  const known = runId === undefined ? undefined : runStarts[runId] ?? fetched[runId];
  useEffect(() => {
    if (runId === undefined || known !== undefined) return undefined;
    let live = true;
    void fetchRecentRuns().then(rows => {
      const row = rows.find(r => r.id === runId);
      if (live && row) setFetched(current => ({ ...current, [runId]: row.started_at }));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [runId, known]);
  return known ?? null;
}

function noteIcon(notice: RunNotice): IconName {
  if (notice.kind === 'switch') return 'refresh';
  if (notice.kind === 'stopped') return 'square';
  if (notice.kind === 'compaction') return 'info';
  return notice.code === 'retrying' ? 'clock' : 'alert';
}

export function Chat({ conversationId, profile, modelName, drafts, runStarts, notices, approvals, revision, onCreated, onClearNotices, onNewChat, onConversationChanged }: Props) {
  const t = useT();
  const [messages, setMessages] = useState<Message[]>([]);
  const [title, setTitle] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!conversationId);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [attached, setAttached] = useState<UploadView[]>([]);
  const [uploading, setUploading] = useState(false);
  const [models, setModels] = useState<ModelView[]>([]);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const created = useRef<string | null>(null);
  const frontGate = useRef<ApprovalGate>({ id: null, since: 0 });
  const seen = useRef(new Set<string>());
  const primed = useRef(false);
  const draft = drafts.find(d => d.conversationId === conversationId);
  const startedAt = useRunStart(draft, runStarts);
  const [liveSince] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!conversationId) { setMessages([]); setLoaded(true); return; }
    try {
      const result = await api.messages(conversationId);
      setMessages(result.messages);
      setTitle(result.conversation.title);
      setLoaded(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) { setMessages([]); setLoaded(true); }
    }
  }, [conversationId]);

  useEffect(() => { void load(); }, [load, revision]);
  useEffect(() => { void api.models().then(r => setModels(r.models)).catch(() => undefined); }, []);

  const lastIsUser = messages.at(-1)?.role === 'user';
  const errorNotice = notices.find(n => n.kind === 'error');
  const visible = messages.filter(m => !(m.role === 'assistant' && !m.text.trim() && m.toolCalls?.length));
  const assistantName = profile?.name ?? 'Clive';
  const frontApprovalId = enterApprovalId(approvals);
  useLayoutEffect(() => { frontGate.current = advanceApprovalGate(frontGate.current, frontApprovalId, Date.now()); }, [frontApprovalId]);
  useEffect(() => {
    const restart = () => { frontGate.current = restartApprovalGate(frontGate.current, Date.now()); };
    const onVisibility = () => { if (!document.hidden) restart(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', restart);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', restart);
    };
  }, []);

  useLayoutEffect(() => {
    const el = thread.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, draft?.text.length, draft?.activeTool, notices.length, failure, loaded, approvals.length]);

  async function fail(error: unknown, fallback: string): Promise<void> {
    const base = sendFailureOf(error, fallback, models);
    let card: ContextCardData | null = null;
    if (base.context) {
      let known = models;
      try { known = (await api.models()).models; } catch { known = models; }
      card = contextCardOf(base.body, known);
    }
    stick.current = true;
    setFailure({ ...base, card });
  }

  async function attach(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    setUploading(true); setFailure(null);
    try {
      for (const file of [...files].slice(0, 5 - attached.length)) {
        const upload = await api.upload(file);
        setAttached(list => [...list, upload]);
      }
    } catch (error) {
      await fail(error, t('chat.attach.failed'));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function rename(next: string): Promise<void> {
    if (!conversationId) { toast({ kind: 'info', icon: 'alert', title: t('chat.needsChat') }); return; }
    try {
      await api.renameConversation(conversationId, next);
      setInput('');
      setTitle(next);
      onConversationChanged({ kind: 'renamed', id: conversationId });
      toast({ kind: 'info', icon: 'pencil', title: t('chat.rename.done'), body: next });
    } catch (error) {
      toast({ kind: 'info', icon: 'alert', title: t('chat.rename.failed'), ...(error instanceof ApiError ? { body: error.message } : {}) });
    }
  }

  async function archive(): Promise<void> {
    setConfirmArchive(false);
    if (!conversationId) return;
    try {
      await api.archiveConversation(conversationId);
      toast({ kind: 'info', icon: 'archive', title: t('chat.archive.done'), ...(title ? { body: title } : {}) });
      onConversationChanged({ kind: 'archived', id: conversationId });
    } catch (error) {
      toast({ kind: 'info', icon: 'alert', title: t('chat.archive.failed'), ...(error instanceof ApiError ? { body: error.message } : {}) });
    }
  }

  async function send(preset?: string): Promise<void> {
    const text = (preset ?? input).trim();
    if ((!text && !attached.length) || sending) return;
    if (draft) { toast({ kind: 'info', icon: 'alert', title: t('chat.busyTitle'), body: t('chat.busyBody') }); return; }
    const newTitle = renameTitleOf(text);
    if (newTitle) { await rename(newTitle); return; }
    if (isRenameWithoutTitle(text)) { toast({ kind: 'info', icon: 'alert', title: t('chat.rename.empty') }); return; }
    stick.current = true;
    setSending(true); setFailure(null);
    try {
      const target = sendTarget(conversationId, created.current);
      const id = target.id;
      created.current = target.created;
      onClearNotices(id);
      await api.send(id, text, attached.map(a => a.id));
      if (preset === undefined) setInput('');
      setAttached([]);
      if (!conversationId) onCreated(id);
      else await load();
    } catch (error) {
      await fail(error, t('chat.send.failed'));
    } finally { setSending(false); }
  }

  async function retry(): Promise<void> {
    if (!conversationId) return;
    onClearNotices(conversationId);
    setFailure(null);
    try { await api.retry(conversationId); }
    catch (error) { await fail(error, t('chat.retry.failed')); }
  }

  function runSlash(command: SlashCommand): void {
    if (command.name === 'rename') { setInput('/rename '); return; }
    setInput('');
    switch (command.name) {
      case 'new': onNewChat(); return;
      case 'task': case 'tasks': location.hash = '#/tasks'; return;
      case 'skills': location.hash = '#/skills'; return;
      case 'log': location.hash = '#/runs'; return;
      case 'memory': location.hash = '#/memory'; return;
      case 'stop':
        if (draft) void api.stop(draft.runId); else toast({ kind: 'info', icon: 'square', title: t('chat.stopNothing') });
        return;
      case 'archive':
        if (conversationId) setConfirmArchive(true); else toast({ kind: 'info', icon: 'alert', title: t('chat.needsChat') });
        return;
    }
  }

  function approveOnce(shownId: string): void {
    if (!approvalEnterAllowed(frontGate.current, shownId, Date.now())) return;
    void decideApproval(shownId, 'once').catch(error => {
      toast({ kind: 'info', icon: 'alert', title: t('approval.failed'), ...(error instanceof ApiError ? { body: error.message } : {}) });
    });
  }

  const keys: string[] = [];
  const items: Array<{ key: string; kind: ChatItemKind; node: ReactNode }> = [];
  const push = (key: string, kind: ChatItemKind, node: ReactNode): void => { keys.push(key); items.push({ key, kind, node }); };

  for (const m of visible) {
    if (m.role === 'tool') push(`m-${m.id}`, 'tool', <ToolMessage message={m} />);
    else if (m.role === 'user') push(`m-${m.id}`, 'user', <UserMessage message={m} />);
    else push(`m-${m.id}`, 'assistant', (
      <AssistantMessage profile={profile} text={m.text} time={m.createdAt} />
    ));
  }
  if (draft) {
    if (draft.text) push(`live-${draft.runId}`, 'assistant', <LiveReply profile={profile} text={draft.text} time={startedAt ?? liveSince} />);
    else if (draft.activeTool) push(`run-${draft.runId}-${draft.activeTool}`, 'run', <RunningTool name={draft.activeTool} input={toolInputSummary(draft.activeInput ?? '')} startedAt={startedAt} />);
    else push(`think-${draft.runId}`, 'think', <ThinkingRow profile={profile} startedAt={startedAt} />);
  }
  notices.filter(n => n.kind !== 'error').forEach((n, i) => {
    const key = `n-${n.runId}-${i}`;
    if (n.kind === 'memory') push(key, 'note', <MemoryRow message={n.message} eventId={n.eventId} />);
    else push(key, 'note', <NoteRow icon={noteIcon(n)}>{n.message}</NoteRow>);
  });
  if (errorNotice) {
    push(`err-${errorNotice.runId}`, 'fail', (
      <FailureCard message={errorNotice.message} hint={errorNotice.hint} numbers={runOverflowOf(errorNotice)} onRetry={lastIsUser && !draft ? () => void retry() : undefined} />
    ));
  }
  if (failure) {
    push('send-failure', 'fail', failure.context
      ? <PreSendCard message={failure.message} hint={failure.card?.hint ?? failure.hint} numbers={failure.card?.numbers ?? null} />
      : <SendErrorCard message={failure.message} hint={failure.hint} setup={failure.noModels} />);
  }

  useEffect(() => {
    for (const key of keys) seen.current.add(key);
    if (loaded) primed.current = true;
  });

  const empty = loaded && items.length === 0;
  const joined = joinsToolRun(items.map(item => item.kind));
  let previous: ChatItemKind | null = null;
  return (
    <section className="chat">
      <div
        ref={thread} className="chat-thread"
        onScroll={e => { stick.current = isNearBottom(e.currentTarget); }}
      >
        <div className="chat-col">
          {empty && <EmptyChat profile={profile} onPick={text => void send(text)} />}
          {items.map((item, index) => {
            const indent = item.kind === 'tool' || item.kind === 'run' || item.kind === 'note' || item.kind === 'fail';
            const gap = item.kind === 'user' && previous !== null && previous !== 'user';
            const enter = primed.current && !seen.current.has(item.key);
            previous = item.kind;
            return <div key={item.key} className={`chat-item${indent ? ' indent' : ''}${gap ? ' gap' : ''}${joined[index] ? ' joined' : ''}${enter ? ' enter' : ''}`}>{item.node}</div>;
          })}
        </div>
      </div>
      <div className="chat-dock">
        <div className="chat-dock-inner">
          <ApprovalDock approvals={approvals} />
          <Composer
            textareaRef={textarea} fileInputRef={fileInput} input={input} attached={attached} uploading={uploading} sending={sending} generating={Boolean(draft)}
            approvalId={frontApprovalId} assistantName={assistantName} modelName={modelName}
            onInput={setInput} onAttach={files => void attach(files)} onDetach={id => setAttached(list => list.filter(a => a.id !== id))}
            onSend={() => void send()} onStop={() => { if (draft) void api.stop(draft.runId); }} onApproveOnce={approveOnce} onSlash={runSlash}
          />
        </div>
      </div>
      {confirmArchive && (
        <ChatDialog
          title={t('chat.archive.title')} onClose={() => setConfirmArchive(false)}
          actions={(
            <>
              <button type="button" className="btn btn-ghost chat-plain" onClick={() => setConfirmArchive(false)}>{t('chat.archive.cancel')}</button>
              <button type="button" className="btn btn-primary" onClick={() => void archive()}>{t('chat.archive.confirm')}</button>
            </>
          )}
        >
          <p className="chat-dialog-text">{t('chat.archive.body', title ?? t('conversation.untitled'))}</p>
        </ChatDialog>
      )}
    </section>
  );
}
