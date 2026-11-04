import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Approval, type Message, type NewTask, type Task, type TaskEvent, type WorkerStatus } from './api.ts';
import { ApprovalCard, ToolMessage } from './Chat.tsx';
import { Markdown } from './Markdown.tsx';

export const STATUS_LABEL: Record<Task['status'], string> = {
  inbox: '提案', ready: '実行待ち', running: '実行中', waiting: '返事待ち', scheduled: '繰り返し', done: '完了', failed: '失敗', cancelled: '取り消し',
};
const ORIGIN_LABEL: Record<Task['origin'], string> = { user: 'あなた', self: 'Clive', schedule: '予定', curiosity: '好奇心' };
const EVENT_LABEL: Record<string, string> = {
  created: '作成', note: 'メモ', requeued: '再開待ち', question: '質問', approval: '承認待ち', answer: '答え', run: '実行',
  done: '完了', failed: '失敗', cancelled: '取り消し', approved: '承認', reopened: 'やり直し', skipped: '見送り', edited: '編集', context: '経緯',
};
const DAYS = ['月', '火', '水', '木', '金', '土', '日'];

export const fmtTime = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const errorText = (error: unknown) => (error instanceof ApiError ? error.message : '送れませんでした');

function section(task: Task, now: number): 'active' | 'scheduled' | 'inbox' | 'finished' {
  if (task.status === 'inbox') return 'inbox';
  if (task.status === 'scheduled' || (task.status === 'ready' && task.run_at && task.run_at > now)) return 'scheduled';
  if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') return 'finished';
  return 'active';
}

