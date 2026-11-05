import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, ApiError, type Approval, type Message, type Task, type TaskEvent } from './api.ts';
import { ApprovalCard, ToolMessage } from './Chat.tsx';
import { useNow } from './hooks.ts';
import { formatDateTime, formatElapsed, formatRelative, useT } from './i18n/index.ts';
import { Icon, type IconName } from './icons.tsx';
import { isComposing } from './keys.ts';
import { Markdown } from './Markdown.tsx';
import { answerTask, performTaskAction, reportTaskError, type TaskAction } from './task-actions.ts';
import { eventKey, isAccent, ORIGIN_KEY, priorityKey, sheetActions, STATUS_ICON, STATUS_KEY, type SheetAction } from './task-meta.ts';
import { toast } from './toast.tsx';
import { ZoneNote } from './ZoneNote.tsx';

interface Props {
  id: string;
  leaving: boolean;
  revision: number;
  runId: string | undefined;
  runStartedAt: number | undefined;
  busyWithOther: boolean;
  onClose: () => void;
}

interface Detail { task: Task; events: TaskEvent[]; approvals: Approval[]; runs: Task[] }
type Field = 'title' | 'body' | 'next';

const ACTION_LABEL = {
  approve: 'tasks.action.approve', runNow: 'tasks.action.runNow', retry: 'tasks.action.retryRun', done: 'tasks.action.done', cancel: 'tasks.action.cancel',
} as const satisfies Record<SheetAction, string>;
const ACTION_ICON: Record<SheetAction, IconName> = { approve: 'check', runNow: 'play', retry: 'refresh', done: 'check', cancel: 'circleSlash' };
const FIELD_LABEL = { body: 'tasks.field.body', next: 'tasks.field.next' } as const;

function Tag({ task }: { task: Task }) {
  const t = useT();
  return (
    <span className={`tag ${isAccent(task.status) ? 'tag-accent' : 'tag-neutral'} tk-status`}>
      <span className={task.status === 'running' ? 'tk-spinning' : undefined}><Icon name={STATUS_ICON[task.status]} size={12} /></span>
      {t(STATUS_KEY[task.status])}
    </span>
  );
}

// 右から出る詳細のシート。一覧に重なり、閉じると #/tasks に戻る。別のタスクに切り替えても枠は残し、中身だけ入れ替える。
export function TaskSheet({ id, leaving, onClose, ...rest }: Props) {
  const t = useT();
  const root = useRef<HTMLElement>(null);
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, []);
  return (
    <>
      <div className={`tk-sheet-bg${leaving ? ' leaving' : ''}`} onClick={onClose} />
      <aside ref={root} tabIndex={-1} className={`tk-sheet${leaving ? ' leaving' : ''}`} role="dialog" aria-label={t('tasks.sheet.label')}>
        <SheetContent key={id} id={id} onClose={onClose} {...rest} />
      </aside>
    </>
  );
}

