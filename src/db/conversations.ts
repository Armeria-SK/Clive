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

  list(limit = 100): ConversationRow[] {
    return this.db.prepare(`SELECT * FROM conversations WHERE archived = 0 AND kind = 'chat' ORDER BY last_message_at DESC LIMIT ?`)
      .all(limit) as unknown as ConversationRow[];
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
