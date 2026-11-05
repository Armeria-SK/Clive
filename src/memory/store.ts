import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE, type Language } from '../config/schema.ts';
import { transaction } from '../db/database.ts';
import { sanitizeModelInputText } from '../shared/redaction.ts';

export type Book = 'user' | 'notes';
export type Actor = 'clive' | 'user' | 'review';

export interface Memory {
  id: number;
  book: Book;
  content: string;
  status: 'active' | 'forgotten';
  origin: 'chat' | 'review' | 'user';
  source_conversation_id: string | null;
  source_message_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface MemoryEvent {
  id: number;
  memory_id: number;
  action: 'create' | 'update' | 'forget' | 'restore';
  before: string | null;
  after: string | null;
  actor: Actor;
  run_id: string | null;
  reason: string | null;
  undone_at: number | null;
  created_at: number;
}

export class MemoryError extends Error {}

export const BOOK_LABELS: Record<Language, Record<Book, string>> = {
  ja: { user: 'ユーザーについての記憶', notes: 'Clive のメモと教訓' },
  en: { user: 'Memories about the user', notes: "Clive's notes and lessons" },
};
export const BOOK_LABEL = BOOK_LABELS.ja;
const MEMORY_HEADING: Record<Language, string> = { ja: '# 覚えていること（記憶）', en: '# What you remember (memory)' };

const MAX_ITEM_CHARS = 600;

export class MemoryStore {
  readonly #db: DatabaseSync;
  readonly #caps: () => Record<Book, number>;
  readonly #now: () => number;
  constructor(db: DatabaseSync, caps: () => Record<Book, number>, now: () => number = Date.now) {
    this.#db = db; this.#caps = caps; this.#now = now;
  }

  get(id: number): Memory | undefined {
    return this.#db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined;
  }

  list(book?: Book, includeForgotten = false): Memory[] {
    const where = [book ? 'book = ?' : '1 = 1', includeForgotten ? '1 = 1' : "status = 'active'"].join(' AND ');
    const stmt = this.#db.prepare(`SELECT * FROM memories WHERE ${where} ORDER BY book, created_at ASC`);
    return (book ? stmt.all(book) : stmt.all()) as unknown as Memory[];
  }

  used(book: Book): number {
    const row = this.#db.prepare("SELECT COALESCE(SUM(LENGTH(content)), 0) AS n FROM memories WHERE book = ? AND status = 'active'").get(book) as { n: number };
    return row.n;
  }

  usage(): Record<Book, { used: number; max: number }> {
    const caps = this.#caps();
    return { user: { used: this.used('user'), max: caps.user }, notes: { used: this.used('notes'), max: caps.notes } };
  }

  #check(book: Book, content: string, replacingLength = 0): string {
    const text = content.replace(/\s+/gu, ' ').trim();
    if (!text) throw new MemoryError('中身が空です');
    if (text.length > MAX_ITEM_CHARS) throw new MemoryError(`1件が長すぎます（${text.length} 文字、上限 ${MAX_ITEM_CHARS}）。要点だけにするか、詳しい内容はファイルに書いてください`);
    if (sanitizeModelInputText(text).redaction_count > 0) throw new MemoryError('API キーやトークンらしい文字列を含む内容は記憶しません');
    const cap = this.#caps()[book];
    const next = this.used(book) - replacingLength + text.length;
    if (next > cap) {
      throw new MemoryError(`${BOOK_LABEL[book]}が上限 ${cap.toLocaleString('en-US')} 文字を超えます（今 ${this.used(book).toLocaleString('en-US')} 文字）。似た記憶を memory_update でまとめるか、もう要らない記憶を memory_forget で消してから保存してください`);
    }
    return text;
  }

