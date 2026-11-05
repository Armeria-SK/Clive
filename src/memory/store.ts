import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE, type Language } from '../config/schema.ts';
import { transaction } from '../db/database.ts';
import { estimateTextTokens } from '../engine/tokens.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { storeText, type StoreMessageKey } from '../shared/messages/stores.ts';
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

export class MemoryError extends LocalizedError<StoreMessageKey> {
  constructor(code: StoreMessageKey, params?: MessageParams) { super(storeText, code, params); }
}

export const BOOK_LABELS: Record<Language, Record<Book, string>> = {
  ja: { user: 'ユーザーについての記憶', notes: 'Clive のメモと教訓' },
  en: { user: 'Memories about the user', notes: "Clive's notes and lessons" },
};
export const BOOK_LABEL = BOOK_LABELS.ja;
const MEMORY_HEADING: Record<Language, string> = { ja: '# 覚えていること（記憶）', en: '# What you remember (memory)' };

const MAX_ITEM_CHARS = 600;

export class MemoryStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #language: () => Language;
  constructor(db: DatabaseSync, now: () => number = Date.now, language: () => Language = () => DEFAULT_LANGUAGE) {
    this.#db = db; this.#now = now; this.#language = language;
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

  #check(content: string): string {
    const text = content.replace(/\s+/gu, ' ').trim();
    if (!text) throw new MemoryError('memory.empty');
    if (text.length > MAX_ITEM_CHARS) throw new MemoryError('memory.too_long', { length: text.length, max: MAX_ITEM_CHARS });
    if (sanitizeModelInputText(text).redaction_count > 0) throw new MemoryError('memory.secret');
    return text;
  }

  #event(memoryId: number, action: MemoryEvent['action'], before: string | null, after: string | null, actor: Actor, runId?: string, reason?: string): number {
    const result = this.#db.prepare(`INSERT INTO memory_events (memory_id, action, before, after, actor, run_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(memoryId, action, before, after, actor, runId ?? null, reason ?? null, this.#now());
    return Number(result.lastInsertRowid);
  }

  save(input: { book: Book; content: string; actor: Actor; origin?: Memory['origin']; conversationId?: string; messageId?: number; runId?: string }): { memory: Memory; eventId: number } {
    return transaction(this.#db, () => {
      const text = this.#check(input.content);
      const duplicate = this.#db.prepare("SELECT id FROM memories WHERE book = ? AND status = 'active' AND content = ?").get(input.book, text) as { id: number } | undefined;
      if (duplicate) throw new MemoryError('memory.duplicate', { ref: `${prefix(input.book)}${duplicate.id}` });
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
      if (!current || current.status !== 'active') throw new MemoryError('memory.not_found', { id });
      const text = this.#check(content);
      if (text === current.content) throw new MemoryError('memory.unchanged');
      this.#db.prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?').run(text, this.#now(), id);
      const eventId = this.#event(id, 'update', current.content, text, actor, runId);
      return { memory: this.get(id)!, eventId };
    });
  }

  forget(id: number, actor: Actor, reason?: string, runId?: string): { memory: Memory; eventId: number } {
    return transaction(this.#db, () => {
      const current = this.get(id);
      if (!current || current.status !== 'active') throw new MemoryError('memory.not_found', { id });
      this.#db.prepare("UPDATE memories SET status = 'forgotten', updated_at = ? WHERE id = ?").run(this.#now(), id);
      const eventId = this.#event(id, 'forget', current.content, null, actor, runId, reason);
      return { memory: this.get(id)!, eventId };
    });
  }

  undo(eventId: number): Memory {
    return transaction(this.#db, () => {
      const event = this.#db.prepare('SELECT * FROM memory_events WHERE id = ?').get(eventId) as MemoryEvent | undefined;
      if (!event) throw new MemoryError('memory.no_event');
      if (event.undone_at) throw new MemoryError('memory.already_undone');
      const current = this.get(event.memory_id);
      if (!current) throw new MemoryError('memory.gone');
      const now = this.#now();
      if (event.action === 'create') {
        this.#db.prepare("UPDATE memories SET status = 'forgotten', updated_at = ? WHERE id = ?").run(now, current.id);
        this.#event(current.id, 'forget', current.content, null, 'user', undefined, storeText(this.#language(), 'memory.undo_note'));
      } else if (event.action === 'update') {
        this.#db.prepare("UPDATE memories SET content = ?, status = 'active', updated_at = ? WHERE id = ?").run(event.before, now, current.id);
        this.#event(current.id, 'update', current.content, event.before, 'user', undefined, storeText(this.#language(), 'memory.undo_note'));
      } else if (event.action === 'forget') {
        this.#db.prepare("UPDATE memories SET status = 'active', updated_at = ? WHERE id = ?").run(now, current.id);
        this.#event(current.id, 'restore', null, current.content, 'user', undefined, storeText(this.#language(), 'memory.undo_note'));
      } else throw new MemoryError('memory.cannot_undo');
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

const memoryLine = (m: Memory): string => `- [${prefix(m.book)}${m.id}] ${m.content}`;

function composeBooks(memories: readonly Memory[], language: Language, omitted: number): string {
  const sections: string[] = [];
  for (const book of ['user', 'notes'] as const) {
    const items = memories.filter(m => m.book === book);
    if (!items.length) continue;
    sections.push(`## ${BOOK_LABELS[language][book]}\n${items.map(memoryLine).join('\n')}`);
  }
  if (omitted > 0) sections.push(storeText(language, 'memory.more', { n: omitted }));
  return sections.length ? `${MEMORY_HEADING[language]}\n\n${sections.join('\n\n')}` : '';
}

export interface BookPlan {
  // 会話の最初に固定する system に入れる文（予算に収まらなかった分は「ほか N 件」の 1 行）
  text: string;
  shown: Memory[];
  // 入らなかった記憶。古い順
  omitted: Memory[];
  // 予算とは関係なく、全部を入れたときの見積もり（トークン）
  tokens: number;
}

// 予算（トークン）まで、新しく直した順（updated_at。同じなら id の大きい方）に入れる。入らない 1 件で止める（新しい順の先頭から数えるので、入らなかった分はいちばん古い側になる）。
// 本の中の並びは今までどおり（渡された順）。予算が無ければ全部入れる。
export function planBooks(memories: readonly Memory[], language: Language = DEFAULT_LANGUAGE, budget?: number): BookPlan {
  const active = memories.filter(m => m.status === 'active');
  const tokens = estimateTextTokens(composeBooks(active, language, 0));
  if (budget === undefined) return { text: composeBooks(active, language, 0), shown: active, omitted: [], tokens };
  const newestFirst = [...active].sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
  let used = estimateTextTokens(MEMORY_HEADING[language]);
  const headed = new Set<Book>();
  const shownIds = new Set<number>();
  for (const m of newestFirst) {
    const heading = headed.has(m.book) ? 0 : estimateTextTokens(`## ${BOOK_LABELS[language][m.book]}`) + 2;
    const cost = heading + estimateTextTokens(memoryLine(m)) + 1;
    if (used + cost > budget) break;
    used += cost;
    headed.add(m.book);
    shownIds.add(m.id);
  }
  const shown = active.filter(m => shownIds.has(m.id));
  const omitted = newestFirst.filter(m => !shownIds.has(m.id)).reverse();
  return { text: composeBooks(shown, language, omitted.length), shown, omitted, tokens };
}

export function renderBooks(memories: readonly Memory[], language: Language = DEFAULT_LANGUAGE, budget?: number): string {
  return planBooks(memories, language, budget).text;
}

export function searchTerms(q: string): string[] {
  return q.split(/[\s　]+/u).map(t => t.trim()).filter(Boolean).slice(0, 8);
}

export function ftsPhrase(terms: readonly string[]): string {
  return terms.map(term => `"${term.replace(/"/gu, '""')}"`).join(' ');
}

export function likeEscape(q: string): string { return q.replace(/[\\%_]/gu, ch => `\\${ch}`); }
