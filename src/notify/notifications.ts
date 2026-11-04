import type { DatabaseSync } from 'node:sqlite';

export type NotificationKind = 'task_done' | 'task_waiting' | 'task_failed' | 'approval_needed' | 'health_alert' | 'info';

export interface Notification {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  dedup_key: string | null;
  read_at: number | null;
  created_at: number;
}

export const DEDUP_MS = 24 * 3_600_000;

export class Notifications {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  onNotify: ((n: Notification) => void) | undefined;

  constructor(db: DatabaseSync, now: () => number = Date.now) { this.#db = db; this.#now = now; }

  notify(input: { kind: NotificationKind; title: string; body?: string | undefined; link?: string | undefined; dedupKey?: string | undefined }): Notification | undefined {
    const now = this.#now();
    if (input.dedupKey) {
      const recent = this.#db.prepare('SELECT 1 FROM notifications WHERE dedup_key = ? AND created_at > ?').get(input.dedupKey, now - DEDUP_MS);
      if (recent) return undefined;
    }
    const result = this.#db.prepare('INSERT INTO notifications (kind, title, body, link, dedup_key, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.kind, input.title.slice(0, 200), input.body?.slice(0, 2000) ?? null, input.link ?? null, input.dedupKey ?? null, now);
    const n = this.#db.prepare('SELECT * FROM notifications WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as Notification;
    this.onNotify?.(n);
    return n;
  }

  list(limit = 50): Notification[] {
    return this.#db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(limit) as unknown as Notification[];
  }

  unread(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').get() as { n: number }).n;
  }

  markRead(ids?: readonly number[]): void {
    const now = this.#now();
    if (!ids) { this.#db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(now); return; }
    for (const id of ids) this.#db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL').run(now, id);
  }
}
