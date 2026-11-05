import type { DatabaseSync } from 'node:sqlite';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { storeText, type StoreMessageKey } from '../shared/messages/stores.ts';

export type CuriosityStatus = 'open' | 'researching' | 'done' | 'dropped';

export interface CuriosityItem {
  id: number;
  topic: string;
  why: string | null;
  status: CuriosityStatus;
  result: string | null;
  task_id: string | null;
  source: 'clive' | 'user' | 'file';
  created_at: number;
  updated_at: number;
}

export class CuriosityError extends LocalizedError<StoreMessageKey> {
  constructor(code: StoreMessageKey, params?: MessageParams) { super(storeText, code, params); }
}

const MAX_OPEN = 100;

export class CuriosityStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  onChange: ((item: CuriosityItem) => void) | undefined;

  constructor(db: DatabaseSync, now: () => number = Date.now) { this.#db = db; this.#now = now; }

  get(id: number): CuriosityItem | undefined {
    return this.#db.prepare('SELECT * FROM curiosity_items WHERE id = ?').get(id) as CuriosityItem | undefined;
  }

  list(options: { includeClosed?: boolean; limit?: number } = {}): CuriosityItem[] {
    const where = options.includeClosed ? '' : "WHERE status IN ('open', 'researching')";
    return this.#db.prepare(`SELECT * FROM curiosity_items ${where} ORDER BY CASE status WHEN 'researching' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, updated_at DESC LIMIT ?`)
      .all(options.limit ?? 200) as unknown as CuriosityItem[];
  }

  add(input: { topic: string; why?: string | undefined; source: CuriosityItem['source'] }): CuriosityItem {
    const topic = input.topic.trim().replace(/\s+/gu, ' ');
    if (!topic) throw new CuriosityError('curiosity.empty_topic');
    if (topic.length > 200) throw new CuriosityError('curiosity.too_long');
    const same = this.#db.prepare("SELECT id FROM curiosity_items WHERE topic = ? AND status IN ('open', 'researching')").get(topic) as { id: number } | undefined;
    if (same) throw new CuriosityError('curiosity.duplicate', { id: same.id });
    const open = (this.#db.prepare("SELECT COUNT(*) AS n FROM curiosity_items WHERE status = 'open'").get() as { n: number }).n;
    if (open >= MAX_OPEN) throw new CuriosityError('curiosity.too_many', { max: MAX_OPEN });
    const now = this.#now();
    const result = this.#db.prepare('INSERT INTO curiosity_items (topic, why, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(topic, input.why?.trim() || null, input.source, now, now);
    return this.#changed(Number(result.lastInsertRowid));
  }

  update(id: number, patch: { topic?: string; why?: string | null; status?: CuriosityStatus; result?: string | null; taskId?: string | null }): CuriosityItem {
    const item = this.get(id);
    if (!item) throw new CuriosityError('curiosity.not_found', { id });
    this.#db.prepare('UPDATE curiosity_items SET topic = ?, why = ?, status = ?, result = ?, task_id = ?, updated_at = ? WHERE id = ?').run(
      patch.topic?.trim() || item.topic,
      patch.why === undefined ? item.why : patch.why,
      patch.status ?? item.status,
      patch.result === undefined ? item.result : patch.result,
      patch.taskId === undefined ? item.task_id : patch.taskId,
      this.#now(), id,
    );
    return this.#changed(id);
  }

  nextOpen(): CuriosityItem | undefined {
    return this.#db.prepare("SELECT * FROM curiosity_items WHERE status = 'open' ORDER BY created_at LIMIT 1").get() as CuriosityItem | undefined;
  }

  onTaskFinished(task: { id: string; status: string; result_summary: string | null; curiosity_id: number | null }): void {
    if (!task.curiosity_id) return;
    const item = this.get(task.curiosity_id);
    if (!item || item.task_id !== task.id || item.status !== 'researching') return;
    if (task.status === 'done') this.update(item.id, { status: 'done', result: task.result_summary });
    // 取り消された（提案を断られた）なら興味を下ろす。失敗なら、また調べられるように戻す
    else if (task.status === 'cancelled') this.update(item.id, { status: 'dropped', taskId: null });
    else this.update(item.id, { status: 'open', taskId: null });
  }

  importMarkdown(markdown: string): number {
    let count = 0;
    for (const line of markdown.split(/\r?\n/u)) {
      const m = /^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/u.exec(line);
      if (!m?.[1]) continue;
      try { this.add({ topic: m[1], source: 'file' }); count++; } catch { }
    }
    return count;
  }

  #changed(id: number): CuriosityItem {
    const item = this.get(id)!;
    this.onChange?.(item);
    return item;
  }
}
