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

// 外のモデルの実行に見せてよい会話の条件（visibleModelIds を渡したとき）。a は会話の別名。
// 見せない: 会話で選んだモデル（conversations.model_id）がこの一覧に無い会話（選んでいない会話は出す）と、手元のモデルだけで動かすタスク（tasks.local_only）の会話。
// 振り返りの会話（memory_jobs.review_conversation_id が指す会話。振り返りのきっかけの会話の全文が入っている）も、きっかけの会話が上の決まりで見せない会話か、きっかけのタスクが手元のものなら見せない。
// 値の差し込み（?）は、見せてよいモデルの id を 2 回（その会話の分と、きっかけの会話の分）この順に渡す
function visibleSql(alias: string, visible: readonly string[]): string {
  const own = (a: string, task: string) => `(${a}.model_id IS NULL${visible.length ? ` OR ${a}.model_id IN (${visible.map(() => '?').join(', ')})` : ''}) AND NOT EXISTS (SELECT 1 FROM tasks ${task} WHERE ${task}.conversation_id = ${a}.id AND ${task}.local_only = 1)`;
  return `${own(alias, 'lt')} AND NOT EXISTS (SELECT 1 FROM memory_jobs j WHERE j.review_conversation_id = ${alias}.id AND (
    EXISTS (SELECT 1 FROM conversations s WHERE s.id = j.conversation_id AND NOT (${own('s', 'ls')}))
    OR EXISTS (SELECT 1 FROM tasks jt WHERE jt.id = j.task_id AND jt.local_only = 1)))`;
}

// visibleModelIds: 渡したとき、上の決まりで見せない会話の発言は出さない。
// 手元のモデルで話した会話を、外のモデルの実行に見せないため、外と分かっているモデルの一覧を渡す（設定から消えたモデルを選んだ会話も出ない）。画面の検索は渡さない
export function searchHistory(db: DatabaseSync, query: string, options: { days?: number | undefined; limit?: number; now?: number; excludeConversationId?: string; visibleModelIds?: readonly string[] | undefined } = {}): HistoryHit[] {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const limit = Math.min(options.limit ?? 12, 50);
  const since = options.days ? (options.now ?? Date.now()) - options.days * 86_400_000 : 0;
  const exclude = options.excludeConversationId ?? '';
  const visible = options.visibleModelIds;
  const hiddenClause = visible ? ` AND ${visibleSql('c', visible)}` : '';
  const hiddenParams = visible ? [...visible, ...visible] : [];
  const rows = terms.every(t => [...t].length >= 3)
    ? db.prepare(`
        SELECT m.id, m.conversation_id, m.role, m.text, m.created_at, c.title FROM messages_fts f
        JOIN messages m ON m.id = f.rowid JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ? AND m.created_at >= ? AND m.conversation_id != ?${hiddenClause}
        ORDER BY m.created_at DESC LIMIT ?`).all(ftsPhrase(terms), since, exclude, ...hiddenParams, limit)
    : db.prepare(`
        SELECT m.id, m.conversation_id, m.role, m.text, m.created_at, c.title FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE ${terms.map(() => "m.text LIKE ? ESCAPE '\\'").join(' AND ')} AND m.created_at >= ? AND m.conversation_id != ?${hiddenClause}
        ORDER BY m.created_at DESC LIMIT ?`).all(...terms.map(t => `%${likeEscape(t)}%`), since, exclude, ...hiddenParams, limit);
  return (rows as Array<{ id: number; conversation_id: string; role: string; text: string; created_at: number; title: string | null }>).map(r => ({
    conversationId: r.conversation_id, title: r.title, messageId: r.id, role: r.role, createdAt: r.created_at, snippet: snippet(r.text, terms),
  }));
}

// visibleModelIds: searchHistory と同じ。この会話が見せない会話（手元の会話・手元のタスクの会話・それらの振り返りの会話）なら、無いときと同じ（空）を返す
export function readHistory(db: DatabaseSync, conversationId: string, options: { aroundMessageId?: number | undefined; limit?: number; visibleModelIds?: readonly string[] | undefined } = {}): Array<{ id: number; role: string; text: string; createdAt: number }> {
  if (options.visibleModelIds && !db.prepare(`SELECT 1 FROM conversations c WHERE c.id = ? AND ${visibleSql('c', options.visibleModelIds)}`).get(conversationId, ...options.visibleModelIds, ...options.visibleModelIds)) return [];
  const limit = Math.min(options.limit ?? 20, 60);
  const rows = options.aroundMessageId === undefined
    ? db.prepare('SELECT id, role, text, created_at FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(conversationId, limit)
    : db.prepare(`SELECT id, role, text, created_at FROM messages WHERE conversation_id = ? AND id >= (
        SELECT COALESCE(MIN(id), 0) FROM (SELECT id FROM messages WHERE conversation_id = ? AND id <= ? ORDER BY id DESC LIMIT ?)
      ) ORDER BY id LIMIT ?`).all(conversationId, conversationId, options.aroundMessageId, Math.ceil(limit / 2), limit);
  return (rows as Array<{ id: number; role: string; text: string; created_at: number }>).map(r => ({ id: r.id, role: r.role, text: r.text, createdAt: r.created_at }));
}
