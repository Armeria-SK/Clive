import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/database.ts';
import { describeCron, nextRunAt } from './schedule.ts';

export type TaskStatus = 'inbox' | 'ready' | 'running' | 'waiting' | 'scheduled' | 'done' | 'failed' | 'cancelled';
export type TaskOrigin = 'user' | 'self' | 'curiosity' | 'schedule';

export interface Task {
  id: string;
  title: string;
  body: string;
  next_action: string | null;
  done_criteria: string | null;
  status: TaskStatus;
  origin: TaskOrigin;
  priority: number;
  cron: string | null;
  timezone: string | null;
  run_at: number | null;
  parent_id: string | null;
  conversation_id: string | null;
  waiting_kind: 'question' | 'approval' | null;
  waiting_text: string | null;
  attempts: number;
  max_attempts: number;
  lease_until: number | null;
  result_summary: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  curiosity_id: number | null;
}

export type TaskView = Task & { cron_text: string | null };
export function taskView(task: Task): TaskView { return { ...task, cron_text: task.cron ? describeCron(task.cron) : null }; }

export interface TaskEvent { id: number; task_id: string; kind: string; actor: string; content: string | null; run_id: string | null; created_at: number }

export interface CreateTask {
  title: string;
  body?: string | undefined;
  nextAction?: string | undefined;
  doneCriteria?: string | undefined;
  origin: TaskOrigin;
  priority?: number | undefined;
  runAt?: number | undefined;
  cron?: string | undefined;
  timezone?: string | undefined;
  propose?: boolean | undefined;
  curiosityId?: number | undefined;
  actor: string;
}

export class TaskError extends Error {}

const ORIGIN_ORDER = "CASE origin WHEN 'user' THEN 0 WHEN 'schedule' THEN 1 WHEN 'self' THEN 2 ELSE 3 END";
const ACTIVE: TaskStatus[] = ['inbox', 'ready', 'running', 'waiting', 'scheduled'];

