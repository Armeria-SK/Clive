import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/database.ts';
import { DEFAULT_LANGUAGE, type Language } from '../config/schema.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { taskText, type TaskErrorCode } from '../shared/messages/tasks.ts';
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
  cancelled_from: TaskStatus | null;
}

export type TaskView = Task & { cron_text: string | null };
export function taskView(task: Task, language: Language = DEFAULT_LANGUAGE): TaskView { return { ...task, cron_text: task.cron ? describeCron(task.cron, language) : null }; }

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

export class TaskError extends LocalizedError<TaskErrorCode> {
  constructor(code: TaskErrorCode, params?: MessageParams) { super(taskText, code, params); }
}

const ORIGIN_ORDER = "CASE origin WHEN 'user' THEN 0 WHEN 'schedule' THEN 1 WHEN 'self' THEN 2 ELSE 3 END";
const ACTIVE: TaskStatus[] = ['inbox', 'ready', 'running', 'waiting', 'scheduled'];
// 取り消しを元に戻せる状態（取り消す直前がこの中のどれかのときだけ、戻す先を覚える）
const RESTORABLE: readonly TaskStatus[] = ACTIVE;

export class TaskStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  onChange: ((task: Task) => void) | undefined;
  // 取り消しを戻すとき、タスクの書き換えと同じ transaction の中で呼ばれる（好奇心の状態を戻すため）
  onUncancelled: ((task: Task) => void) | undefined;

  readonly #language: () => Language;

  constructor(db: DatabaseSync, now: () => number = Date.now, language: () => Language = () => DEFAULT_LANGUAGE) { this.#db = db; this.#now = now; this.#language = language; }

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

  // この会話の task_create で作られたタスクの id（作ったときに残す経過 'context' の本文に会話の id が入る）
  createdByConversation(conversationId: string): string[] {
    const rows = this.#db.prepare("SELECT DISTINCT task_id FROM task_events WHERE kind = 'context' AND instr(content, ?) > 0").all(conversationId) as Array<{ task_id: string }>;
    return rows.map(r => r.task_id);
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
    if (!title) throw new TaskError('error.empty_title');
    const now = this.#now();
    const id = randomUUID();
    let status: TaskStatus = input.propose ? 'inbox' : 'ready';
    let runAt = input.runAt ?? null;
    if (input.cron) {
      const tz = input.timezone ?? 'UTC';
      runAt = nextRunAt(input.cron, tz, now);
      if (runAt === null) throw new TaskError('error.bad_cron', { cron: input.cron });
      status = 'scheduled';
    }
    this.#db.prepare(`INSERT INTO tasks (id, title, body, next_action, done_criteria, status, origin, priority, cron, timezone, run_at, curiosity_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, title, input.body ?? '', input.nextAction ?? null, input.doneCriteria ?? null, status, input.origin,
      Math.min(3, Math.max(1, input.priority ?? 2)), input.cron ?? null, input.cron ? input.timezone ?? 'UTC' : null, runAt, input.curiosityId ?? null, now, now,
    );
    this.event(id, 'created', input.actor, status === 'inbox' ? taskText(this.#language(), 'event.proposed') : status === 'scheduled' ? taskText(this.#language(), 'event.repeat', { cron: input.cron! }) : null);
    return this.#changed(id);
  }

  update(id: string, patch: { title?: string; body?: string; appendNote?: string; nextAction?: string | null; doneCriteria?: string | null; priority?: number; runAt?: number | null }, actor: string, runId?: string): Task {
    return transaction(this.#db, () => {
      const task = this.get(id);
      if (!task) throw new TaskError('error.not_found', { id });
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
    if (status === 'cancelled') {
      // 取り消す直前の状態を覚える（取り消しを戻す先）。質問の文は消さない。もう取り消してあるものを重ねて取り消しても、前の記録を残す
      const before = this.get(id);
      const from = before?.status === 'cancelled' ? before.cancelled_from : before && RESTORABLE.includes(before.status) ? before.status : null;
      this.#db.prepare(`UPDATE tasks SET status = 'cancelled', result_summary = ?, lease_until = NULL, cancelled_from = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
        .run(summary, from, now, now, id);
    } else {
      this.#db.prepare(`UPDATE tasks SET status = ?, result_summary = ?, lease_until = NULL, waiting_kind = NULL, waiting_text = NULL, cancelled_from = NULL, completed_at = ?, updated_at = ? WHERE id = ?`)
        .run(status, summary, now, now, id);
    }
    this.event(id, status, actor, summary, runId);
    return this.#changed(id);
  }

  // 取り消しを、取り消す直前の状態へ戻す。状態が変わっていなければ（まだ取り消したまま）いつでも戻せる
  uncancel(id: string, actor: string): Task {
    transaction(this.#db, () => {
      const task = this.get(id);
      if (!task) throw new TaskError('error.not_found', { id });
      if (task.status !== 'cancelled') throw new TaskError('error.not_cancelled');
      const from = task.cancelled_from;
      if (!from) throw new TaskError('error.no_cancel_record');
      // 繰り返しの実行は、同じ予定の別の実行が動いているあいだは戻さない（重ねて動かさない。#spawnChild と同じ決まり）
      if (task.parent_id && this.hasOpenRun(task.parent_id)) throw new TaskError('error.sibling_open');
      const now = this.#now();
      let runAt = task.run_at;
      let status: TaskStatus = from;
      if (from === 'running') { status = 'ready'; runAt = null; }
      if (from === 'scheduled' && (runAt === null || runAt <= now)) {
        // 取り消していたあいだの回を、あとからまとめて動かさない
        runAt = nextRunAt(task.cron ?? '', task.timezone ?? 'UTC', now);
        if (runAt === null) throw new TaskError('error.bad_cron', { cron: task.cron ?? '' });
      }
      this.#db.prepare(`UPDATE tasks SET status = ?, run_at = ?, lease_until = NULL, cancelled_from = NULL, completed_at = NULL, result_summary = NULL, updated_at = ? WHERE id = ?`)
        .run(status, runAt, now, id);
      this.event(id, 'uncancelled', actor, taskText(this.#language(), 'event.uncancelled'));
      this.onUncancelled?.(this.get(id)!);
    });
    return this.#changed(id);
  }

  // 同じ予定から作られた実行で、まだ終わっていない（実行待ち・実行中・返事待ち）ものがあるか
  hasOpenRun(parentId: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM tasks WHERE parent_id = ? AND status IN ('ready', 'running', 'waiting')").get(parentId));
  }

  approve(id: string): Task {
    const task = this.get(id);
    if (!task || task.status !== 'inbox') throw new TaskError('error.not_proposal');
    this.event(id, 'approved', 'user');
    return this.setReady(id);
  }

  recoverExpiredLeases(options: { all?: boolean } = {}): number {
    const now = this.#now();
    const rows = (options.all
      ? this.#db.prepare("SELECT id FROM tasks WHERE status = 'running'").all()
      : this.#db.prepare("SELECT id FROM tasks WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)").all(now)) as Array<{ id: string }>;
    for (const { id } of rows) this.setReady(id, { reason: taskText(this.#language(), 'event.recovered') });
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
    if (!template || template.status !== 'scheduled') throw new TaskError('error.not_schedule');
    return transaction(this.#db, () => this.#spawnChild(template, 'user'));
  }

  #spawnChild(template: Task, actor: string): Task | undefined {
    const now = this.#now();
    // 前回分がまだ終わっていなければ、重ねて作らない
    if (this.hasOpenRun(template.id)) { this.event(template.id, 'skipped', 'system', taskText(this.#language(), 'event.skipped')); return undefined; }
    const id = randomUUID();
    this.#db.prepare(`INSERT INTO tasks (id, title, body, next_action, done_criteria, status, origin, priority, parent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ready', 'schedule', ?, ?, ?, ?)`).run(id, template.title, template.body, template.next_action, template.done_criteria, template.priority, template.id, now, now);
    this.event(id, 'created', actor, taskText(this.#language(), 'event.created_from', { title: template.title }));
    return this.#changed(id);
  }

  reopen(id: string, actor: string, reason?: string): Task {
    const task = this.get(id);
    if (!task) throw new TaskError('error.not_found', { id });
    if (task.status === 'running') throw new TaskError('error.running');
    if (task.status === 'scheduled') throw new TaskError('error.schedule_cannot_run');
    const now = this.#now();
    // 繰り返しのひな形は、一回きりの実行待ちではなく予定に戻す（次の回を計算する）
    const isTemplate = task.cron !== null && task.parent_id === null;
    const nextRun = isTemplate ? nextRunAt(task.cron!, task.timezone ?? 'UTC', now) : null;
    if (isTemplate && nextRun === null) throw new TaskError('error.bad_cron', { cron: task.cron! });
    this.#db.prepare(`UPDATE tasks SET status = ?, attempts = 0, run_at = ?, lease_until = NULL, waiting_kind = NULL, waiting_text = NULL, cancelled_from = NULL, completed_at = NULL, updated_at = ? WHERE id = ?`)
      .run(isTemplate ? 'scheduled' : 'ready', nextRun, now, id);
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
