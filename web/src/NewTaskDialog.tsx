import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api } from './api.ts';
import { useEscapeLayer, useExit } from './hooks.ts';
import { formatDateTime, useT } from './i18n/index.ts';
import { Icon } from './icons.tsx';
import { isComposing } from './keys.ts';
import { usePending } from './pending.ts';
import { buildNewTask, draftError, draftSummary, emptyDraft, FREQS, PRIORITIES, type DraftError, type DraftSummary, type TaskDraft, type When } from './task-form.ts';
import { reportTaskError } from './task-actions.ts';
import { toast } from './toast.tsx';
import { WEEKDAYS } from './weekdays.ts';
import { ZoneNote } from './ZoneNote.tsx';

interface Props {
  open: boolean;
  narrow: boolean;
  onClose: () => void;
}

const EXIT_MS = 180;
const WHENS: readonly When[] = ['now', 'at', 'repeat'];
const WHEN_KEY = { now: 'newtask.when.now', at: 'newtask.when.at', repeat: 'newtask.when.repeat' } as const;
const FREQ_KEY = {
  daily: 'newtask.freq.daily', weekday: 'newtask.freq.weekday', weekly: 'newtask.freq.weekly', hourly: 'newtask.freq.hourly', interval: 'newtask.freq.interval',
} as const;
const PRIORITY_KEY = { 1: 'newtask.priority.1', 2: 'newtask.priority.2', 3: 'newtask.priority.3' } as const;
const DAY_SHORT = [
  'newtask.dayShort.mon', 'newtask.dayShort.tue', 'newtask.dayShort.wed', 'newtask.dayShort.thu', 'newtask.dayShort.fri', 'newtask.dayShort.sat', 'newtask.dayShort.sun',
] as const;
const ERROR_KEY = {
  title: 'newtask.error.title', at: 'newtask.error.at', time: 'newtask.error.time', minute: 'newtask.error.minute', interval: 'newtask.error.interval',
} as const satisfies Record<DraftError, string>;

export function NewTaskDialog(props: Props) {
  const { mounted, leaving } = useExit(props.open, EXIT_MS);
  useEscapeLayer('dialog', props.open, props.onClose);
  if (!mounted) return null;
  return <NewTaskForm {...props} leaving={leaving} />;
}

function Seg<V extends string | number>({ name, value, options, onPick, small }: {
  name: string; value: V; options: ReadonlyArray<{ value: V; label: ReactNode; title?: string }>; onPick: (value: V) => void; small?: boolean;
}) {
  return (
    <div className={`seg${small ? ' tk-seg-small' : ''}`} role="radiogroup">
      {options.map(option => (
        <label key={String(option.value)} className="seg-opt" title={option.title}>
          <input type="radio" name={name} checked={option.value === value} onChange={() => onPick(option.value)} />{option.label}
        </label>
      ))}
    </div>
  );
}

