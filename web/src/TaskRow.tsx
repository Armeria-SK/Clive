import type { KeyboardEvent, MouseEvent } from 'react';
import type { Task } from './api.ts';
import { formatDateTime, formatElapsed, formatRelative, formatRelativeCompact, useT } from './i18n/index.ts';
import { isAccent, isFinished, ORIGIN_KEY, priorityKey, quickOf, rowSub, STATUS_ICON, type QuickKind } from './task-meta.ts';
import type { TaskAction } from './task-actions.ts';
import { Icon, type IconName } from './icons.tsx';

interface Props {
  task: Task;
  now: number;
  selected: boolean;
  fresh: boolean;
  runningHere: boolean;
  elapsedMs: number | null;
  answer: string;
  onAnswer: (text: string) => void;
  onSendAnswer: () => void;
  onOpen: () => void;
  onAction: (action: TaskAction) => void;
}

const QUICK: Record<QuickKind, { label: 'tasks.action.run' | 'tasks.action.runNow' | 'tasks.action.stop' | 'tasks.action.retry'; icon: IconName; className: string }> = {
  run: { label: 'tasks.action.run', icon: 'play', className: 'btn btn-secondary' },
  runNow: { label: 'tasks.action.runNow', icon: 'play', className: 'btn btn-ghost' },
  stop: { label: 'tasks.action.stop', icon: 'square', className: 'btn btn-ghost' },
  retry: { label: 'tasks.action.retry', icon: 'refresh', className: 'btn btn-secondary' },
};

const isEnter = (e: KeyboardEvent): boolean => e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229;

export function TaskRow({ task, now, selected, fresh, runningHere, elapsedMs, answer, onAnswer, onSendAnswer, onOpen, onAction }: Props) {
  const t = useT();
  const running = task.status === 'running';
  const waiting = task.status === 'waiting';
  const quick = quickOf(task, runningHere, now);
  const sub = rowSub(task);
  const subText = sub.kind === 'question' ? t('tasks.sub.question', sub.text)
    : sub.kind === 'next' ? t('tasks.sub.next', sub.text)
    : sub.kind === 'text' ? sub.text
    : sub.kind === 'nextRun' ? t('tasks.when.next', formatDateTime(task.run_at))
    : '';
  const ago = formatRelativeCompact(task.updated_at, now);
  const when = running ? (elapsedMs === null ? t('task.status.running') : t('tasks.when.running', formatElapsed(elapsedMs)))
    : waiting ? t('tasks.when.waiting', ago)
    : task.status === 'inbox' ? t('tasks.when.proposed', ago)
    : task.status === 'scheduled' ? (task.cron_text ?? formatDateTime(task.run_at))
    : task.status === 'ready' ? (task.run_at !== null && task.run_at > now ? t('tasks.when.at', formatDateTime(task.run_at)) : t('tasks.when.ready'))
    : formatRelative(task.updated_at, now);
  const accentFailed = task.status === 'failed';

  const clickRow = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, button, input')) return;
    onOpen();
  };
  const stopClick = (e: MouseEvent, action: TaskAction) => { e.stopPropagation(); onAction(action); };

  return (
    <div className={`tk-item${fresh ? ' fresh' : ''}`} data-task={task.id}>
      <div className={`tk-row${selected ? ' selected' : ''}`} onClick={clickRow}>
        <span className={`tk-ico${isAccent(task.status) ? ' accent' : ''}${accentFailed ? ' failed' : ''}${running ? ' spin' : ''}`}><Icon name={STATUS_ICON[task.status]} size={16} /></span>
        <div className="tk-text">
          <a className={`tk-name${task.status === 'cancelled' ? ' struck' : ''}${isFinished(task.status) && !accentFailed ? ' dim' : ''}`} href={`#/tasks/${encodeURIComponent(task.id)}`}>{task.title}</a>
          <span className={`tk-sub${waiting ? ' wrap' : ''}${accentFailed ? ' failed' : ''}`}>
            <span className="tk-when-inline">{when}{subText ? ' · ' : ''}</span>{subText}
          </span>
        </div>
        <span className="tk-cell tk-origin">{t(ORIGIN_KEY[task.origin])}</span>
        <span className={`tk-cell tk-prio${task.priority === 1 ? ' high' : ''}`}>{t(priorityKey(task.priority))}</span>
        <span className="tk-cell tk-when">{when}</span>
        <div className="tk-quick">
          {quick && (
            <button
              className={QUICK[quick].className} onClick={e => stopClick(e, quick)}
              {...(quick === 'stop' ? { 'data-tip': t('tasks.stopTip') } : {})}
            >
              <Icon name={QUICK[quick].icon} size={12} />{t(QUICK[quick].label)}
            </button>
          )}
        </div>
      </div>
      {running && <div className="tk-bar"><span /></div>}
      {waiting && (
        <div className="tk-answer">
          <input
            className="input" value={answer} placeholder={t('tasks.answer.placeholder')} aria-label={t('tasks.answer.label')}
            onChange={e => onAnswer(e.target.value)} onKeyDown={e => { if (isEnter(e)) { e.preventDefault(); onSendAnswer(); } }}
          />
          <button className="btn btn-primary" disabled={!answer.trim()} onClick={onSendAnswer}>{t('tasks.action.send')}</button>
        </div>
      )}
      {task.status === 'inbox' && (
        <div className="tk-propose">
          <button className="btn btn-primary" onClick={() => onAction('approve')}><Icon name="check" size={12} />{t('tasks.action.approve')}</button>
          <button className="btn btn-ghost" onClick={() => onAction('skip')}>{t('tasks.action.skip')}</button>
        </div>
      )}
    </div>
  );
}
