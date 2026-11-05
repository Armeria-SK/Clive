import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Task, type WorkerStatus } from './api.ts';
import { CuriositySection } from './CuriositySection.tsx';
import { useEscapeLayer, useExit, useNow } from './hooks.ts';
import { useT } from './i18n/index.ts';
import { Icon } from './icons.tsx';
import { answerTask, performTaskAction, type TaskAction } from './task-actions.ts';
import { groupTasks, SECTION_ORDER, summarize, type TaskSection } from './task-meta.ts';
import { SectionHead } from './TaskSection.tsx';
import { TaskRow } from './TaskRow.tsx';
import { TaskSheet } from './TaskSheet.tsx';
import { ZoneNote } from './ZoneNote.tsx';
import './styles/tasks.css';

interface Props {
  taskId: string | null;
  section: 'curiosity' | undefined;
  revision: number;
  worker: WorkerStatus | null;
  runStartedAt: number | undefined;
  onNewTask: () => void;
}

type Collapsed = Record<TaskSection | 'curiosity', boolean>;
const SHEET_EXIT_MS = 200;
const SECTION_LABEL = {
  attn: ['tasks.section.attn', 'tasks.section.attn.hint'], act: ['tasks.section.act', null],
  sch: ['tasks.section.sch', 'tasks.section.sch.hint'], done: ['tasks.section.done', 'tasks.section.done.hint'],
} as const;

const closeSheet = () => { location.hash = '#/tasks'; };