export function WorkerBar({ worker, onChange }: { worker: WorkerStatus | null; onChange: (w: WorkerStatus) => void }) {
  const [error, setError] = useState('');
  if (!worker) return null;
  const set = (patch: { paused?: boolean; autonomy?: boolean }) => { setError(''); void api.setWorker(patch).then(onChange, e => setError(errorText(e))); };
  return (
    <div className="worker-bar">
      <span className={`dot ${worker.paused || !worker.enabled ? 'off' : 'on'}`} />
      <span>
        {!worker.enabled ? 'ワーカーは止めてあります（worker.enabled）'
          : worker.paused ? '一時停止中'
          : worker.running ? <>実行中: {worker.running.kind === 'task' && worker.running.taskId ? <a href={`#/tasks/${worker.running.taskId}`}>{worker.running.title}</a> : <a href="#/review">{worker.running.title}</a>}</>
          : worker.quiet ? '静かにする時間帯' : '待機中'}
      </span>
      <span className="muted small">この1時間 {worker.runsLastHour}/{worker.maxRunsPerHour} 回{worker.nextWakeAt ? ` ・次に確かめる ${fmtTime(worker.nextWakeAt)}` : ''}</span>
      <label className="toggle"><input type="checkbox" checked={worker.autonomy} onChange={e => set({ autonomy: e.target.checked })} /> 自発行動</label>
      <button className="secondary" onClick={() => set({ paused: !worker.paused })}>{worker.paused ? '再開' : '一時停止'}</button>
      {worker.running && <button className="stop" onClick={() => void api.stop(worker.running!.runId)}>止める</button>}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}

function NewTaskForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState(2);
  const [when, setWhen] = useState<'now' | 'at' | 'repeat'>('now');
  const [at, setAt] = useState('');
  const [freq, setFreq] = useState('daily');
  const [time, setTime] = useState('09:00');
  const [day, setDay] = useState('月');
  const [minute, setMinute] = useState('0');
  const [interval, setIntervalMin] = useState('30');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const task: NewTask = { title: title.trim(), priority, ...(body.trim() ? { body: body.trim() } : {}) };
    if (when === 'at') {
      if (!at) { setError('日時を入れてください'); return; }
      task.when = new Date(at).toISOString();
    }
    if (when === 'repeat') task.repeat = { freq, values: { time, day, minute, interval } };
    setBusy(true); setError('');
    try {
      await api.createTask(task);
      setTitle(''); setBody(''); setWhen('now');
      onCreated();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  return (
    <form className="task-form" onSubmit={e => void submit(e)}>
      <div className="row"><input value={title} onChange={e => setTitle(e.target.value)} placeholder="頼みたいこと（タイトル）" maxLength={200} /></div>
      <textarea value={body} onChange={e => setBody(e.target.value)} placeholder="詳細（任意）" rows={2} />
      <div className="row wrap">
        <label>優先度 <select value={priority} onChange={e => setPriority(Number(e.target.value))}><option value={1}>1（高）</option><option value={2}>2</option><option value={3}>3（低）</option></select></label>
        <label>いつ <select value={when} onChange={e => setWhen(e.target.value as typeof when)}><option value="now">今すぐ</option><option value="at">日時を指定</option><option value="repeat">繰り返し</option></select></label>
        {when === 'at' && <input type="datetime-local" value={at} onChange={e => setAt(e.target.value)} />}
        {when === 'repeat' && (
          <>
            <select value={freq} onChange={e => setFreq(e.target.value)}>
              <option value="daily">毎日</option><option value="weekday">平日</option><option value="weekly">毎週</option><option value="hourly">毎時</option><option value="interval">N分ごと</option>
            </select>
            {freq === 'weekly' && <select value={day} onChange={e => setDay(e.target.value)}>{DAYS.map(d => <option key={d} value={d}>{d}曜</option>)}</select>}
            {(freq === 'daily' || freq === 'weekday' || freq === 'weekly') && <input type="time" value={time} onChange={e => setTime(e.target.value)} />}
            {freq === 'hourly' && <label><input type="number" min={0} max={59} value={minute} onChange={e => setMinute(e.target.value)} /> 分</label>}
            {freq === 'interval' && <label><input type="number" min={1} max={59} value={interval} onChange={e => setIntervalMin(e.target.value)} /> 分ごと</label>}
          </>
        )}
        <button type="submit" disabled={busy || !title.trim()}>追加</button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}

function TaskRow({ task }: { task: Task }) {
  return (
    <li className={`task-row status-${task.status}`}>
      <a href={`#/tasks/${task.id}`}>{task.title}</a>
      <span className={`badge ${task.status === 'waiting' ? 'warn' : task.status === 'failed' ? 'bad' : task.status === 'done' ? 'ok' : ''}`}>{STATUS_LABEL[task.status]}</span>
      <span className="muted small">
        {ORIGIN_LABEL[task.origin]} ・ 優先度 {task.priority}
        {task.cron_text ? ` ・ ${task.cron_text}` : ''}
        {task.run_at ? ` ・ ${task.status === 'scheduled' ? '次回' : '開始'} ${fmtTime(task.run_at)}` : ''}
        {task.attempts ? ` ・ 試行 ${task.attempts}/${task.max_attempts}` : ''}
      </span>
      {task.status === 'waiting' && task.waiting_text && <p className="small waiting-text">{task.waiting_text}</p>}
      {task.next_action && task.status !== 'waiting' && <p className="small muted">次: {task.next_action}</p>}
      {task.result_summary && <p className="small muted">{task.result_summary}</p>}
    </li>
  );
}

function TaskList({ revision, worker, onWorker }: { revision: number; worker: WorkerStatus | null; onWorker: (w: WorkerStatus) => void }) {
  const [data, setData] = useState<{ active: Task[]; finished: Task[] } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { void api.tasks().then(setData).catch(() => undefined); }, [revision, tick]);
  const now = Date.now();
  const all = data ? [...data.active, ...data.finished] : [];
  const groups = { active: [] as Task[], scheduled: [] as Task[], inbox: [] as Task[], finished: [] as Task[] };
  for (const task of all) groups[section(task, now)].push(task);
  groups.active.sort((a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting'));
  const block = (title: string, tasks: Task[], empty: string) => (
    <>
      <h2>{title}<span className="muted small"> {tasks.length}</span></h2>
      {tasks.length ? <ul className="task-list">{tasks.map(t => <TaskRow key={t.id} task={t} />)}</ul> : <p className="muted small">{empty}</p>}
    </>
  );
  return (
    <section className="page">
      <h1>タスク</h1>
      <WorkerBar worker={worker} onChange={onWorker} />
      <NewTaskForm onCreated={() => setTick(n => n + 1)} />
      {!data ? <p className="muted">読み込み中…</p> : (
        <>
          {block('進行中', groups.active, '進行中のタスクはありません')}
          {block('予定', groups.scheduled, '予定はありません')}
          {groups.inbox.length > 0 && block('提案', groups.inbox, '')}
          {block('完了', groups.finished, 'まだありません')}
        </>
      )}
    </section>
  );
}

function TaskDetail({ id, revision }: { id: string; revision: number }) {
  const [data, setData] = useState<{ task: Task; events: TaskEvent[]; approvals: Approval[]; runs: Task[] } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [missing, setMissing] = useState(false);
  const [answer, setAnswer] = useState('');
  const [editing, setEditing] = useState<{ title: string; body: string; nextAction: string } | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const reload = () => setTick(n => n + 1);

  useEffect(() => {
    void api.task(id).then(d => {
      setData(d); setMissing(false);
      if (d.task.conversation_id) void api.messages(d.task.conversation_id).then(m => setMessages(m.messages)).catch(() => setMessages([]));
    }, e => { if (e instanceof ApiError && e.status === 404) setMissing(true); });
  }, [id, revision, tick]);

  if (missing) return <section className="page"><p>タスクが見つかりません。<a href="#/tasks">一覧へ</a></p></section>;
  if (!data) return <section className="page"><p className="muted">読み込み中…</p></section>;
  const { task } = data;
  const finished = task.status === 'done' || task.status === 'failed' || task.status === 'cancelled';
  const act = (action: 'run-now' | 'approve' | 'cancel' | 'done') => { setError(''); void api.taskAction(task.id, action).then(reload, e => setError(errorText(e))); };
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!answer.trim()) return;
    void api.answerTask(task.id, answer.trim()).then(() => { setAnswer(''); reload(); }, err => setError(errorText(err)));
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    void api.editTask(task.id, { title: editing.title, body: editing.body, nextAction: editing.nextAction || null })
      .then(() => { setEditing(null); reload(); }, err => setError(errorText(err)));
  };

  return (
    <section className="page">
      <p><a href="#/tasks">← タスク一覧</a></p>
      <h1>{task.title} <span className="badge">{STATUS_LABEL[task.status]}</span></h1>
      <p className="muted small">
        {ORIGIN_LABEL[task.origin]} ・ 優先度 {task.priority}{task.cron_text ? ` ・ ${task.cron_text}` : ''}
        {task.run_at ? ` ・ ${task.status === 'scheduled' ? '次回' : '開始'} ${fmtTime(task.run_at)}` : ''}
        ・ 試行 {task.attempts}/{task.max_attempts} ・ 更新 {fmtTime(task.updated_at)}
      </p>
      <div className="row wrap">
        {task.status === 'inbox' && <button onClick={() => act('approve')}>承認する</button>}
        {task.status !== 'running' && task.status !== 'waiting' && <button className="secondary" onClick={() => act('run-now')}>今すぐ実行</button>}
        {!finished && <button className="secondary" onClick={() => act('done')}>完了にする</button>}
        {!finished && <button className="stop" onClick={() => act('cancel')}>取り消す</button>}
        {!editing && <button className="secondary" onClick={() => setEditing({ title: task.title, body: task.body, nextAction: task.next_action ?? '' })}>編集</button>}
      </div>
      {error && <p className="error-text">{error}</p>}

      {task.status === 'waiting' && (
        <form className="answer" onSubmit={send}>
          <p className="approval-title">Clive からの質問</p>
          <p className="pre">{task.waiting_text}</p>
          <div className="row"><input value={answer} onChange={e => setAnswer(e.target.value)} placeholder="答えを書く" /><button type="submit" disabled={!answer.trim()}>送る</button></div>
        </form>
      )}
      {data.approvals.map(a => <ApprovalCard key={a.id} approval={a} />)}

      {editing ? (
        <form className="task-form" onSubmit={save}>
          <input value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} maxLength={200} />
          <textarea value={editing.body} onChange={e => setEditing({ ...editing, body: e.target.value })} rows={6} placeholder="詳細" />
          <input value={editing.nextAction} onChange={e => setEditing({ ...editing, nextAction: e.target.value })} placeholder="次の一手" />
          <div className="row"><button type="submit">保存</button><button type="button" className="secondary" onClick={() => setEditing(null)}>やめる</button></div>
        </form>
      ) : (
        <>
          {task.body && <><h2>詳細とメモ</h2><p className="pre">{task.body}</p></>}
          {task.next_action && <p><strong>次の一手:</strong> {task.next_action}</p>}
          {task.done_criteria && <p><strong>完了の条件:</strong> {task.done_criteria}</p>}
          {task.result_summary && <><h2>結果</h2><div className="markdown"><Markdown text={task.result_summary} /></div></>}
        </>
      )}

      {data.runs.length > 0 && (
        <>
          <h2>この予定から作った実行</h2>
          <ul className="task-list">{data.runs.map(t => <TaskRow key={t.id} task={t} />)}</ul>
        </>
      )}

      <h2>経過</h2>
      <ul className="task-events">
        {data.events.map(e => (
          <li key={e.id}><span className="muted small">{fmtTime(e.created_at)} {EVENT_LABEL[e.kind] ?? e.kind}（{e.actor}）</span>{e.content && <span className="pre"> {e.content}</span>}</li>
        ))}
      </ul>

      {messages.length > 0 && (
        <details className="task-transcript">
          <summary>このタスクでの Clive の作業記録（{messages.length} 件）</summary>
          {messages.map(m => m.role === 'tool' ? <ToolMessage key={m.id} message={m} /> : (
            <div key={m.id} className={`message ${m.role}`}>{m.role === 'assistant' ? <Markdown text={m.text} /> : <p className="plain">{m.text}</p>}</div>
          ))}
        </details>
      )}
    </section>
  );
}

export function TasksPage({ taskId, revision, worker, onWorker }: { taskId: string | null; revision: number; worker: WorkerStatus | null; onWorker: (w: WorkerStatus) => void }) {
  return taskId ? <TaskDetail id={taskId} revision={revision} /> : <TaskList revision={revision} worker={worker} onWorker={onWorker} />;
}
