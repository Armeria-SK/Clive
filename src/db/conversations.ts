import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.ts';
import type { ChatMessage } from '../engine/types.ts';
import type { PermissionMode } from '../shared/permission-mode.ts';

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
  permission_mode: PermissionMode;
  // 1 = この会話のチャットの実行が、外から読んだ内容（Web・添付・シェルの取得）を一度でも読んだ。付いたら外れない
  ever_tainted: number;
  // 1 = この会話のどこかの実行で、自動承認の判定役が許可フォルダの外を読むのを許した。付いたら外れない
  ever_auto_read: number;
  // 記憶の振り返りの会話だけが持つ。振り返りの材料にした会話・タスク（振り返りの会話には、その全文が入る）。外のモデルの履歴の検索・読み出しから隠す決まりに使う
  source_conversation_id: string | null;
  source_task_id: string | null;
}

// 一覧に出す会話。固定の system の全文や要約の全文は載せない（要約は has_summary で有無だけ。全文は summaryOf で読む）
export type ConversationListItem = Omit<ConversationRow, 'snapshot' | 'snapshot_hash' | 'summary' | 'ever_tainted' | 'ever_auto_read' | 'source_conversation_id' | 'source_task_id'> & { has_summary: boolean };

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

export interface ReviewSource { conversationId?: string | null | undefined; taskId?: string | null | undefined }

// 消した会話の id を覚えておく時間
const DELETED_TTL_MS = 10 * 60_000;