function NewTaskForm({ narrow, leaving, onClose }: Props & { leaving: boolean }) {
  const t = useT();
  const [draft, setDraft] = useState<TaskDraft>(emptyDraft);
  const { pending, run: once } = usePending();
  const busy = pending.has('create');
  const [shownError, setShownError] = useState<DraftError | null>(null);
  const [before] = useState(() => document.activeElement);
  useEffect(() => () => { if (before instanceof HTMLElement && before.isConnected) before.focus(); }, [before]);

  const set = (patch: Partial<TaskDraft>) => { setDraft(d => ({ ...d, ...patch })); setShownError(null); };
  const missing = draftError(draft);
  const summary = draftSummary(draft);
  const summaryLine = summary ? summaryText(summary, t) : '';

  // 作る操作は 1 回だけ。Enter を続けて押したり、押しながらクリックしたりしても、2 つ作らない
  const create = () => once('create', async () => {
    const built = buildNewTask(draft);
    if (!built.ok) { setShownError(built.error); return; }
    try {
      const { task } = await api.createTask(built.task);
      toast({ kind: 'done', icon: 'plus', title: t('tasks.toast.created'), body: task.cron_text ? t('tasks.toast.createdWithCron', task.title, task.cron_text) : task.title });
      onClose();
      location.hash = `#/tasks/${encodeURIComponent(task.id)}`;
    } catch (error) {
      reportTaskError(error);
    }
  });

  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); void create(); }
  };

  return (
    <>
      <div className={`tk-modal-bg${leaving ? ' leaving' : ''}`} onClick={onClose} />
      <div className={`tk-modal-wrap${narrow ? ' narrow' : ''}`}>
        <div className={`dialog tk-dialog${leaving ? ' leaving' : ''}`} role="dialog" aria-modal="true" aria-label={t('tasks.new')}>
          <div className="tk-dialog-head">
            <span className="dialog-title">{t('tasks.new')}</span>
            <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label={t('newtask.close')}><Icon name="x" size={16} /></button>
          </div>
          <div className="field">
            <label htmlFor="nt-title">{t('newtask.titleLabel')}</label>
            <input id="nt-title" className="input" autoFocus value={draft.title} maxLength={200} placeholder={t('newtask.titlePlaceholder')} onChange={e => set({ title: e.target.value })} onKeyDown={onTitleKey} />
          </div>
          <div className="field">
            <label htmlFor="nt-body">{t('newtask.bodyLabel')}</label>
            <textarea id="nt-body" className="input tk-body" value={draft.body} placeholder={t('newtask.bodyPlaceholder')} onChange={e => set({ body: e.target.value })} />
          </div>
          <div className="tk-dialog-row">
            <div className="field">
              <label>{t('newtask.priority')}</label>
              <Seg name="nt-priority" value={draft.priority} options={PRIORITIES.map(p => ({ value: p, label: t(PRIORITY_KEY[p]) }))} onPick={priority => set({ priority })} />
            </div>
            <div className="field">
              <label>{t('newtask.when')}</label>
              <Seg name="nt-when" value={draft.when} options={WHENS.map(w => ({ value: w, label: t(WHEN_KEY[w]) }))} onPick={when => set({ when })} />
            </div>
          </div>
          {draft.when === 'at' && (
            <div className="field tk-expand">
              <label htmlFor="nt-at">{t('newtask.at')}</label>
              <input id="nt-at" className="input tk-at" type="datetime-local" value={draft.at} onChange={e => set({ at: e.target.value })} />
              <ZoneNote input />
            </div>
          )}
          {draft.when === 'repeat' && (
            <div className="tk-repeat tk-expand">
              <Seg name="nt-freq" value={draft.freq} options={FREQS.map(f => ({ value: f, label: t(FREQ_KEY[f]) }))} onPick={freq => set({ freq })} />
              <div className="tk-repeat-row">
                {draft.freq === 'weekly' && (
                  <div className="field">
                    <label>{t('newtask.day')}</label>
                    <Seg name="nt-day" value={draft.day} small options={WEEKDAYS.map((d, i) => ({ value: d.value as string, label: t(DAY_SHORT[i]!), title: t(d.label) }))} onPick={day => set({ day })} />
                  </div>
                )}
                {(draft.freq === 'daily' || draft.freq === 'weekday' || draft.freq === 'weekly') && (
                  <div className="field">
                    <label htmlFor="nt-time">{t('newtask.time')}</label>
                    <input id="nt-time" className="input tk-narrow-input" type="time" value={draft.time} onChange={e => set({ time: e.target.value })} />
                  </div>
                )}
                {draft.freq === 'hourly' && (
                  <div className="field">
                    <label htmlFor="nt-minute">{t('newtask.minute')}</label>
                    <input id="nt-minute" className="input tk-num" type="number" min={0} max={59} value={draft.minute} onChange={e => set({ minute: e.target.value })} />
                  </div>
                )}
                {draft.freq === 'interval' && (
                  <div className="field">
                    <label htmlFor="nt-interval">{t('newtask.interval')}</label>
                    <input id="nt-interval" className="input tk-num" type="number" min={1} max={59} value={draft.interval} onChange={e => set({ interval: e.target.value })} />
                  </div>
                )}
              </div>
              {summaryLine && <span className="tk-summary-line swap" key={summaryLine}>{summaryLine}</span>}
              <ZoneNote />
            </div>
          )}
          {draft.when === 'at' && summaryLine && <span className="tk-summary-line swap" key={summaryLine}>{summaryLine}</span>}
          {shownError && <p className="tk-error" role="alert">{t(ERROR_KEY[shownError])}</p>}
          <div className="dialog-actions">
            <button className="btn btn-ghost" onClick={onClose}>{t('newtask.cancel')}</button>
            <button className="btn btn-primary" onClick={() => void create()} disabled={busy || missing === 'title'}>
              {t('newtask.create')}<span className="tk-enter">↵</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function summaryText(summary: DraftSummary, t: ReturnType<typeof useT>): string {
  switch (summary.kind) {
    case 'daily': return t('newtask.sum.daily', summary.time);
    case 'weekday': return t('newtask.sum.weekday', summary.time);
    case 'weekly': {
      const day = WEEKDAYS.find(d => d.value === summary.day);
      return t('newtask.sum.weekly', day ? t(day.label) : summary.day, summary.time);
    }
    case 'hourly': return t('newtask.sum.hourly', summary.minute);
    case 'interval': return t('newtask.sum.interval', summary.every);
    case 'at': return t('newtask.sum.at', formatDateTime(summary.ms, 'full'));
  }
}
