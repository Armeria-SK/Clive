export interface Conversation { id: string; title: string | null; created_at: number; last_message_at: number }
export interface Message {
  id: number; role: 'user' | 'assistant' | 'tool'; text: string; runId: string | null; createdAt: number;
  toolCalls?: Array<{ id: string; name: string; input: string }>;
  toolName?: string; toolCallId?: string; isError?: boolean;
  attachments?: Array<{ id: string; name: string; kind: 'text' | 'pdf' | 'image' }>;
}
export interface UploadView { id: string; name: string; mime: string; kind: 'text' | 'pdf' | 'image'; size: number; chars: number | null; pages: number | null }
export interface Approval {
  id: string; runId: string; conversationId: string; tool: string; title: string; body: string; cwd?: string;
  reasons: string[]; details: string[]; expiresAt: number;
}
export interface ContextDetail { reason: string; measured?: number; required?: number; hint?: string }

export interface Probe {
  modelId: string; status: string; server: string; declared?: number; measured?: number; modelMax?: number; effective?: number;
  required: number; message: string; hint?: string; capabilities?: string[]; checkedAt: number;
}
export interface ModelView {
  id: string; label: string; provider: string; model: string; providerKind?: string;
  contextLength?: number; minContext: number; maxOutputTokens: number; inChat: boolean; probe: Probe | null;
}
export interface SettingsView {
  config: Record<string, any>;
  apiKeys: Record<string, boolean>;
  configError: { message: string; problems: string[] } | null;
  restartRequired: boolean;
  configPath: string;
}
export interface RunRow {
  id: string; kind: string; conversation_id: string | null; model_id: string | null; attempts: number;
  started_at: number; duration_ms: number | null; ok: number | null; error_kind: string | null; error_message: string | null;
  input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; est_prompt_tokens: number | null; flags: string[];
}

export type Book = 'user' | 'notes';
export interface MemoryItem { id: number; book: Book; content: string; origin: string; source_conversation_id: string | null; source_message_id: number | null; created_at: number; updated_at: number }
export interface MemoryEvent { id: number; memory_id: number; action: string; before: string | null; after: string | null; actor: string; reason: string | null; undone_at: number | null; created_at: number }
export interface BookView { used: number; max: number; items: MemoryItem[] }
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

export class ApiError extends Error {
  readonly status: number;
  readonly body: any;
  constructor(status: number, body: any) {
    super(typeof body?.errorMessage === 'string' ? body.errorMessage : typeof body?.message === 'string' ? body.message : `HTTP ${status}`);
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
  createConversation: () => call<{ conversation: Conversation }>('/api/conversations', { method: 'POST', body: '{}' }),
  renameConversation: (id: string, title: string) => call(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  archiveConversation: (id: string) => call(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) }),
  messages: (id: string) => call<{ conversation: Conversation; messages: Message[]; activeRun: { runId: string; draft: string } | null; approvals: Approval[] }>(`/api/conversations/${id}/messages`),
  approvals: () => call<{ approvals: Approval[] }>('/api/approvals'),
  decide: (id: string, decision: 'once' | 'conversation' | 'deny') => call(`/api/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision }) }),
  send: (id: string, text: string, attachments: string[] = []) => call<{ runId: string }>(`/api/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, ...(attachments.length ? { attachments } : {}) }) }),
  upload: async (file: File) => {
    const res = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body);
    return (body as { upload: UploadView }).upload;
  },
  retry: (id: string) => call<{ runId: string }>(`/api/conversations/${id}/retry`, { method: 'POST', body: '{}' }),
  stop: (runId: string) => call(`/api/runs/${runId}/stop`, { method: 'POST', body: '{}' }),
  runs: () => call<{ runs: RunRow[] }>('/api/runs?limit=200'),
  settings: () => call<SettingsView>('/api/settings'),
  saveSettings: (config: unknown) => call<SettingsView & { models: ModelView[] }>('/api/settings', { method: 'PUT', body: JSON.stringify({ config }) }),
  models: () => call<{ models: ModelView[]; routing: { chat: string[]; background: string[] } }>('/api/models'),
  probe: () => call<{ models: ModelView[] }>('/api/models/probe', { method: 'POST', body: '{}' }),
  memories: () => call<{ books: Record<Book, BookView> }>('/api/memories'),
  addMemory: (book: Book, content: string) => call('/api/memories', { method: 'POST', body: JSON.stringify({ book, content }) }),
  editMemory: (id: number, content: string) => call(`/api/memories/${id}`, { method: 'PATCH', body: JSON.stringify({ content }) }),
  forgetMemory: (id: number) => call(`/api/memories/${id}`, { method: 'DELETE' }),
  memoryEvents: (id: number) => call<{ events: MemoryEvent[] }>(`/api/memories/${id}/events`),
  undoMemory: (eventId: number) => call(`/api/memory-events/${eventId}/undo`, { method: 'POST', body: '{}' }),
  tasks: () => call<{ active: Task[]; finished: Task[] }>('/api/tasks'),
  task: (id: string) => call<{ task: Task; events: TaskEvent[]; approvals: Approval[]; runs: Task[] }>(`/api/tasks/${id}`),
  createTask: (task: NewTask) => call<{ task: Task }>('/api/tasks', { method: 'POST', body: JSON.stringify(task) }),
  editTask: (id: string, patch: { title?: string; body?: string; nextAction?: string | null; priority?: number; when?: string | null }) =>
    call<{ task: Task }>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  answerTask: (id: string, text: string) => call<{ task: Task }>(`/api/tasks/${id}/answer`, { method: 'POST', body: JSON.stringify({ text }) }),
  taskAction: (id: string, action: 'run-now' | 'approve' | 'cancel' | 'done') => call<{ task: Task }>(`/api/tasks/${id}/${action}`, { method: 'POST', body: '{}' }),
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
};
