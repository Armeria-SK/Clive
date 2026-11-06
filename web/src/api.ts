import { getLanguage } from './i18n/state.ts';
import { errorBodyText } from './server-text.ts';

// 会話の要約（読むだけ）。要約が無ければ summary は null
export interface ConversationSummary { summary: string | null; upto: number | null; summarizedMessages: number }
export interface Conversation {
  id: string; title: string | null; created_at: number; last_message_at: number;
  // 要約があるか（全文は api.summary で読む）
  has_summary?: boolean;
  // アーカイブしているか（1 / 0）。会話を開いたときの応答にだけ付く
  archived?: number;
  // 会話で選んだモデルと考える深さ（null は自動・モデルの既定）
  model_id?: string | null; effort?: string | null;
}
export interface Message {
  id: number; role: 'user' | 'assistant' | 'tool'; text: string; runId: string | null; createdAt: number;
  toolCalls?: Array<{ id: string; name: string; input: string }>;
  toolName?: string; toolCallId?: string; isError?: boolean;
  attachments?: Array<{ id: string; name: string; kind: 'text' | 'pdf' | 'image' }>;
}
// 会話で選ぶモデルと考える深さ。渡さなかった方は変えない。null は自動・モデルの既定に戻す
export interface ModelChoice { modelId?: string | null; effort?: string | null }
export interface UploadView { id: string; name: string; mime: string; kind: 'text' | 'pdf' | 'image'; size: number; chars: number | null; pages: number | null }
export interface ApprovalPreview { path: string; text: string; truncated: boolean }
// 見つけたパスごとの判定。in は許可フォルダの中（mode はそのフォルダの読み書き / 読むだけ）、out は外、deny は拒否、unknown は判定できない（path が無い）
export interface ApprovalPathView { input: string; path?: string; verdict: 'in' | 'out' | 'deny' | 'unknown'; mode?: 'read' | 'write' }
export interface Approval {
  id: string; runId: string; conversationId: string; tool: string; title: string; body: string; cwd?: string;
  reasons: string[]; details: string[]; paths: ApprovalPathView[]; pathsMore?: number; expiresAt: number;
  // コードを動かす確かめ: 毎回確かめる（「この会話では許可」と Enter での許可は無い）。preview は動かすファイルの中身
  onceOnly: boolean; preview: ApprovalPreview[];
}
// 会話を次に送るときのコンテキストの使用量。tokens は古い発言を削る前の見積もり、available は削り始める境目、capacity はモデル全体、ratio は tokens / available（1 を超えうる）
export interface ContextUsage { modelId: string; tokens: number; available: number; capacity: number; ratio: number }
export interface ContextDetail { reason: string; measured?: number; required?: number; hint?: string }

export interface Probe {
  modelId: string; status: string; server: string; declared?: number; measured?: number; modelMax?: number; effective?: number;
  required: number; message: string; messageCode?: string; messageParams?: Record<string, string | number>; hint?: string; capabilities?: string[]; checkedAt: number;
}
export interface ModelView {
  id: string; label: string; provider: string; model: string; providerKind?: string;
  contextLength?: number; minContext: number; maxOutputTokens: number; inChat: boolean; probe: Probe | null;
  // そのモデルで選べる考える深さ（無ければ選ばせない）
  efforts?: string[];
}
export interface SettingsView {
  config: Record<string, any>;
  apiKeys: Record<string, boolean>;
  configError: { message: string; problems: string[]; issues?: Array<{ path: string; message: string }> } | null;
  restartRequired: boolean;
  configPath: string;
}
export interface RunRow {
  id: string; kind: string; conversation_id: string | null; model_id: string | null; attempts: number;
  started_at: number; duration_ms: number | null; ok: number | null; error_kind: string | null; error_message: string | null;
  input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; est_prompt_tokens: number | null; flags: string[];
}

