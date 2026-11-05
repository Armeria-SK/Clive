import { useSyncExternalStore } from 'react';
import { api } from './api.ts';

const undone = new Set<number>();
const listeners = new Set<() => void>();

const emit = (): void => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const isMemoryUndone = (eventId: number): boolean => undone.has(eventId);

export async function undoMemoryEvent(eventId: number): Promise<boolean> {
  if (undone.has(eventId)) return true;
  try {
    await api.undoMemory(eventId);
  } catch {
    return false;
  }
  undone.add(eventId);
  emit();
  return true;
}

export function useMemoryUndone(eventId: number): boolean {
  return useSyncExternalStore(subscribe, () => undone.has(eventId));
}