function SheetContent({ id, revision, runId, runStartedAt, busyWithOther, onClose }: Omit<Props, 'leaving'>) {
  const t = useT();
  const [data, setData] = useState<Detail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [missing, setMissing] = useState(false);
  const [answer, setAnswer] = useState('');
  const [editing, setEditing] = useState<Field | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const transcript = useRef<HTMLDetailsElement>(null);
  const reload = () => setTick(n => n + 1);
  const status = data?.task.status;
  const now = useNow(1000, status === 'running');

  useEffect(() => {
    let live = true;
    void api.task(id).then(d => {
      if (!live) return;
      setData(d); setMissing(false);
      if (d.task.conversation_id) void api.messages(d.task.conversation_id).then(m => { if (live) setMessages(m.messages); }).catch(() => { if (live) setMessages([]); });
      else setMessages([]);
    }, e => { if (live && e instanceof ApiError && e.status === 404) setMissing(true); });
    return () => { live = false; };
  }, [id, revision, tick]);

  const run = async (action: TaskAction) => {
    if (!data) return;
    setBusy(true);
    const ok = await performTaskAction(action, data.task, { runId, busyWithOther });
    setBusy(false);
    if (ok) reload();
  };
  const send = async () => {
    if (!data || !answer.trim()) return;
    setBusy(true);
    const ok = await answerTask(data.task, answer.trim());
    setBusy(false);
    if (ok) { setAnswer(''); reload(); }
  };
  const startEdit = (field: Field) => {
    if (!data) return;
    setEditing(field);
    setDraft(field === 'title' ? data.task.title : field === 'body' ? data.task.body : data.task.next_action ?? '');
  };
  const save = async () => {
    if (!data || !editing) return;
    const patch = editing === 'title' ? { title: draft.trim() } : editing === 'body' ? { body: draft } : { nextAction: draft.trim() || null };
    try {
      await api.editTask(data.task.id, patch);
      toast({ kind: 'done', icon: 'check', title: t('tasks.toast.saved'), body: editing === 'title' ? data.task.title : t(FIELD_LABEL[editing]) });
      setEditing(null);
      reload();
    } catch (error) { reportTaskError(error); }
  };
  const editKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.stopPropagation(); setEditing(null); }
  };
  const openConversation = () => {
    const el = transcript.current;
    if (!el) return;
    el.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const task = data?.task;
  const running = task?.status === 'running';
  const elapsed = running && runStartedAt !== undefined && runId ? formatElapsed(now - runStartedAt) : null;
  const lastEvent = data?.events[0]?.content ?? null;
  const when = !task ? '' : task.status === 'scheduled' ? (task.cron_text ?? '—')
    : task.status === 'ready' ? (task.run_at !== null && task.run_at > Date.now() ? formatDateTime(task.run_at) : t('task.status.ready'))
    : task.status === 'inbox' ? t('tasks.meta.proposed')
    : task.status === 'running' || task.status === 'waiting' ? t(STATUS_KEY[task.status])
    : formatRelative(task.updated_at);

  const fieldRow = (field: 'body' | 'next', value: string | null): ReactNode => (
    <div className="tk-field" key={field}>
      <div className="tk-field-head">
        <span className="tk-field-label">{t(FIELD_LABEL[field])}</span>
        {editing !== field && <button className="tk-edit" onClick={() => startEdit(field)}><Icon name="pencil" size={11} />{t('tasks.field.edit')}</button>}
      </div>
      {editing === field ? (
        <div className="tk-field-edit tk-expand">
          <textarea className="input" autoFocus value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={editKey} />
          <div className="tk-field-buttons">
            <button className="btn btn-ghost" onClick={() => setEditing(null)}>{t('tasks.field.cancel')}</button>
            <button className="btn btn-primary" disabled={field === 'body' && !draft.trim()} onClick={() => void save()}>{t('tasks.field.save')}</button>
          </div>
        </div>
      ) : <span className={`tk-field-value${value ? '' : ' unset'}`}>{value || t('tasks.field.empty')}</span>}
    </div>
  );

  return (
    <>
      <div className="tk-sheet-top">
        {task && <Tag task={task} />}
        {task && <span className="tk-updated">{t('tasks.sheet.updated', formatRelative(task.updated_at))}</span>}
        <button className="btn btn-ghost btn-icon tk-sheet-close" onClick={onClose} aria-label={t('tasks.sheet.close')} data-tip={t('tasks.sheet.close')} data-kbd="Esc"><Icon name="x" size={15} /></button>
      </div>
      <div className="tk-sheet-scroll">
        {missing ? <p className="tk-note tk-sheet-pad">{t('tasks.sheet.missing')}</p>
          : !data || !task ? <p className="tk-note tk-sheet-pad">{t('tasks.sheet.loading')}</p>
          : (
            <div className="tk-sheet-body">
              {editing === 'title' ? (
                <div className="tk-title-edit">
                  <input className="input" autoFocus value={draft} maxLength={200} onChange={e => setDraft(e.target.value)} aria-label={t('tasks.title.edit')}
                    onKeyDown={e => { editKey(e); if (e.key === 'Enter' && !isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode }) && draft.trim()) { e.preventDefault(); void save(); } }} />
                  <button className="btn btn-ghost" onClick={() => setEditing(null)}>{t('tasks.field.cancel')}</button>
                  <button className="btn btn-primary" disabled={!draft.trim()} onClick={() => void save()}>{t('tasks.field.save')}</button>
                </div>
              ) : (
                <div className="tk-title-row">
                  <h2 className="tk-sheet-title">{task.title}</h2>
                  <button className="btn btn-ghost btn-icon tk-title-btn" onClick={() => startEdit('title')} aria-label={t('tasks.title.edit')} data-tip={t('tasks.title.edit')}><Icon name="pencil" size={13} /></button>
                </div>
              )}
              <div className="tk-meta">
                <div><span className="tk-meta-k">{t('tasks.meta.origin')}</span><span className="tk-meta-v">{t(ORIGIN_KEY[task.origin])}</span></div>
                <div><span className="tk-meta-k">{t('tasks.meta.priority')}</span><span className={`tk-meta-v${task.priority === 1 ? ' high' : ''}`}>{t(priorityKey(task.priority))}</span></div>
                <div><span className="tk-meta-k">{t('tasks.meta.when')}</span><span className="tk-meta-v">{when}</span></div>
                <div><span className="tk-meta-k">{t('tasks.meta.attempts')}</span><span className="tk-meta-v">{t('tasks.meta.attemptsValue', task.attempts, task.max_attempts)}</span></div>
              </div>
              <ZoneNote />
              <div className="tk-actions">
                {sheetActions(task.status).map(({ action, primary }) => (
                  <button key={action} className={`btn ${primary ? 'btn-primary' : action === 'cancel' ? 'btn-ghost' : 'btn-secondary'}`} disabled={busy} onClick={() => void run(action)}>
                    <Icon name={ACTION_ICON[action]} size={13} />{t(ACTION_LABEL[action])}
                  </button>
                ))}
              </div>

              {running && (
                <div className="tk-runcard">
                  <div className="tk-runcard-head">
                    <span className="tk-spinning tk-runcard-icon"><Icon name="loader" size={14} /></span>
                    <span className="tk-runcard-label">{t('task.status.running')}</span>
                    {elapsed && <span className="tk-runcard-time">{elapsed}</span>}
                    {runId && <button className="tk-link" onClick={() => void run('stop')} data-tip={t('tasks.stopTip')}>{t('tasks.action.stop')}</button>}
                  </div>
                  {lastEvent && <div className="tk-runcard-last swap" key={data.events[0]!.id}>{lastEvent}</div>}
                  <div className="tk-bar tk-bar-card"><span /></div>
                  {runId && <p className="tk-runcard-hint">{t('tasks.stopHint')}</p>}
                </div>
              )}

              {task.status === 'waiting' && (
                <div className="tk-ask">
                  <div className="tk-ask-card">
                    <span className="tk-ask-title"><Icon name="help" size={14} />{t('tasks.question.title')}</span>
                    <p className="tk-ask-text">{task.waiting_text}</p>
                  </div>
                  <div className="tk-answer tk-answer-sheet">
                    <input className="input" value={answer} placeholder={t('tasks.answer.placeholder')} aria-label={t('tasks.answer.label')} onChange={e => setAnswer(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); void send(); } }} />
                    <button className="btn btn-primary" disabled={busy || !answer.trim()} onClick={() => void send()}>{t('tasks.action.send')}</button>
                  </div>
                </div>
              )}
              {data.approvals.length > 0 && <div className="tk-approvals">{data.approvals.map(a => <ApprovalCard key={a.id} approval={a} />)}</div>}

              <div className="tk-fields">
                {fieldRow('body', task.body)}
                {fieldRow('next', task.next_action)}
                <div className="tk-field">
                  <div className="tk-field-head"><span className="tk-field-label">{t('tasks.field.done')}</span></div>
                  <span className={`tk-field-value${task.done_criteria ? '' : ' unset'}`}>{task.done_criteria || t('tasks.field.empty')}</span>
                </div>
              </div>

              {task.result_summary && (
                <div className="tk-result">
                  <span className="tk-field-label">{t('tasks.result')}</span>
                  <Markdown text={task.result_summary} />
                </div>
              )}

              {data.runs.length > 0 && (
                <div className="tk-runs">
                  <span className="tk-field-label">{t('tasks.runs')}</span>
                  {data.runs.map(child => (
                    <a key={child.id} className="tk-run" href={`#/tasks/${encodeURIComponent(child.id)}`}>
                      <span className={`tk-ico${isAccent(child.status) ? ' accent' : ''}${child.status === 'failed' ? ' failed' : ''}`}><Icon name={STATUS_ICON[child.status]} size={14} /></span>
                      <span className="tk-run-title">{child.title}</span>
                      <span className="tk-run-meta">{t(STATUS_KEY[child.status])} · {formatDateTime(child.created_at)}</span>
                    </a>
                  ))}
                </div>
              )}

              <div className="tk-timeline">
                <div className="tk-field-head">
                  <span className="tk-field-label">{t('tasks.timeline')}</span>
                  {task.conversation_id && <button className="tk-link" onClick={openConversation}>{t('tasks.openConversation')}</button>}
                </div>
                <div className="tk-events">
                  {data.events.map((event, i) => {
                    const key = eventKey(event.kind);
                    return (
                      <div key={event.id} className="tk-event">
                        <span className={`tk-event-dot${i === 0 ? ' latest' : event.kind === 'question' ? ' ask' : ''}`} />
                        <div className="tk-event-head">
                          <span className={`tk-event-label${event.kind === 'question' || event.kind === 'answer' ? ' ask' : ''}`}>{key ? t(key) : event.kind}</span>
                          <span className="tk-event-time">{formatDateTime(event.created_at)}</span>
                        </div>
                        {event.content && <div className="tk-event-text">{event.content}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>

              {messages.length > 0 && (
                <details className="tk-transcript" ref={transcript}>
                  <summary>{t('tasks.transcript', messages.length)}</summary>
                  {messages.map(m => m.role === 'tool' ? <ToolMessage key={m.id} message={m} /> : (
                    <div key={m.id} className={`tk-msg ${m.role}`}>{m.role === 'assistant' ? <Markdown text={m.text} /> : <p>{m.text}</p>}</div>
                  ))}
                </details>
              )}
            </div>
          )}
      </div>
    </>
  );
}
