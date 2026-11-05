import { useEffect, useState, useSyncExternalStore } from 'react';
import { Icon, type IconName } from './icons.tsx';
import { useT } from './i18n/index.ts';
import type { LayoutMode } from './layout.ts';

export type ToastKind = 'info' | 'done' | 'approval' | 'memory';

export interface ToastInput {
  kind?: ToastKind;
  icon?: IconName;
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
  durationMs?: number;
}

export interface ToastItem extends ToastInput { id: number; leaving: boolean }

export const MAX_TOASTS = 3;
const DEFAULT_MS = 5200;
const LEAVE_MS = 240;
const HOVER_RETRY_MS = 1500;
const KIND_ICON: Record<ToastKind, IconName> = { info: 'info', done: 'circleCheck', approval: 'shield', memory: 'bookmark' };

let items: ToastItem[] = [];
let nextId = 1;
let hovering = false;
const listeners = new Set<() => void>();

const emit = (next: ToastItem[]): void => {
  items = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function dismissToast(id: number): void {
  const target = items.find(i => i.id === id);
  if (!target || target.leaving) return;
  emit(items.map(i => (i.id === id ? { ...i, leaving: true } : i)));
  setTimeout(() => emit(items.filter(i => i.id !== id)), LEAVE_MS);
}

function scheduleDismiss(id: number, ms: number): void {
  setTimeout(() => {
    if (hovering) scheduleDismiss(id, HOVER_RETRY_MS);
    else dismissToast(id);
  }, ms);
}

export function toast(input: ToastInput): number {
  const id = nextId++;
  const live = items.filter(i => !i.leaving);
  for (const old of live.slice(0, Math.max(0, live.length - (MAX_TOASTS - 1)))) dismissToast(old.id);
  emit([...items, { ...input, id, leaving: false }]);
  scheduleDismiss(id, input.durationMs ?? DEFAULT_MS);
  return id;
}

export function toastStackHeight(count: number, expanded: boolean): number {
  return expanded ? count * 66 : 58 + Math.min(Math.max(count - 1, 0), 2) * 7;
}

export function ToastHost({ mode }: { mode: LayoutMode }) {
  const t = useT();
  const list = useSyncExternalStore(subscribe, () => items);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (!list.length) { hovering = false; setExpanded(false); } }, [list.length]);
  const narrow = mode === 'narrow';
  const live = list.filter(i => !i.leaving);
  const dir = narrow ? 1 : -1;
  return (
    <div
      className={`toast-host${narrow ? ' toast-host-top' : ''}`}
      role="region" aria-live="polite" aria-label={t('toast.region')}
      style={{ height: list.length ? toastStackHeight(live.length, expanded) : 0, pointerEvents: list.length ? 'auto' : 'none' }}
      onMouseEnter={() => { hovering = true; setExpanded(true); }}
      onMouseLeave={() => { hovering = false; setExpanded(false); }}
    >
      {list.map(item => {
        const depth = live.length - 1 - live.findIndex(l => l.id === item.id);
        const i = item.leaving ? 0 : depth;
        const front = i === 0;
        const transform = expanded ? `translateY(${dir * i * 66}px)` : front ? 'none' : `translateY(${dir * i * 7}px) scale(${1 - i * 0.04})`;
        return (
          <div
            key={item.id} data-toast={item.id}
            className={`toast${item.leaving ? ' leaving' : ''}${narrow ? ' toast-from-top' : ''}`}
            style={{
              transform, transformOrigin: narrow ? 'bottom center' : 'top center', opacity: !expanded && i > 2 ? 0 : undefined,
              zIndex: 10 - i, pointerEvents: expanded || front ? 'auto' : 'none', [narrow ? 'top' : 'bottom']: 0,
            }}
          >
            <span className={`toast-icon toast-${item.kind ?? 'info'}`}><Icon name={item.icon ?? KIND_ICON[item.kind ?? 'info']} size={15} /></span>
            <div className="toast-text">
              <span className="toast-title">{item.title}</span>
              {item.body && <span className="toast-body">{item.body}</span>}
            </div>
            <div className="toast-actions">
              {item.action && <button className="toast-action" onClick={() => { item.action!.run(); dismissToast(item.id); }}>{item.action.label}</button>}
              <button className="toast-close" aria-label={t('toast.close')} onClick={() => dismissToast(item.id)}><Icon name="x" size={12} /></button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