  #event(memoryId: number, action: MemoryEvent['action'], before: string | null, after: string | null, actor: Actor, runId?: string, reason?: string): number {
    const result = this.#db.prepare(`INSERT INTO memory_events (memory_id, action, before, after, actor, run_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(memoryId, action, before, after, actor, runId ?? null, reason ?? null, this.#now());
    return Number(result.lastInsertRowid);
  }

  save(input: { book: Book; content: string; actor: Actor; origin?: Memory['origin']; conversationId?: string; messageId?: number; runId?: string }): { memory: Memory; eventId: number } {
    return transaction(this.#db, () => {
      const text = this.#check(input.book, input.content);
      const duplicate = this.#db.prepare("SELECT id FROM memories WHERE book = ? AND status = 'active' AND content = ?").get(input.book, text) as { id: number } | undefined;
      if (duplicate) throw new MemoryError(`同じ内容が既にあります（[${prefix(input.book)}${duplicate.id}]）`);
      const now = this.#now();
      const result = this.#db.prepare(`INSERT INTO memories (book, content, origin, source_conversation_id, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(input.book, text, input.origin ?? (input.actor === 'user' ? 'user' : input.actor === 'review' ? 'review' : 'chat'), input.conversationId ?? null, input.messageId ?? null, now, now);
      const id = Number(result.lastInsertRowid);
      const eventId = this.#event(id, 'create', null, text, input.actor, input.runId);
      return { memory: this.get(id)!, eventId };
    });
  }

  update(id: number, content: string, actor: Actor, runId?: string): { memory: Memory; eventId: number } {
    return transaction(this.#db, () => {
      const current = this.get(id);
      if (!current || current.status !== 'active') throw new MemoryError(`記憶 ${id} がありません`);
      const text = this.#check(current.book, content, current.content.length);
      if (text === current.content) throw new MemoryError('内容が変わっていません');
      this.#db.prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?').run(text, this.#now(), id);
      const eventId = this.#event(id, 'update', current.content, text, actor, runId);
      return { memory: this.get(id)!, eventId };
    });
  }

  forget(id: number, actor: Actor, reason?: string, runId?: string): { memory: Memory; eventId: number } {
    return transaction(this.#db, () => {
      const current = this.get(id);
      if (!current || current.status !== 'active') throw new MemoryError(`記憶 ${id} がありません`);
      this.#db.prepare("UPDATE memories SET status = 'forgotten', updated_at = ? WHERE id = ?").run(this.#now(), id);
      const eventId = this.#event(id, 'forget', current.content, null, actor, runId, reason);
      return { memory: this.get(id)!, eventId };
    });
  }

  undo(eventId: number): Memory {
    return transaction(this.#db, () => {
      const event = this.#db.prepare('SELECT * FROM memory_events WHERE id = ?').get(eventId) as MemoryEvent | undefined;
      if (!event) throw new MemoryError('その変更はありません');
      if (event.undone_at) throw new MemoryError('既に取り消しています');
      const current = this.get(event.memory_id);
      if (!current) throw new MemoryError('記憶がありません');
      const now = this.#now();
      if (event.action === 'create') {
        this.#db.prepare("UPDATE memories SET status = 'forgotten', updated_at = ? WHERE id = ?").run(now, current.id);
        this.#event(current.id, 'forget', current.content, null, 'user', undefined, '取り消し');
      } else if (event.action === 'update') {
        this.#db.prepare("UPDATE memories SET content = ?, status = 'active', updated_at = ? WHERE id = ?").run(event.before, now, current.id);
        this.#event(current.id, 'update', current.content, event.before, 'user', undefined, '取り消し');
      } else if (event.action === 'forget') {
        this.#check(current.book, current.content);
        this.#db.prepare("UPDATE memories SET status = 'active', updated_at = ? WHERE id = ?").run(now, current.id);
        this.#event(current.id, 'restore', null, current.content, 'user', undefined, '取り消し');
      } else throw new MemoryError('この変更は取り消せません');
      this.#db.prepare('UPDATE memory_events SET undone_at = ? WHERE id = ?').run(now, eventId);
      return this.get(current.id)!;
    });
  }

  events(memoryId?: number, limit = 200): MemoryEvent[] {
    const sql = memoryId === undefined ? 'SELECT * FROM memory_events ORDER BY id DESC LIMIT ?' : 'SELECT * FROM memory_events WHERE memory_id = ? ORDER BY id DESC LIMIT ?';
    return (memoryId === undefined ? this.#db.prepare(sql).all(limit) : this.#db.prepare(sql).all(memoryId, limit)) as unknown as MemoryEvent[];
  }

  search(query: string, limit = 20): Memory[] {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    if (terms.every(t => [...t].length >= 3)) {
      return this.#db.prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid WHERE memories_fts MATCH ? AND m.status = 'active' ORDER BY rank LIMIT ?`)
        .all(ftsPhrase(terms), limit) as unknown as Memory[];
    }
    const where = terms.map(() => "content LIKE ? ESCAPE '\\'").join(' AND ');
    return this.#db.prepare(`SELECT * FROM memories WHERE status = 'active' AND ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...terms.map(t => `%${likeEscape(t)}%`), limit) as unknown as Memory[];
  }
}

export function prefix(book: Book): string { return book === 'user' ? 'u' : 'n'; }

export function renderBooks(memories: readonly Memory[], language: Language = DEFAULT_LANGUAGE): string {
  const sections: string[] = [];
  for (const book of ['user', 'notes'] as const) {
    const items = memories.filter(m => m.book === book && m.status === 'active');
    if (!items.length) continue;
    sections.push(`## ${BOOK_LABELS[language][book]}\n${items.map(m => `- [${prefix(book)}${m.id}] ${m.content}`).join('\n')}`);
  }
  return sections.length ? `${MEMORY_HEADING[language]}\n\n${sections.join('\n\n')}` : '';
}

export function searchTerms(q: string): string[] {
  return q.split(/[\s　]+/u).map(t => t.trim()).filter(Boolean).slice(0, 8);
}

export function ftsPhrase(terms: readonly string[]): string {
  return terms.map(term => `"${term.replace(/"/gu, '""')}"`).join(' ');
}

export function likeEscape(q: string): string { return q.replace(/[\\%_]/gu, ch => `\\${ch}`); }
