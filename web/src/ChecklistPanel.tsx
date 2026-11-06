import { useId } from 'react';
import type { ChecklistStatus } from './api.ts';
import type { ChecklistCounts, ChecklistView } from './chat-logic.ts';
import { useT, type PlainKey } from './i18n/index.ts';
import { Icon, type IconName } from './icons.tsx';

const STATUS_KEY = { pending: 'checklist.pending', in_progress: 'checklist.inProgress', done: 'checklist.done' } as const satisfies Record<ChecklistStatus, PlainKey>;
const STATUS_ICON = { pending: 'circle', in_progress: 'play', done: 'circleCheck' } as const satisfies Record<ChecklistStatus, IconName>;

interface Props {
  list: ChecklistView;
  counts: ChecklistCounts;
  open: boolean;
  onToggle: () => void;
}

// 入力欄の上の、折りたためる作業の一覧。項目の文は文字のまま出す: Markdown にもリンクにもしない（モデルが書いた文で、外の内容を含むことがある）
export function ChecklistPanel({ list, counts, open, onToggle }: Props) {
  const t = useT();
  const listId = useId();
  const current = list.items.find(item => item.status === 'in_progress');
  return (
    <div className={`chat-checklist${open ? ' open' : ''}`} role="group" aria-label={t('checklist.title')}>
      <button type="button" className="chat-checklist-head" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={onToggle}>
        <span className="chat-checklist-chev"><Icon name="chevR" size={12} /></span>
        <span className="chat-checklist-title">{t('checklist.title')}</span>
        <span className="chat-checklist-count">{t('checklist.count', counts.done, counts.total)}</span>
        {!open && current && <span className="chat-checklist-now">{current.text}</span>}
      </button>
      {open && (
        <ul id={listId} className="chat-checklist-list">
          {list.items.map((item, index) => (
            <li key={index} className={`chat-checklist-item ${item.status}`}>
              <span className="chat-checklist-mark"><Icon name={STATUS_ICON[item.status]} size={14} /></span>
              <span className="sr-only">{t(STATUS_KEY[item.status])}</span>
              <span className="chat-checklist-text">{item.text}</span>
            </li>
          ))}
        </ul>
      )}
      {list.tainted && <p className="chat-checklist-note">{t('checklist.tainted')}</p>}
    </div>
  );
}