export class Conversations {
  readonly db: DatabaseSync;
  readonly now: () => number;
  readonly #log: ((line: string) => void) | undefined;
  // 消した会話の id と、覚えておく期限。消したあとに、動いていた実行の遅れた書き込みが、会話を作り直さないようにする
  readonly #deleted = new Map<string, number>();
  constructor(db: DatabaseSync, now: () => number = Date.now, log?: (line: string) => void) { this.db = db; this.now = now; this.#log = log; }

  // 消した会話の id を、しばらくのあいだ覚える（その間、その id への ensure / append / setChoice は、会話を作らずに見送る）
  markDeleted(ids: readonly string[]): void {
    const now = this.now();
    for (const [id, until] of this.#deleted) if (until <= now) this.#deleted.delete(id);
    for (const id of ids) this.#deleted.set(id, now + DELETED_TTL_MS);
  }

  // 消した id への新しい発言（持ち主が、同じ id へ送り直した）のとき、覚えを外す。呼ぶのは、ユーザーの発言を受け付ける入口だけ
  reopen(id: string): void { this.#deleted.delete(id); }

  #isDeleted(id: string): boolean {
    const until = this.#deleted.get(id);
    if (until === undefined) return false;
    if (until <= this.now()) { this.#deleted.delete(id); return false; }
    return true;
  }

  // source: 記憶の振り返りの会話を作るとき、材料にした会話・タスク。作ると同時に覚える（作ってから振り返りの記録に結び付くまでの間にも、隠す決まりが効くように）
  create(input: { title?: string; kind?: 'chat' | 'task'; id?: string; source?: ReviewSource } = {}): ConversationRow {
    const now = this.now();
    const id = input.id ?? randomUUID();
    this.db.prepare(`INSERT INTO conversations (id, kind, title, created_at, last_message_at, source_conversation_id, source_task_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.kind ?? 'chat', input.title ?? null, now, now, input.source?.conversationId ?? null, input.source?.taskId ?? null);
    return this.get(id)!;
  }

  // 振り返りの会話の材料を覚え直す（前の回から続きを書くとき）
  setSource(id: string, source: ReviewSource): void {
    this.db.prepare('UPDATE conversations SET source_conversation_id = ?, source_task_id = ? WHERE id = ?').run(source.conversationId ?? null, source.taskId ?? null, id);
  }

  get(id: string): ConversationRow | undefined {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
  }

  // チャットの会話の一覧（新しい順）。archived: true でアーカイブした会話。query は題の部分一致（大文字小文字を区別しない）
  list(limit = 100, options: { archived?: boolean; query?: string } = {}): ConversationListItem[] {
    const query = options.query?.trim();
    const like = query ? `%${query.replace(/[!%_]/gu, '!$&')}%` : null;
    const rows = this.db.prepare(`
      SELECT id, kind, title, archived, created_at, last_message_at, summary_upto, model_id, effort, permission_mode,
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

  // 無ければ空の会話を作る（最初の発言の前に、選んだモデルを覚えるため）。消したばかりの会話は作り直さず、false を返す（見送ったことを記録する）
  ensure(id: string): boolean {
    if (this.get(id)) return true;
    if (this.#isDeleted(id)) { this.#log?.(`[WARN] 消した会話 ${id} への書き込みを見送りました（会話を作り直しません）`); return false; }
    const now = this.now();
    this.db.prepare(`INSERT INTO conversations (id, kind, created_at, last_message_at) VALUES (?, 'chat', ?, ?)`).run(id, now, now);
    return true;
  }

  // 会話で選んだモデルと考える深さ・権限モード。渡さなかったものは変えない（モデルと考える深さの null は自動・モデルの既定に戻す）
  setChoice(id: string, choice: { modelId?: string | null | undefined; effort?: string | null | undefined; permissionMode?: PermissionMode | undefined }): void {
    if (!this.ensure(id)) return;
    if (choice.modelId !== undefined) this.db.prepare('UPDATE conversations SET model_id = ? WHERE id = ?').run(choice.modelId, id);
    if (choice.effort !== undefined) this.db.prepare('UPDATE conversations SET effort = ? WHERE id = ?').run(choice.effort, id);
    if (choice.permissionMode !== undefined) this.db.prepare('UPDATE conversations SET permission_mode = ? WHERE id = ?').run(choice.permissionMode, id);
  }

  // 会話に「外から読んだことがある」印を付ける（一度付いたら外れない）。自動承認の判定役に見せる文に「よそから来た文を読んだ会話」の 1 行を足す材料になる（判定役を止めはしない）
  markTainted(id: string): void {
    this.db.prepare('UPDATE conversations SET ever_tainted = 1 WHERE id = ?').run(id);
  }

  // 外から読んだことがある会話か。会話が読めないときは、ある側に倒す
  everTainted(id: string): boolean {
    const row = this.db.prepare('SELECT ever_tainted FROM conversations WHERE id = ?').get(id) as { ever_tainted: number } | undefined;
    return row === undefined || row.ever_tainted !== 0;
  }

  // 会話に「自動承認で許可フォルダの外を読んだことがある」印を付ける（一度付いたら外れない）。この会話のシェルのコマンドと通信の道具は、ずっと毎回確かめる
  markAutoRead(id: string): void {
    this.db.prepare('UPDATE conversations SET ever_auto_read = 1 WHERE id = ?').run(id);
  }

  // 自動承認で外を読んだことがある会話か。会話が読めないときは、ある側に倒す
  everAutoRead(id: string): boolean {
    const row = this.db.prepare('SELECT ever_auto_read FROM conversations WHERE id = ?').get(id) as { ever_auto_read: number } | undefined;
    return row === undefined || row.ever_auto_read !== 0;
  }

  // 会話の権限モード。無い会話はふつう
  modeOf(id: string): PermissionMode {
    return (this.db.prepare('SELECT permission_mode FROM conversations WHERE id = ?').get(id) as { permission_mode: PermissionMode } | undefined)?.permission_mode ?? 'normal';
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
      const text = messageText(message);
      // 消したばかりの会話への遅れた書き込みは、保存しない（id 0 を返す）
      if (!this.ensure(conversationId)) return { id: 0, conversation_id: conversationId, run_id: runId ?? null, role: message.role, text, message, created_at: now };
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