export class TaskStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  onChange: ((task: Task) => void) | undefined;

  constructor(db: DatabaseSync, now: () => number = Date.now) { this.#db = db; this.#now = now; }

  get(id: string): Task | undefined {
    return this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  }

  find(idOrPrefix: string): Task | undefined {
    const exact = this.get(idOrPrefix);
    if (exact) return exact;
    if (idOrPrefix.length < 6) return undefined;
    const rows = this.#db.prepare('SELECT * FROM tasks WHERE id LIKE ? LIMIT 2').all(`${idOrPrefix}%`) as unknown as Task[];
    return rows.length === 1 ? rows[0] : undefined;
  }

  byConversation(conversationId: string): Task | undefined {
    return this.#db.prepare('SELECT * FROM tasks WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1').get(conversationId) as Task | undefined;
  }

  list(options: { statuses?: readonly TaskStatus[]; limit?: number } = {}): Task[] {
    const statuses = options.statuses ?? ACTIVE;
    const placeholders = statuses.map(() => '?').join(',');
    return this.#db.prepare(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY ${ORIGIN_ORDER}, priority, COALESCE(run_at, created_at) LIMIT ?`)
      .all(...statuses, options.limit ?? 200) as unknown as Task[];
  }

  recentlyFinished(limit = 50): Task[] {
    return this.#db.prepare("SELECT * FROM tasks WHERE status IN ('done', 'failed', 'cancelled') ORDER BY COALESCE(completed_at, updated_at) DESC LIMIT ?").all(limit) as unknown as Task[];
  }

  events(taskId: string, limit = 200): TaskEvent[] {
    return this.#db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(taskId, limit) as unknown as TaskEvent[];
  }

  event(taskId: string, kind: string, actor: string, content?: string | null, runId?: string): void {
    this.#db.prepare('INSERT INTO task_events (task_id, kind, actor, content, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(taskId, kind, actor, content ?? null, runId ?? null, this.#now());
  }

  #changed(id: string): Task {
    const task = this.get(id)!;
    this.onChange?.(task);
    return task;
  }

  create(input: CreateTask): Task {
    const title = input.title.trim();
    if (!title) throw new TaskError('タイトルが空です');
    const now = this.#now();
    const id = randomUUID();
    let status: TaskStatus = input.propose ? 'inbox' : 'ready';
    let runAt = input.runAt ?? null;
    if (input.cron) {
      const tz = input.timezone ?? 'UTC';
      runAt = nextRunAt(input.cron, tz, now);
      if (runAt === null) throw new TaskError(`繰り返しの指定（cron）が正しくありません: ${input.cron}`);
      status = 'scheduled';
    }
    this.#db.prepare(`INSERT INTO tasks (id, title, body, next_action, done_criteria, status, origin, priority, cron, timezone, run_at, curiosity_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, title, input.body ?? '', input.nextAction ?? null, input.doneCriteria ?? null, status, input.origin,
      Math.min(3, Math.max(1, input.priority ?? 2)), input.cron ?? null, input.cron ? input.timezone ?? 'UTC' : null, runAt, input.curiosityId ?? null, now, now,
    );
    this.event(id, 'created', input.actor, status === 'inbox' ? '提案として作成' : status === 'scheduled' ? `繰り返し: ${input.cron}` : null);
    return this.#changed(id);
  }

  update(id: string, patch: { title?: string; body?: string; appendNote?: string; nextAction?: string | null; doneCriteria?: string | null; priority?: number; runAt?: number | null }, actor: string, runId?: string): Task {
    return transaction(this.#db, () => {
      const task = this.get(id);
      if (!task) throw new TaskError(`タスク ${id} がありません`);
      const body = patch.appendNote ? `${task.body}${task.body ? '\n' : ''}- ${patch.appendNote}` : patch.body ?? task.body;
      this.#db.prepare(`UPDATE tasks SET title = ?, body = ?, next_action = ?, done_criteria = ?, priority = ?, run_at = ?, updated_at = ? WHERE id = ?`).run(
        patch.title?.trim() || task.title, body.slice(-20_000),
        patch.nextAction === undefined ? task.next_action : patch.nextAction,
        patch.doneCriteria === undefined ? task.done_criteria : patch.doneCriteria,
        patch.priority === undefined ? task.priority : Math.min(3, Math.max(1, patch.priority)),
        patch.runAt === undefined ? task.run_at : patch.runAt, this.#now(), id,
      );
      if (patch.appendNote) this.event(id, 'note', actor, patch.appendNote, runId);
      return this.#changed(id);
    });
  }

  claim(id: string, leaseMs: number, conversationId: string): boolean {
    const now = this.#now();
    const result = this.#db.prepare(`UPDATE tasks SET status = 'running', lease_until = ?, conversation_id = COALESCE(conversation_id, ?), updated_at = ? WHERE id = ? AND status = 'ready'`)
      .run(now + leaseMs, conversationId, now, id);
    if (Number(result.changes) !== 1) return false;
    this.#changed(id);
    return true;
  }

  setReady(id: string, options: { runAt?: number | null; countAttempt?: boolean; reason?: string; actor?: string } = {}): Task {
    this.#db.prepare(`UPDATE tasks SET status = 'ready', lease_until = NULL, waiting_kind = NULL, waiting_text = NULL, run_at = ?, attempts = attempts + ?, updated_at = ? WHERE id = ?`)
      .run(options.runAt ?? null, options.countAttempt ? 1 : 0, this.#now(), id);
    if (options.reason) this.event(id, 'requeued', options.actor ?? 'system', options.reason);
    return this.#changed(id);
  }

  setWaiting(id: string, kind: 'question' | 'approval', text: string, runId?: string): Task {
    this.#db.prepare(`UPDATE tasks SET status = 'waiting', waiting_kind = ?, waiting_text = ?, lease_until = NULL, updated_at = ? WHERE id = ?`)
      .run(kind, text, this.#now(), id);
    this.event(id, kind === 'question' ? 'question' : 'approval', 'clive', text, runId);
    return this.#changed(id);
  }

  finish(id: string, status: 'done' | 'failed' | 'cancelled', summary: string | null, actor: string, runId?: string): Task {
    const now = this.#now();
    this.#db.prepare(`UPDATE tasks SET status = ?, result_summary = ?, lease_until = NULL, waiting_kind = NULL, waiting_text = NULL, completed_at = ?, updated_at = ? WHERE id = ?`)
      .run(status, summary, now, now, id);
    this.event(id, status, actor, summary, runId);
    return this.#changed(id);
  }

  approve(id: string): Task {
    const task = this.get(id);
    if (!task || task.status !== 'inbox') throw new TaskError('承認待ちの提案ではありません');
    this.event(id, 'approved', 'user');
    return this.setReady(id);
  }

  recoverExpiredLeases(options: { all?: boolean } = {}): number {
    const now = this.#now();
    const rows = (options.all
      ? this.#db.prepare("SELECT id FROM tasks WHERE status = 'running'").all()
      : this.#db.prepare("SELECT id FROM tasks WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)").all(now)) as Array<{ id: string }>;
    for (const { id } of rows) this.setReady(id, { reason: '前回の実行が途中で止まったため、もう一度実行します' });
    return rows.length;
  }

  spawnDueSchedules(): Task[] {
    const now = this.#now();
    const due = this.#db.prepare("SELECT * FROM tasks WHERE status = 'scheduled' AND run_at IS NOT NULL AND run_at <= ?").all(now) as unknown as Task[];
    const spawned: Task[] = [];
    for (const template of due) {
      transaction(this.#db, () => {
        const next = nextRunAt(template.cron ?? '', template.timezone ?? 'UTC', now);
        this.#db.prepare('UPDATE tasks SET run_at = ?, updated_at = ? WHERE id = ?').run(next, now, template.id);
        const child = this.#spawnChild(template, 'schedule');
        if (child) spawned.push(child);
      });
    }
    return spawned;
  }

  spawnNow(templateId: string): Task | undefined {
    const template = this.get(templateId);
    if (!template || template.status !== 'scheduled') throw new TaskError('予定ではありません');
    return transaction(this.#db, () => this.#spawnChild(template, 'user'));
  }

  #spawnChild(template: Task, actor: string): Task | undefined {
    const now = this.#now();
    // 前回分がまだ終わっていなければ、重ねて作らない
    const open = this.#db.prepare("SELECT 1 FROM tasks WHERE parent_id = ? AND status IN ('ready', 'running', 'waiting')").get(template.id);
    if (open) { this.event(template.id, 'skipped', 'system', '前回の実行がまだ終わっていないため、今回は作りませんでした'); return undefined; }
    const id = randomUUID();
    this.#db.prepare(`INSERT INTO tasks (id, title, body, next_action, done_criteria, status, origin, priority, parent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ready', 'schedule', ?, ?, ?, ?)`).run(id, template.title, template.body, template.next_action, template.done_criteria, template.priority, template.id, now, now);
    this.event(id, 'created', actor, `予定「${template.title}」から作成`);
    return this.#changed(id);
  }

  reopen(id: string, actor: string, reason?: string): Task {
    const task = this.get(id);
    if (!task) throw new TaskError(`タスク ${id} がありません`);
    if (task.status === 'running') throw new TaskError('実行中です');
    if (task.status === 'scheduled') throw new TaskError('予定はそのままでは実行できません（今すぐ実行を使ってください）');
    this.#db.prepare(`UPDATE tasks SET status = 'ready', attempts = 0, run_at = NULL, lease_until = NULL, waiting_kind = NULL, waiting_text = NULL, completed_at = NULL, updated_at = ? WHERE id = ?`)
      .run(this.#now(), id);
    this.event(id, 'reopened', actor, reason ?? null);
    return this.#changed(id);
  }

  pickNext(options: { allowSelf: boolean }): Task | undefined {
    const now = this.#now();
    const origins = options.allowSelf ? "('user', 'schedule', 'self', 'curiosity')" : "('user', 'schedule')";
    return this.#db.prepare(`SELECT * FROM tasks WHERE status = 'ready' AND (run_at IS NULL OR run_at <= ?) AND attempts < max_attempts AND origin IN ${origins}
      ORDER BY ${ORIGIN_ORDER}, priority, COALESCE(run_at, created_at) LIMIT 1`).get(now) as Task | undefined;
  }

  nextWakeAt(options: { allowSelf: boolean }): number | undefined {
    const now = this.#now();
    const origins = options.allowSelf ? "('user', 'schedule', 'self', 'curiosity')" : "('user', 'schedule')";
    const row = this.#db.prepare(`SELECT MIN(run_at) AS t FROM tasks WHERE run_at > ? AND (status = 'scheduled' OR (status = 'ready' AND origin IN ${origins}))`).get(now) as { t: number | null };
    return row.t ?? undefined;
  }

  createdSince(origin: TaskOrigin, since: number): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE origin = ? AND created_at > ?').get(origin, since) as { n: number }).n;
  }

  waitingSince(olderThanMs: number): Task[] {
    return this.#db.prepare("SELECT * FROM tasks WHERE status = 'waiting' AND updated_at < ?").all(this.#now() - olderThanMs) as unknown as Task[];
  }
}
