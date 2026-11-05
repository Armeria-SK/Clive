import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, type Conversation, type SkillSummary, type Task, type TaskStatus, type WorkerStatus } from './api.ts';
import { useExit, useTheme } from './hooks.ts';
import { Icon } from './icons.tsx';
import type { IconName } from './icon-paths.ts';
import { formatRelative, getLanguage, setLanguagePreference, useT, type PlainKey } from './i18n/index.ts';
import { isComposing, modLabel } from './keys.ts';
import { flattenPalette, filterPalette, moveIndex, type PaletteGroup, type PaletteItem } from './palette.ts';
import { chatHash } from './routes.ts';
import { toggleTheme } from './theme.ts';
import { toast } from './toast.tsx';

interface Props {
  open: boolean;
  narrow: boolean;
  panelOpen: boolean;
  worker: WorkerStatus | null;
  conversations: Conversation[];
  onClose: () => void;
  onNewChat: () => void;
  onNewTask: () => void;
  onActivity: () => void;
  onWorker: (worker: WorkerStatus) => void;
}

const TASK_STATUS_KEY: Record<TaskStatus, PlainKey> = {
  inbox: 'task.status.inbox', ready: 'task.status.ready', running: 'task.status.running', waiting: 'task.status.waiting',
  scheduled: 'task.status.scheduled', done: 'task.status.done', failed: 'task.status.failed', cancelled: 'task.status.cancelled',
};
const TASK_STATUS_ICON: Record<TaskStatus, IconName> = {
  inbox: 'sparkles', ready: 'circle', running: 'loader', waiting: 'help', scheduled: 'repeat', done: 'circleCheck', failed: 'circleX', cancelled: 'circleSlash',
};
const EXIT_MS = 140;

const go = (hash: string) => () => { location.hash = hash; };

export function Palette(props: Props) {
  const { mounted, leaving } = useExit(props.open, EXIT_MS);
  if (!mounted) return null;
  return <PaletteDialog {...props} leaving={leaving} />;
}

