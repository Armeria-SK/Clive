import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.ts';
import type { ChatMessage } from '../engine/types.ts';

export interface ConversationRow {
  id: string;
  kind: 'chat' | 'task';
  title: string | null;
  snapshot: string | null;
  snapshot_hash: string | null;
  archived: number;
  created_at: number;
  last_message_at: number;
  summary: string | null;
  summary_upto: number | null;
  model_id: string | null;
  effort: string | null;
}

// 一覧に出す会話。固定の system の全文や要約の全文は載せない（要約は has_summary で有無だけ。全文は summaryOf で読む）
export type ConversationListItem = Omit<ConversationRow, 'snapshot' | 'snapshot_hash' | 'summary'> & { has_summary: boolean };

export interface StoredMessage {
  id: number;
  conversation_id: string;
  run_id: string | null;
  role: ChatMessage['role'];
  text: string;
  message: ChatMessage;
  created_at: number;
}

export function messageText(message: ChatMessage): string {
  if (message.role === 'tool') return `[${message.name}] ${message.content}`;
  return message.content;
}

export class Conversations {
  readonly db: DatabaseSync;
  readonly now: () => number;
  constructor(db: DatabaseSync, now: () => number = Date.now) { this.db = db; this.now = now; }

  create(input: { title?: string; kind?: 'chat' | 'task'; id?: string } = {}): ConversationRow {
    const now = this.now();
    const id = input.id ?? randomUUID();
    this.db.prepare(`INSERT INTO conversations (id, kind, title, created_at, last_message_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, input.kind ?? 'chat', input.title ?? null, now, now);
    return this.get(id)!;
  }

  get(id: string): ConversationRow | undefined {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
  }

  // チャットの会話の一覧（新しい順）。archived: true でアーカイブした会話。query は題の部分一致（大文字小文字を区別しない）
  list(limit = 100, options: { archived?: boolean; query?: string } = {}): ConversationListItem[] {
    const query = options.query?.trim();
    const like = query ? `%${query.replace(/[!%_]/gu, '!$&')}%` : null;
    const rows = this.db.prepare(`
      SELECT id, kind, title, archived, created_at, last_message_at, summary_upto, model_id, effort,
        (summary IS NOT NULL AND summary != '') AS has_summary
      FROM conversations WHERE archived = ? AND kind = 'chat'${like ? " AND title LIKE ? ESCAPE '!'" : ''}
      ORDER BY last_message_at DESC LIMIT ?
    `).all(...[options.archived ? 1 : 0, ...(like ? [like] : []), limit]) as unknown as Array<Omit<ConversationListItem, 'has_summary'> & { has_summary: number }>;
    return rows.map(row => ({ ...row, has_summary: row.has_summary === 1 }));
  }

  // 会話の要約（全文）と、どこまでの発言を要約したか・要約した発言の件数
  summaryOf(id: string): { summary: string | null; upto: number | null; summarizedMessages: number } {
    const row = this.get(id);
    const upto = row?.summary_upto ?? null;
    const count = upto === null ? 0 : Number((this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND id <= ?').get(id, upto) as { n: number }).n);
    return { summary: row?.summary?.trim() ? row.summary : null, upto: row?.summary?.trim() ? upto : null, summarizedMessages: row?.summary?.trim() ? count : 0 };
  }

  // 無ければ空の会話を作る（最初の発言の前に、選んだモデルを覚えるため）
  ensure(id: string): void {
    if (this.get(id)) return;
    const now = this.now();
    this.db.prepare(`INSERT INTO conversations (id, kind, created_at, last_message_at) VALUES (?, 'chat', ?, ?)`).run(id, now, now);
  }

  // 会話で選んだモデルと考える深さ。渡さなかった方は変えない（null は自動・モデルの既定に戻す）
  setChoice(id: string, choice: { modelId?: string | null | undefined; effort?: string | null | undefined }): void {
    this.ensure(id);
    if (choice.modelId !== undefined) this.db.prepare('UPDATE conversations SET model_id = ? WHERE id = ?').run(choice.modelId, id);
    if (choice.effort !== undefined) this.db.prepare('UPDATE conversations SET effort = ? WHERE id = ?').run(choice.effort, id);
  }

  rename(id: string, title: string): void {
    this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
  }

  archive(id: string): void {
    this.db.prepare('UPDATE conversations SET archived = 1 WHERE id = ?').run(id);
  }

  unarchive(id: string): void {
    this.db.prepare('UPDATE conversations SET archived = 0 WHERE id = ?').run(id);
  }

  setSnapshotOnce(id: string, snapshot: string, hash: string): boolean {
    const result = this.db.prepare('UPDATE conversations SET snapshot = ?, snapshot_hash = ? WHERE id = ? AND snapshot IS NULL')
      .run(snapshot, hash, id);
    return Number(result.changes) === 1;
  }

  append(conversationId: string, message: ChatMessage, runId?: string): StoredMessage {
    return transaction(this.db, () => {
      const now = this.now();
      this.ensure(conversationId);
      const text = messageText(message);
      const result = this.db.prepare(`INSERT INTO messages (conversation_id, run_id, role, text, parts, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(conversationId, runId ?? null, message.role, text, JSON.stringify(message), now);
      this.db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(now, conversationId);
      return {
        id: Number(result.lastInsertRowid), conversation_id: conversationId, run_id: runId ?? null,
        role: message.role, text, message, created_at: now,
      };
    });
  }

  messages(conversationId: string, limit = 500): StoredMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC
    `).all(conversationId, limit) as unknown as Array<Omit<StoredMessage, 'message'> & { parts: string }>;
    return rows.map(({ parts, ...row }) => ({ ...row, message: JSON.parse(parts) as ChatMessage }));
  }

  setSummary(id: string, summary: string, upto: number): void {
    this.db.prepare('UPDATE conversations SET summary = ?, summary_upto = ? WHERE id = ?').run(summary, upto, id);
  }

  autoTitle(id: string, text: string): void {
    const title = text.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (title) this.db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND title IS NULL').run(title, id);
  }
}
