import type { DatabaseSync } from 'node:sqlite';
import type { StoredMessage } from '../db/conversations.ts';
import type { Task, TaskEvent } from '../tasks/store.ts';

export type ReviewTrigger = 'task' | 'idle' | 'heavy_run' | 'book_full' | 'manual';

export interface ReviewJob {
  id: number;
  trigger: ReviewTrigger;
  dedup_key: string;
  conversation_id: string | null;
  task_id: string | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  run_id: string | null;
  review_conversation_id: string | null;
  note: string | null;
  created_at: number;
  finished_at: number | null;
}

export const TRIGGER_LABEL: Record<ReviewTrigger, string> = {
  task: 'タスクが終わった', idle: '会話が途切れた', heavy_run: '道具を多く使った', book_full: '記憶が上限に近い', manual: '手動',
};

export class ReviewJobs {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  constructor(db: DatabaseSync, now: () => number = Date.now) { this.#db = db; this.#now = now; }

  enqueue(trigger: ReviewTrigger, dedupKey: string, refs: { conversationId?: string | null | undefined; taskId?: string | null | undefined } = {}): ReviewJob | undefined {
    const result = this.#db.prepare('INSERT OR IGNORE INTO memory_jobs (trigger, dedup_key, conversation_id, task_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(trigger, dedupKey, refs.conversationId ?? null, refs.taskId ?? null, this.#now());
    return Number(result.changes) === 1 ? this.get(Number(result.lastInsertRowid)) : undefined;
  }

  get(id: number): ReviewJob | undefined {
    return this.#db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(id) as ReviewJob | undefined;
  }

  next(): ReviewJob | undefined {
    return this.#db.prepare("SELECT * FROM memory_jobs WHERE status = 'pending' ORDER BY id LIMIT 1").get() as ReviewJob | undefined;
  }

  pendingCount(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE status = 'pending'").get() as { n: number }).n;
  }

  claim(id: number, runId: string, reviewConversationId: string): void {
    this.#db.prepare("UPDATE memory_jobs SET status = 'running', run_id = ?, review_conversation_id = ? WHERE id = ?").run(runId, reviewConversationId, id);
  }

  finish(id: number, status: 'done' | 'failed', note: string | null): void {
    this.#db.prepare('UPDATE memory_jobs SET status = ?, note = ?, finished_at = ? WHERE id = ?').run(status, note, this.#now(), id);
  }

  requeue(id: number): void {
    this.#db.prepare("UPDATE memory_jobs SET status = 'pending', run_id = NULL WHERE id = ?").run(id);
  }

  recoverRunning(): number {
    return Number(this.#db.prepare("UPDATE memory_jobs SET status = 'pending', run_id = NULL WHERE status = 'running'").run().changes);
  }

  list(limit = 50): ReviewJob[] {
    return this.#db.prepare('SELECT * FROM memory_jobs ORDER BY id DESC LIMIT ?').all(limit) as unknown as ReviewJob[];
  }

  enqueueIdleConversations(idleMs: number, since: number): number {
    const now = this.#now();
    const rows = this.#db.prepare(`SELECT c.id AS id, (SELECT MAX(m.id) FROM messages m WHERE m.conversation_id = c.id) AS last
      FROM conversations c WHERE c.kind = 'chat' AND c.archived = 0 AND c.last_message_at < ? AND c.last_message_at >= ?`).all(now - idleMs, since) as Array<{ id: string; last: number | null }>;
    let added = 0;
    for (const row of rows) {
      if (!row.last) continue;
      if (this.enqueue('idle', `idle:${row.id}:${row.last}`, { conversationId: row.id })) added++;
    }
    return added;
  }
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…（略）` : text);

export function transcriptOf(messages: readonly StoredMessage[], maxChars = 15_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    const label = m.role === 'user' ? 'ユーザー' : m.role === 'assistant' ? 'Clive' : `道具 ${m.message.role === 'tool' ? m.message.name : ''}`;
    const text = m.role === 'tool' ? clip(m.text, 300) : clip(m.text, 3000);
    if (text.trim()) lines.push(`【${label}】${text}`);
  }
  // 新しい方を優先して残す
  const kept: string[] = [];
  let total = 0;
  for (const line of lines.reverse()) {
    if (total + line.length > maxChars) break;
    kept.unshift(line);
    total += line.length;
  }
  return kept.join('\n');
}

export function reviewPrompt(input: {
  trigger: ReviewTrigger;
  transcript?: string;
  task?: Pick<Task, 'title' | 'status' | 'result_summary' | 'body'> | undefined;
  taskEvents?: readonly Pick<TaskEvent, 'kind' | 'content'>[];
  forgotten: readonly string[];
  bookPressure?: string | undefined;
}): string {
  const parts = [
    `[振り返り] きっかけ: ${TRIGGER_LABEL[input.trigger]}。下の記録を読んで、記憶を整える（ユーザーとの会話ではありません。返事は記録に残るだけです）。`,
    '',
    '# 方針',
    '- 残すのは「次に役立つ教訓と事実」。出来事のログは残さない',
    '- 既に記憶にあることは足さない。重なっている記憶は memory_update で1つにまとめ、要らなくなった方は memory_forget',
    '- 矛盾したら新しい方を残す',
    '- 拾い漏れたユーザーについての事実（好み・予定・関係・環境）は memory_save（book=user）。自分の教訓は book=notes',
    '- 1つの記録から足すのは多くても3件',
    '- 繰り返し使えそうな手順が見つかったら skill_draft（ユーザーが承認するまで使われない）。新しく作るより、既存のスキルを直すほうを優先する',
    '- 気になったが調べていないことがあれば curiosity_add',
    '- することがなければ、道具を使わずに「変更なし」とだけ返す',
    '- 最後に、何をしたかを1〜2文で返す',
  ];
  if (input.forgotten.length) {
    parts.push('', '# ユーザーが消した記憶（同じ内容を覚え直さない）', ...input.forgotten.map(f => `- ${clip(f, 200)}`));
  }
  if (input.bookPressure) parts.push('', `# 記憶の量\n${input.bookPressure}。重なりをまとめて減らすことを優先する`);
  if (input.task) {
    parts.push('', '# 終わったタスク', `タイトル: ${input.task.title}`, `結果: ${input.task.status}${input.task.result_summary ? ` — ${clip(input.task.result_summary, 2000)}` : ''}`);
    if (input.task.body) parts.push(`メモ:\n${clip(input.task.body, 3000)}`);
    if (input.taskEvents?.length) parts.push('経過:', ...input.taskEvents.slice(0, 15).filter(e => e.content).map(e => `- ${e.kind}: ${clip(e.content ?? '', 300)}`));
  }
  if (input.transcript) parts.push('', '# 会話の記録', input.transcript);
  return parts.join('\n');
}
