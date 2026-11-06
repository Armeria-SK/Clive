import type { Notification } from '../notify/notifications.ts';
import type { MessageParams } from '../shared/messages/define.ts';
import type { TaskView } from '../tasks/store.ts';
import type { approvalPublic } from '../tools/approvals.ts';

export type EngineErrorKind =
  | 'timeout'
  | 'rate_limit'
  | 'auth'
  | 'context_overflow'
  | 'provider_error'
  | 'cancelled'
  | 'internal';

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  raw?: string;
}

export interface AttachmentMeta { id: string; name: string; kind: 'text' | 'pdf' | 'image' }

export interface ImageRef {
  mediaType: string;
  data: string;
}

export type ChatMessage =
  | { role: 'user'; content: string; images?: ImageRef[]; attachments?: AttachmentMeta[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'other';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ContextReason =
  | 'server_ctx_too_small'
  | 'exceeds_model_limit'
  | 'context_unknown'
  | 'prompt_exceeds'
  | 'server_truncation_suspected';

export interface ContextDetail {
  reason: ContextReason;
  measured?: number;
  required?: number;
  hint?: string;
}

export type EngineResult =
  | { ok: true; runId: string; text: string; modelId: string; usage: Usage; stop: StopReason }
  | {
    ok: false;
    runId: string;
    text: '';
    errorKind: EngineErrorKind;
    errorMessage: string;
    errorCode?: string;
    errorParams?: MessageParams;
    retryable: boolean;
    detail?: ContextDetail;
  };

export type RunEvent =
  | { type: 'run.start'; runId: string; conversationId: string; modelId: string }
  | { type: 'model.switch'; runId: string; conversationId: string; from: string; to: string; reason: string }
  | { type: 'text.delta'; runId: string; conversationId: string; text: string }
  | { type: 'warning'; runId: string; conversationId: string; code: string; message: string; params?: Record<string, string | number | MessageParams> }
  | { type: 'message.saved'; runId: string; conversationId: string; messageId: number; role: ChatMessage['role'] }
  | { type: 'tool.call'; runId: string; conversationId: string; callId: string; name: string; input: string }
  | { type: 'tool.result'; runId: string; conversationId: string; callId: string; name: string; ok: boolean; decision: 'allow' | 'ask' | 'deny'; preview: string; autoReason?: string }
  // 自動承認の判定役に聞いている（checking）/ 判定役が許した（allowed。reason は判定役の短い理由）/ 判定役が確かめると言った・答えられなかった（asked。このあと承認の札が出る）
  | { type: 'tool.auto'; runId: string; conversationId: string; callId: string; name: string; state: 'checking' | 'allowed' | 'asked'; reason?: string }
  | { type: 'approval.requested'; runId: string; conversationId: string; approval: ReturnType<typeof approvalPublic> }
  | { type: 'approval.resolved'; runId: string; conversationId: string; approvalId: string; outcome: 'approved' | 'denied' | 'expired' | 'cancelled' }
  | { type: 'memory.changed'; runId: string; conversationId: string; memoryId: number; book: 'user' | 'notes'; action: 'create' | 'update' | 'forget'; content: string; eventId: number }
  | { type: 'compaction'; runId: string; conversationId: string; summarized: number }
  | {
    type: 'run.end'; runId: string; conversationId: string; ok: boolean;
    errorKind?: EngineErrorKind; errorMessage?: string; errorCode?: string; errorParams?: MessageParams; detail?: ContextDetail;
  }
  // 会話の題・アーカイブ・削除が変わった（開いているほかの画面が一覧を読み直すため）
  // 実行中に送った待ちの発言が増えた・取り消された・履歴に入った（画面が待ちの一覧を読み直す）
  | { type: 'pending.changed'; conversationId: string }
  | { type: 'conversation.changed'; conversationId: string; change: 'renamed' | 'archived' | 'unarchived' | 'deleted' }
  | { type: 'task.changed'; task: TaskView }
  | { type: 'notification'; notification: Notification };