export interface ToolCallRow {
  id: string; run_id: string; conversation_id: string | null; tool: string; input: string;
  decision: 'allow' | 'ask' | 'deny'; decided_by: string; approval_id: string | null; ok: number | null;
  duration_ms: number | null; output_preview: string | null; full_ref: string | null; created_at: number;
}

export type Book = 'user' | 'notes';
export interface MemoryItem { id: number; book: Book; content: string; origin: string; source_conversation_id: string | null; source_message_id: number | null; created_at: number; updated_at: number }
export interface MemoryEvent { id: number; memory_id: number; action: string; before: string | null; after: string | null; actor: string; reason: string | null; undone_at: number | null; created_at: number }
export interface BookView { used: number; items: MemoryItem[] }
export interface MemoryContext { tokens: number; budget: number | null; omitted: number }
export interface HistoryHit { conversationId: string; title: string | null; messageId: number; role: string; createdAt: number; snippet: string }

export type TaskStatus = 'inbox' | 'ready' | 'running' | 'waiting' | 'scheduled' | 'done' | 'failed' | 'cancelled';
export interface Task {
  id: string; title: string; body: string; next_action: string | null; done_criteria: string | null;
  status: TaskStatus; origin: 'user' | 'self' | 'curiosity' | 'schedule'; priority: number;
  cron: string | null; cron_text: string | null; run_at: number | null; parent_id: string | null; waiting_text: string | null;
  conversation_id: string | null; result_summary: string | null; attempts: number; max_attempts: number;
  created_at: number; updated_at: number; completed_at: number | null;
}
export interface TaskEvent { id: number; kind: string; actor: string; content: string | null; run_id: string | null; created_at: number }
export interface WorkerStatus {
  enabled: boolean; autonomy: boolean; paused: boolean; quiet: boolean;
  running: { kind: 'task' | 'review'; taskId: string | null; runId: string; title: string } | null; nextWakeAt: number | null; runsLastHour: number; maxRunsPerHour: number;
}
export interface NotificationItem { id: number; kind: string; title: string; body: string | null; link: string | null; read_at: number | null; created_at: number }
export type Motion = 'auto' | 'none' | 'float' | 'sway' | 'pulse';
export interface Profile { name: string; shape: string; color: string; motion: Motion; shapes: string[]; motions: Motion[] }
export interface NewTask {
  title: string; body?: string; priority?: number; when?: string;
  repeat?: { freq: string; values: Record<string, string> };
}

export interface SkillSummary { name: string; description: string; uses: number; lastUsedAt: number | null; updatedAt: number }
export interface SkillDraft {
  id: number; name: string; description: string; body: string; reason: string | null; status: string; created_at: number;
  current: { description: string; body: string } | null;
}
export interface CuriosityItem {
  id: number; topic: string; why: string | null; status: 'open' | 'researching' | 'done' | 'dropped'; result: string | null;
  task_id: string | null; source: 'clive' | 'user' | 'file'; created_at: number; updated_at: number;
}
export interface ReviewJob {
  id: number; trigger: string; triggerLabel: string; status: 'pending' | 'running' | 'done' | 'failed'; note: string | null;
  conversation_id: string | null; task_id: string | null; run_id: string | null; created_at: number; finished_at: number | null;
  changes: MemoryEvent[];
}

export interface TemplatesView { language: string; rules: string; files: Array<{ name: string; content: string }> }
export interface OnboardingView { done: boolean; steps: { language: boolean; user: boolean; identity: boolean; persona: boolean; model: boolean } }
export interface PersonaWrite { userName?: string; callMe?: string; botName?: string; style?: 'calm' | 'friendly' | 'direct' | 'none'; styleNote?: string }
export interface PersonaView { soul: string; user: string; tokens: { soul: number; user: number }; budget: number | null; max: number }
export interface EnvReloadView { loaded: boolean; apiKeys: Record<string, boolean>; notApplied: string[] }

