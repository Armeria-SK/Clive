import type { DatabaseSync } from 'node:sqlite';

export class KV {
  readonly db: DatabaseSync;
  readonly now: () => number;
  constructor(db: DatabaseSync, now: () => number = Date.now) { this.db = db; this.now = now; }

  get(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  getJson<T>(key: string): T | undefined {
    const value = this.get(key);
    if (value === undefined) return undefined;
    try { return JSON.parse(value) as T; } catch { return undefined; }
  }

  set(key: string, value: string): void {
    this.db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, this.now());
  }

  setJson(key: string, value: unknown): void { this.set(key, JSON.stringify(value)); }

  delete(key: string): void { this.db.prepare('DELETE FROM kv WHERE key = ?').run(key); }
}
