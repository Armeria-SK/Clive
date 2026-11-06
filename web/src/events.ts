import { useCallback, useEffect, useRef, useState } from 'react';
import type { Approval, NotificationItem, Task } from './api.ts';

export type RunEvent =
  | { type: 'run.start'; runId: string; conversationId: string; modelId: string }
  | { type: 'model.switch'; runId: string; conversationId: string; from: string; to: string; reason: string }
  | { type: 'text.delta'; runId: string; conversationId: string; text: string }
  | { type: 'warning'; runId: string; conversationId: string; code: string; message: string; params?: Record<string, unknown> }
  | { type: 'message.saved'; runId: string; conversationId: string; messageId: number; role: string }
  | { type: 'tool.call'; runId: string; conversationId: string; callId: string; name: string; input: string }
  | { type: 'tool.result'; runId: string; conversationId: string; callId: string; name: string; ok: boolean; decision: string; preview: string }
  | { type: 'approval.requested'; runId: string; conversationId: string; approval: Omit<Approval, 'runId' | 'conversationId'> }
  | { type: 'approval.resolved'; runId: string; conversationId: string; approvalId: string; outcome: string }
  | { type: 'memory.changed'; runId: string; conversationId: string; memoryId: number; book: 'user' | 'notes'; action: 'create' | 'update' | 'forget'; content: string; eventId: number }
  | { type: 'compaction'; runId: string; conversationId: string; summarized: number }
  | { type: 'run.end'; runId: string; conversationId: string; ok: boolean; errorKind?: string; errorMessage?: string; errorCode?: string; errorParams?: Record<string, string | number>; detail?: { reason: string; hint?: string; measured?: number; required?: number } }
  | { type: 'pending.changed'; conversationId: string }
  | { type: 'conversation.changed'; conversationId: string; change: 'renamed' | 'archived' | 'unarchived' | 'deleted' }
  | { type: 'task.changed'; task: Task }
  | { type: 'notification'; notification: NotificationItem };

export interface Draft { runId: string; conversationId: string; modelId: string; text: string; activeTool?: string | undefined; activeInput?: string | undefined }

export function useRunEvents(onEvent: (e: RunEvent) => void, onResync: (drafts: Draft[]) => void): { connected: boolean; reconnect: () => void } {
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const handlers = useRef({ onEvent, onResync });
  handlers.current = { onEvent, onResync };
  useEffect(() => {
    let boot: string | undefined;
    const source = new EventSource('/api/events');
    source.addEventListener('hello', e => {
      const data = JSON.parse((e as MessageEvent).data) as { bootId: string; drafts: Draft[] };
      setConnected(true);
      if (boot !== data.bootId) { boot = data.bootId; handlers.current.onResync(data.drafts); }
    });
    source.addEventListener('resync', () => handlers.current.onResync([]));
    source.addEventListener('run', e => {
      try { handlers.current.onEvent(JSON.parse((e as MessageEvent).data) as RunEvent); } catch { }
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [attempt]);
  const reconnect = useCallback(() => { setConnected(false); setAttempt(n => n + 1); }, []);
  return { connected, reconnect };
}