export class ApiError extends Error {
  readonly status: number;
  readonly body: any;
  constructor(status: number, body: any) {
    // コード（code / errorCode）が辞書にあれば画面の言語で、無ければサーバーの文のまま
    super(errorBodyText(body, getLanguage()) ?? (typeof body?.errorMessage === 'string' ? body.errorMessage : typeof body?.message === 'string' ? body.message : `HTTP ${status}`));
    this.status = status;
    this.body = body;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const api = {
  conversations: () => call<{ conversations: Conversation[] }>('/api/conversations'),
  archivedConversations: (query = '') => call<{ conversations: Conversation[] }>(`/api/conversations?archived=1${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ''}`),
  renameConversation: (id: string, title: string) => call(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  archiveConversation: (id: string) => call(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) }),
  unarchiveConversation: (id: string) => call(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: false }) }),
  messages: (id: string) => call<{ conversation: Conversation; messages: Message[]; activeRun: { runId: string; draft: string } | null; approvals: Approval[] }>(`/api/conversations/${id}/messages`),
  summary: (id: string) => call<ConversationSummary>(`/api/conversations/${encodeURIComponent(id)}/summary`),
  contextUsage: (id: string, modelId?: string) => call<ContextUsage>(`/api/conversations/${encodeURIComponent(id)}/context${modelId ? `?modelId=${encodeURIComponent(modelId)}` : ''}`),
  approvals: () => call<{ approvals: Approval[] }>('/api/approvals'),
  decide: (id: string, decision: 'once' | 'conversation' | 'deny') => call(`/api/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision }) }),
  send: (id: string, text: string, attachments: string[] = [], choice: ModelChoice = {}) => call<{ runId: string }>(`/api/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, ...(attachments.length ? { attachments } : {}), ...choice }) }),
  chooseModel: (id: string, choice: ModelChoice) => call<{ conversation: Conversation; effortReset?: boolean }>(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(choice) }),
  upload: async (file: File) => {
    const res = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body);
    return (body as { upload: UploadView }).upload;
  },
  retry: (id: string) => call<{ runId: string }>(`/api/conversations/${id}/retry`, { method: 'POST', body: '{}' }),
  stop: (runId: string) => call(`/api/runs/${runId}/stop`, { method: 'POST', body: '{}' }),
  runs: (limit = 200) => call<{ runs: RunRow[] }>(`/api/runs?limit=${limit}`),
  toolCalls: () => call<{ toolCalls: ToolCallRow[] }>('/api/tool-calls?limit=200'),
  settings: () => call<SettingsView>('/api/settings'),
  saveSettings: (config: unknown) => call<SettingsView & { models: ModelView[] }>('/api/settings', { method: 'PUT', body: JSON.stringify({ config }) }),
  models: () => call<{ models: ModelView[]; routing: { chat: string[]; background: string[] } }>('/api/models'),
  probe: () => call<{ models: ModelView[] }>('/api/models/probe', { method: 'POST', body: '{}' }),
  memories: () => call<{ books: Record<Book, BookView>; context: MemoryContext }>('/api/memories'),
  addMemory: (book: Book, content: string) => call('/api/memories', { method: 'POST', body: JSON.stringify({ book, content }) }),
  editMemory: (id: number, content: string) => call(`/api/memories/${id}`, { method: 'PATCH', body: JSON.stringify({ content }) }),
  forgetMemory: (id: number) => call<{ memory: MemoryItem; eventId: number }>(`/api/memories/${id}`, { method: 'DELETE' }),
  memoryEvents: (id: number) => call<{ events: MemoryEvent[] }>(`/api/memories/${id}/events`),
  undoMemory: (eventId: number) => call(`/api/memory-events/${eventId}/undo`, { method: 'POST', body: '{}' }),
  tasks: () => call<{ active: Task[]; finished: Task[] }>('/api/tasks'),
  task: (id: string) => call<{ task: Task; events: TaskEvent[]; approvals: Approval[]; runs: Task[] }>(`/api/tasks/${id}`),
  createTask: (task: NewTask) => call<{ task: Task }>('/api/tasks', { method: 'POST', body: JSON.stringify(task) }),
  editTask: (id: string, patch: { title?: string; body?: string; nextAction?: string | null; doneCriteria?: string | null; priority?: number; when?: string | null }) =>
    call<{ task: Task }>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  answerTask: (id: string, text: string) => call<{ task: Task }>(`/api/tasks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text }) }),
  taskAction: (id: string, action: 'run-now' | 'approve' | 'cancel' | 'uncancel' | 'done') => call<{ task: Task }>(`/api/tasks/${id}/${action}`, { method: 'POST', body: '{}' }),
  worker: () => call<WorkerStatus>('/api/worker'),
  setWorker: (patch: { paused?: boolean; autonomy?: boolean }) => call<WorkerStatus>('/api/worker', { method: 'POST', body: JSON.stringify(patch) }),
  notifications: () => call<{ notifications: NotificationItem[]; unread: number }>('/api/notifications'),
  readNotifications: (ids?: number[]) => call<{ unread: number }>('/api/notifications/read', { method: 'POST', body: JSON.stringify(ids ? { ids } : {}) }),
  profile: () => call<Profile>('/api/profile'),
  saveProfile: (patch: Partial<Pick<Profile, 'name' | 'shape' | 'color' | 'motion'>>) => call<Profile>('/api/profile', { method: 'PATCH', body: JSON.stringify(patch) }),
  review: () => call<{ skillDrafts: SkillDraft[]; taskProposals: Task[] }>('/api/review'),
  approveDraft: (id: number) => call(`/api/skill-drafts/${id}/approve`, { method: 'POST', body: '{}' }),
  rejectDraft: (id: number) => call(`/api/skill-drafts/${id}/reject`, { method: 'POST', body: '{}' }),
  reviews: () => call<{ jobs: ReviewJob[]; pending: number }>('/api/reviews'),
  reviewConversation: (conversationId: string) => call<{ queued: boolean }>('/api/reviews', { method: 'POST', body: JSON.stringify({ conversationId }) }),
  skills: () => call<{ skills: SkillSummary[]; dir: string }>('/api/skills'),
  skill: (name: string) => call<{ skill: SkillSummary & { body: string } }>(`/api/skills/${encodeURIComponent(name)}`),
  saveSkill: (name: string, description: string, body: string) => call(`/api/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ description, body }) }),
  deleteSkill: (name: string) => call(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  curiosity: (all = false) => call<{ items: CuriosityItem[] }>(`/api/curiosity${all ? '?all=1' : ''}`),
  addCuriosity: (topic: string, why?: string) => call('/api/curiosity', { method: 'POST', body: JSON.stringify({ topic, ...(why ? { why } : {}) }) }),
  updateCuriosity: (id: number, patch: { status?: CuriosityItem['status']; result?: string }) => call(`/api/curiosity/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  curiosityTask: (id: number) => call(`/api/curiosity/${id}/task`, { method: 'POST', body: '{}' }),
  history: (q: string, days?: number) => call<{ hits: HistoryHit[] }>(`/api/history?q=${encodeURIComponent(q)}${days ? `&days=${days}` : ''}`),
  templates: (language: string) => call<TemplatesView>(`/api/templates/${encodeURIComponent(language)}`),
  onboarding: () => call<OnboardingView>('/api/onboarding'),
  onboardingDone: () => call<OnboardingView>('/api/onboarding/done', { method: 'POST', body: '{}' }),
  onboardingPersona: (input: PersonaWrite) => call<OnboardingView & { profile: Profile }>('/api/onboarding/persona', { method: 'POST', body: JSON.stringify(input) }),
  reloadEnv: (env: string[] = []) => call<EnvReloadView>('/api/onboarding/reload-env', { method: 'POST', body: JSON.stringify({ env }) }),
  persona: () => call<PersonaView>('/api/workspace/persona'),
  savePersona: (patch: { soul?: string; user?: string }) => call<PersonaView>('/api/workspace/persona', { method: 'PUT', body: JSON.stringify(patch) }),
};
