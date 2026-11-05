import { chatHash } from './routes.ts';

export type ConvMark = 'approval' | 'generating' | null;

// サーバーの会話の一覧は 100 件まで（src/db/conversations.ts の list の既定）。件数はそれ以上を「100+」と出す。
export const CONVERSATION_LIST_LIMIT = 100;

export const conversationCountLabel = (count: number): string => (count >= CONVERSATION_LIST_LIMIT ? `${CONVERSATION_LIST_LIMIT}+` : String(count));

// 会話の横の印。承認の待ちは、返事を作っている最中（run.end まで下書きが残る）に起きるので、承認を優先する。
export function convMark(
  drafts: ReadonlyArray<{ conversationId: string }>,
  approvals: ReadonlyArray<{ conversationId: string }>,
  conversationId: string,
): ConvMark {
  if (approvals.some(a => a.conversationId === conversationId)) return 'approval';
  if (drafts.some(d => d.conversationId === conversationId)) return 'generating';
  return null;
}

// 姿と一言のための「返事を作っている最中」。承認待ちの会話は、止まって待っているので含めない（承認が優先）。
// タスクと振り返りの実行（worker.running）も含めない。
export function isChatGenerating(
  drafts: ReadonlyArray<{ runId: string; conversationId: string }>,
  approvals: ReadonlyArray<{ conversationId: string }>,
  workerRunId: string | undefined,
): boolean {
  return drafts.some(d => d.runId !== workerRunId && convMark(drafts, approvals, d.conversationId) === 'generating');
}

export interface RunContext {
  // 会話の ID から、その会話を使っているタスクの ID（タスクの実行の会話は、会話の一覧には出ない）
  taskConversations: ReadonlyMap<string, string>;
  running: { runId: string; kind: 'task' | 'review'; taskId: string | null } | null;
}

// 承認の行き先。会話の一覧に載っているかどうか（100 件まで）ではなく、タスクの実行かどうかで決める。
export function approvalTargetHash(approval: { conversationId: string; runId: string }, context: RunContext): string {
  const taskId = context.taskConversations.get(approval.conversationId)
    ?? (context.running?.runId === approval.runId && context.running.kind === 'task' ? context.running.taskId : null);
  return taskId ? `#/tasks/${encodeURIComponent(taskId)}` : chatHash(approval.conversationId);
}

export type RunGuess = 'chat' | 'background' | 'unknown';

// ユーザーが会話で頼んだ実行か（タスクと振り返りの実行ではないか）。
// 実行中のタスク・振り返り（worker.running）やタスクの会話は「background」、会話の一覧（chat だけが載る）に載っていれば「chat」。
// どちらとも分からない（一覧の外の古い会話か、実行が短くて worker の状態がまだ届いていない振り返り）は「unknown」で、
// 呼び出し側が会話の種類をサーバーに尋ねて決める。
export function classifyRun(runId: string, conversationId: string, context: RunContext, listedChatIds: ReadonlySet<string>): RunGuess {
  if (context.taskConversations.has(conversationId) || context.running?.runId === runId) return 'background';
  return listedChatIds.has(conversationId) ? 'chat' : 'unknown';
}