function PaletteDialog({ narrow, panelOpen, worker, conversations, leaving, onClose, onNewChat, onNewTask, onActivity, onWorker }: Props & { leaving: boolean }) {
  const t = useT();
  const { effective } = useTheme();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const [before] = useState(() => document.activeElement);

  useEffect(() => {
    void api.tasks().then(r => setTasks([...r.active, ...r.finished])).catch(() => undefined);
    void api.skills().then(r => setSkills(r.skills)).catch(() => undefined);
    return () => { if (before instanceof HTMLElement && before.isConnected) before.focus(); };
  }, [before]);

  const groups = useMemo<PaletteGroup[]>(() => {
    const entry = (id: string, icon: IconName, label: string, action: () => void, extra: { sub?: string; hint?: string } = {}): PaletteItem => ({
      id, icon, label, sub: extra.sub ?? '', hint: extra.hint ?? '', run: () => { onClose(); setTimeout(action, 0); },
    });
    const otherLanguage = getLanguage() === 'ja' ? 'en' : 'ja';
    const toggleWorker = (current: WorkerStatus) => {
      const paused = !current.paused;
      api.setWorker({ paused })
        .then(next => { onWorker(next); toast({ title: t(paused ? 'toast.workerPaused' : 'toast.workerResumed'), icon: paused ? 'pause' : 'play' }); })
        .catch(() => toast({ title: t('toast.actionFailed'), icon: 'alert' }));
    };
    const actions: PaletteItem[] = [
      entry('new-chat', 'plus', t('nav.newChat'), onNewChat),
      entry('new-task', 'tasks', t('palette.newTask'), () => setTimeout(onNewTask, EXIT_MS + 40)),
      entry('activity', 'panel', narrow ? t('panel.open') : panelOpen ? t('panel.hide') : t('panel.show'), onActivity, { hint: narrow ? '' : `${modLabel()}/` }),
      entry('theme', effective === 'dark' ? 'sun' : 'moon', effective === 'dark' ? t('theme.toLight') : t('theme.toDark'), toggleTheme),
      ...(worker ? [entry('worker', worker.paused ? 'play' : 'pause', worker.paused ? t('palette.workerResume') : t('palette.workerPause'), () => toggleWorker(worker))] : []),
      entry('runs', 'activity', t('palette.openRuns'), go('#/runs')),
      entry('skills', 'wrench', t('palette.openSkills'), go('#/skills')),
      entry('memory', 'bookmark', t('palette.openMemory'), go('#/memory')),
      entry('settings', 'sliders', t('palette.openSettings'), go('#/settings')),
      entry('models', 'cpu', t('palette.openModels'), go('#/settings'), { sub: t('nav.settings') }),
      entry('language', 'globe', t('palette.switchLanguage', t(`lang.${otherLanguage}`)), () => setLanguagePreference(otherLanguage)),
    ];
    return [
      { key: 'actions', label: t('palette.group.actions'), items: actions },
      {
        key: 'conversations', label: t('palette.group.conversations'),
        items: conversations.map(c => entry(`c:${c.id}`, 'msg', c.title ?? t('conversation.untitled'), go(chatHash(c.id)), { hint: formatRelative(c.last_message_at) })),
      },
      {
        key: 'tasks', label: t('palette.group.tasks'),
        items: tasks.map(task => entry(`t:${task.id}`, TASK_STATUS_ICON[task.status], task.title, go(`#/tasks/${encodeURIComponent(task.id)}`), { hint: t(TASK_STATUS_KEY[task.status]) })),
      },
      {
        key: 'skills', label: t('palette.group.skills'),
        items: skills.map(skill => entry(`s:${skill.name}`, 'book', skill.name, go('#/skills'), { sub: skill.description })),
      },
    ];
  }, [t, effective, narrow, panelOpen, worker, conversations, tasks, skills, onClose, onNewChat, onNewTask, onActivity, onWorker]);

  const shown = useMemo(() => filterPalette(groups, query), [groups, query]);
  const flat = useMemo(() => flattenPalette(shown), [shown]);
  const active = Math.min(index, Math.max(0, flat.length - 1));

  useEffect(() => {
    list.current?.querySelector(`[data-pal="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(moveIndex(active, 1, flat.length)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(moveIndex(active, -1, flat.length)); }
    else if (e.key === 'Enter' && !isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); flat[active]?.run(); }
    else if (e.key === 'Tab') e.preventDefault();
  };

  let position = 0;
  return (
    <>
      <div className={`palette-backdrop${leaving ? ' leaving' : ''}`} onClick={onClose} />
      <div className="palette-wrap">
        <div className={`palette${leaving ? ' leaving' : ''}`} role="dialog" aria-modal="true" aria-label={t('palette.title')}>
          <div className="palette-search">
            <span className="palette-search-icon"><Icon name="search" size={16} /></span>
            <input
              autoFocus value={query} placeholder={t('palette.placeholder')} aria-label={t('palette.search')} autoComplete="off" spellCheck={false}
              role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" aria-activedescendant={flat.length ? `palette-opt-${active}` : undefined}
              onChange={e => { setQuery(e.target.value); setIndex(0); }} onKeyDown={onKeyDown}
            />
            <span className="palette-esc">esc</span>
          </div>
          <div className="palette-list" id="palette-list" role="listbox" aria-label={t('palette.results')} ref={list}>
            {!flat.length && <div className="palette-empty">{t('palette.empty', query.trim())}</div>}
            {shown.map(group => (
              <div key={group.key} role="group" aria-label={group.label}>
                <div className="palette-group" aria-hidden="true">{group.label}</div>
                {group.items.map(item => {
                  const i = position++;
                  return (
                    <button
                      key={item.id} id={`palette-opt-${i}`} data-pal={i} role="option" aria-selected={i === active} tabIndex={-1}
                      className={`palette-item${i === active ? ' active' : ''}`} onClick={item.run} onMouseMove={() => { if (i !== active) setIndex(i); }}
                    >
                      <span className="palette-item-icon"><Icon name={item.icon} size={15} /></span>
                      <span className="palette-item-text">{item.label}{item.sub && <span className="palette-item-sub">{item.sub}</span>}</span>
                      <span className="palette-item-hint">{item.hint}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="palette-foot"><span>{t('palette.hintMove')}</span><span>{t('palette.hintOpen')}</span><span>{t('palette.hintClose')}</span></div>
        </div>
      </div>
    </>
  );
}
