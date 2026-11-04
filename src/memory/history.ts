import type { DatabaseSync } from 'node:sqlite';
import { ftsPhrase, likeEscape, searchTerms } from './store.ts';

export interface HistoryHit {
  conversationId: string;
  title: string | null;
  messageId: number;
  role: string;
  createdAt: number;
  snippet: string;
}

function snippet(text: string, terms: readonly string[], width = 160): string {
  const lower = text.toLowerCase();
  const at = terms.map(t => lower.indexOf(t.toLowerCase())).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 40);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + width).replace(/\s+/gu, ' ').trim()}${start + width < text.length ? '…' : ''}`;
}

export function searchHistory(db: DatabaseSync, query: string, options: { days?: number | undefined; limit?: number; now?: number; excludeConversationId?: string } = {}): HistoryHit[] {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const limit = Math.min(options.limit ?? 12, 50);
  const since = options.days ? (options.now ?? Date.now()) - options.days * 86_400_000 : 0;
  const exclude = options.excludeConversationId ?? '';
  const rows = terms.every(t => [...t].length >= 3)
    ? db.prepare(`
        SELECT m.id, m.conversation_id, m.role, m.text, m.created_at, c.title FROM messages_fts f
        JOIN messages m ON m.id = f.rowid JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ? AND m.created_at >= ? AND m.conversation_id != ?
        ORDER BY m.created_at DESC LIMIT ?`).all(ftsPhrase(terms), since, exclude, limit)
    : db.prepare(`
        SELECT m.id, m.conversation_id, m.role, m.text, m.created_at, c.title FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE ${terms.map(() => "m.text LIKE ? ESCAPE '\\'").join(' AND ')} AND m.created_at >= ? AND m.conversation_id != ?
        ORDER BY m.created_at DESC LIMIT ?`).all(...terms.map(t => `%${likeEscape(t)}%`), since, exclude, limit);
  return (rows as Array<{ id: number; conversation_id: string; role: string; text: string; created_at: number; title: string | null }>).map(r => ({
    conversationId: r.conversation_id, title: r.title, messageId: r.id, role: r.role, createdAt: r.created_at, snippet: snippet(r.text, terms),
  }));
}

export function readHistory(db: DatabaseSync, conversationId: string, options: { aroundMessageId?: number | undefined; limit?: number } = {}): Array<{ id: number; role: string; text: string; createdAt: number }> {
  const limit = Math.min(options.limit ?? 20, 60);
  const rows = options.aroundMessageId === undefined
    ? db.prepare('SELECT id, role, text, created_at FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(conversationId, limit)
    : db.prepare(`SELECT id, role, text, created_at FROM messages WHERE conversation_id = ? AND id >= (
        SELECT COALESCE(MIN(id), 0) FROM (SELECT id FROM messages WHERE conversation_id = ? AND id <= ? ORDER BY id DESC LIMIT ?)
      ) ORDER BY id LIMIT ?`).all(conversationId, conversationId, options.aroundMessageId, Math.ceil(limit / 2), limit);
  return (rows as Array<{ id: number; role: string; text: string; created_at: number }>).map(r => ({ id: r.id, role: r.role, text: r.text, createdAt: r.created_at }));
}
