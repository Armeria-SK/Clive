import { useSyncExternalStore } from 'react';
import { api } from './api.ts';
import { createDecisionTracker } from './chat-logic.ts';

export type ApprovalDecision = 'once' | 'conversation' | 'deny';

const tracker = createDecisionTracker();
const listeners = new Set<() => void>();

const emit = (): void => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export async function decideApproval(id: string, decision: ApprovalDecision): Promise<boolean> {
  if (!tracker.start(id)) return false;
  emit();
  try {
    await api.decide(id, decision);
    return true;
  } catch (error) {
    tracker.release(id);
    emit();
    throw error;
  }
}

export function useDecisionPending(id: string): boolean {
  return useSyncExternalStore(subscribe, () => tracker.has(id));
}