// タスクの一覧（4 つの折りたためる節 + 気になること）と、右から出る詳細のシート。#/tasks/<id> はシートを開き、#/curiosity は最後の節を開く。
export function TasksPage({ taskId, section, revision, worker, runStartedAt, onNewTask }: Props) {
  const t = useT();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Collapsed>({ attn: false, act: false, sch: false, done: true, curiosity: true });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);
  const [shownId, setShownId] = useState(taskId);
  const curiosity = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());
  const hasRunning = tasks?.some(task => task.status === 'running' || (task.status === 'ready' && task.run_at !== null)) ?? false;
  const now = useNow(hasRunning ? 1000 : 15_000);
  const reload = useCallback(() => setTick(n => n + 1), []);

  useEffect(() => {
    let live = true;
    api.tasks().then(r => { if (live) { setTasks([...r.active, ...r.finished]); setFailed(false); } }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [revision, tick]);

  useEffect(() => { if (taskId) setShownId(taskId); }, [taskId]);
  const sheet = useExit(Boolean(taskId), SHEET_EXIT_MS);
  useEscapeLayer('sheet', Boolean(taskId), closeSheet);

  const loaded = tasks !== null;
  // 読み込んだあとに現れた行（新しいタスク・状態が変わったタスク）だけ、現れるときに光らせる。最初の読み込みでは光らせない
  const rowKey = (task: Task) => `${task.id}:${task.status}`;
  const isFresh = (task: Task) => fresh.current.has(rowKey(task)) || (seen.current !== null && !seen.current.has(rowKey(task)));
  useEffect(() => {
    if (!tasks) return;
    if (seen.current) for (const task of tasks) if (!seen.current.has(rowKey(task))) fresh.current.add(rowKey(task));
    seen.current = new Set(tasks.map(rowKey));
  }, [tasks]);
  useEffect(() => {
    if (section !== 'curiosity' || !loaded) return;
    setCollapsed(c => ({ ...c, curiosity: false }));
    const timer = setTimeout(() => curiosity.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    return () => clearTimeout(timer);
  }, [section, loaded]);

  const runningTaskId = worker?.running?.kind === 'task' ? worker.running.taskId : null;
  const runId = worker?.running?.runId;
  const groups = groupTasks(tasks ?? [], now, query);
  const summary = summarize(tasks ?? [], now);
  const searching = query.trim() !== '';
  const nothingFound = loaded && searching && SECTION_ORDER.every(key => groups[key].length === 0);
  const toggle = (key: keyof Collapsed) => setCollapsed(c => ({ ...c, [key]: !c[key] }));

  const act = async (action: TaskAction, task: Task) => {
    const here = runningTaskId === task.id;
    const ok = await performTaskAction(action, task, { runId: here ? runId : undefined, busyWithOther: Boolean(worker?.running) && !here });
    if (ok) reload();
  };
  const sendAnswer = async (task: Task) => {
    const text = (answers[task.id] ?? '').trim();
    if (!text) return;
    if (await answerTask(task, text)) { setAnswers(a => ({ ...a, [task.id]: '' })); reload(); }
  };

  const renderRow = (task: Task) => {
    const here = runningTaskId === task.id;
    return (
      <TaskRow
        key={task.id} task={task} now={now} selected={task.id === taskId} runningHere={here} fresh={isFresh(task)}
        elapsedMs={here && runStartedAt !== undefined ? now - runStartedAt : null}
        answer={answers[task.id] ?? ''} onAnswer={text => setAnswers(a => ({ ...a, [task.id]: text }))} onSendAnswer={() => void sendAnswer(task)}
        onOpen={() => { location.hash = `#/tasks/${encodeURIComponent(task.id)}`; }} onAction={action => void act(action, task)}
      />
    );
  };

  return (
    <section className="tk-page">
      <div className="tk-scroll">
        <div className="tk-inner">
          <div className="tk-head">
            <div className="tk-titles">
              <h1 className="tk-title">{t('tasks.title')}</h1>
              <div className="tk-summary">
                <span><b className={summary.attention ? 'attention' : ''}>{summary.attention}</b>{t('tasks.summary.attention')}</span>
                <span><b>{summary.running}</b>{t('tasks.summary.running')}</span>
                <span><b>{summary.ready}</b>{t('tasks.summary.ready')}</span>
                <span><b>{summary.scheduled}</b>{t('tasks.summary.scheduled')}</span>
              </div>
            </div>
            <div className="tk-tools">
              <label className="tk-search">
                <span className="tk-search-icon"><Icon name="search" size={14} /></span>
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('tasks.search')} aria-label={t('tasks.search')} />
              </label>
              <button className="btn btn-primary tk-new" onClick={onNewTask}><Icon name="plus" size={13} />{t('tasks.new')}</button>
            </div>
          </div>
          <p className="tk-zone"><ZoneNote /></p>
          {!loaded ? <p className="tk-note">{failed ? t('tasks.loadFailed') : t('tasks.loading')}</p> : (
            <>
              {nothingFound && <p className="tk-note tk-nomatch">{t('tasks.noMatch', query.trim())}</p>}
              {!searching && tasks.length === 0 && <p className="tk-note">{t('tasks.empty')}</p>}
              {SECTION_ORDER.filter(key => groups[key].length > 0).map(key => {
                const [label, hint] = SECTION_LABEL[key];
                const open = searching || !collapsed[key];
                return (
                  <div key={key} className={`tk-sec${open ? ' open' : ''}`}>
                    <SectionHead open={open} label={t(label)} count={groups[key].length} hint={hint ? t(hint) : ''} attention={key === 'attn'} onToggle={() => toggle(key)} />
                    {open && (
                      <div className="tk-list">
                        <div className="tk-cols" aria-hidden="true"><span /><span>{t('tasks.col.title')}</span><span>{t('tasks.col.origin')}</span><span>{t('tasks.col.priority')}</span><span>{t('tasks.col.when')}</span><span /></div>
                        {groups[key].map(renderRow)}
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={curiosity}>
                <CuriositySection open={!collapsed.curiosity} revision={revision} onToggle={() => toggle('curiosity')} />
              </div>
            </>
          )}
        </div>
      </div>
      {sheet.mounted && (taskId ?? shownId) && (
        <TaskSheet
          id={(taskId ?? shownId)!} leaving={sheet.leaving} revision={revision}
          runId={runningTaskId === (taskId ?? shownId) ? runId : undefined} runStartedAt={runStartedAt}
          busyWithOther={Boolean(worker?.running) && runningTaskId !== (taskId ?? shownId)} onClose={closeSheet}
        />
      )}
    </section>
  );
}
