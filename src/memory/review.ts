import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE, type Language } from '../config/schema.ts';
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

export const TRIGGER_TEXT: Record<Language, Record<ReviewTrigger, string>> = {
  ja: { task: 'タスクが終わった', idle: '会話が途切れた', heavy_run: '道具を多く使った', book_full: '記憶が上限に近い', manual: '手動' },
  en: { task: 'A task finished', idle: 'The conversation went quiet', heavy_run: 'Many tools were used', book_full: 'Memory is nearly full', manual: 'Manual' },
};

export const TRIGGER_LABEL = TRIGGER_TEXT.ja;

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

interface ReviewText {
  intro: (trigger: string) => string;
  policyHeading: string;
  policy: readonly string[];
  forgottenHeading: string;
  pressureHeading: string;
  pressureTail: string;
  taskHeading: string;
  taskTitle: string;
  taskResult: string;
  taskNotes: string;
  taskEvents: string;
  transcriptHeading: string;
  truncated: string;
  user: string;
  tool: (name: string) => string;
  line: (label: string, body: string) => string;
  bookUser: string;
  bookNotes: string;
  chars: string;
  separator: string;
}

const REVIEW_TEXT: Record<Language, ReviewText> = {
  ja: {
    intro: trigger => `[振り返り] きっかけ: ${trigger}。下の記録を読んで、記憶を整える（ユーザーとの会話ではありません。返事は記録に残るだけです）。`,
    policyHeading: '# 方針',
    policy: [
      '- 残すのは「次に役立つ教訓と事実」。出来事のログは残さない',
      '- 既に記憶にあることは足さない。重なっている記憶は memory_update で1つにまとめ、要らなくなった方は memory_forget',
      '- 矛盾したら新しい方を残す',
      '- 拾い漏れたユーザーについての事実（好み・予定・関係・環境）は memory_save（book=user）。自分の教訓は book=notes',
      '- 1つの記録から足すのは多くても3件',
      '- 繰り返し使えそうな手順が見つかったら skill_draft（ユーザーが承認するまで使われない）。新しく作るより、既存のスキルを直すほうを優先する',
      '- 気になったが調べていないことがあれば curiosity_add',
      '- することがなければ、道具を使わずに「変更なし」とだけ返す',
      '- 最後に、何をしたかを1〜2文で返す',
    ],
    forgottenHeading: '# ユーザーが消した記憶（同じ内容を覚え直さない）',
    pressureHeading: '# 記憶の量',
    pressureTail: '。重なりをまとめて減らすことを優先する',
    taskHeading: '# 終わったタスク',
    taskTitle: 'タイトル',
    taskResult: '結果',
    taskNotes: 'メモ',
    taskEvents: '経過',
    transcriptHeading: '# 会話の記録',
    truncated: '…（略）',
    user: 'ユーザー',
    tool: name => `道具 ${name}`,
    line: (label, body) => `【${label}】${body}`,
    bookUser: 'ユーザーについて',
    bookNotes: 'メモと教訓',
    chars: '文字',
    separator: '、',
  },
  en: {
    intro: trigger => `[Review] Trigger: ${trigger}. Read the record below and tidy up your memory (this is not a conversation with the user; your reply is only saved to the record).`,
    policyHeading: '# Policy',
    policy: [
      '- Keep only "lessons and facts that will help next time". Do not keep a log of events',
      '- Do not add what is already in memory. Merge overlapping memories into one with memory_update, and drop the one you no longer need with memory_forget',
      '- If two memories contradict, keep the newer one',
      '- Facts about the user that were missed (preferences, plans, relationships, environment): memory_save (book=user). Your own lessons: book=notes',
      '- Add at most 3 items from a single record',
      '- If you find a procedure that looks reusable, use skill_draft (it is not used until the user approves it). Prefer fixing an existing skill over creating a new one',
      '- If something caught your interest but you have not looked into it, use curiosity_add',
      '- If there is nothing to do, use no tools and reply only "No changes"',
      '- At the end, report what you did in one or two sentences',
    ],
    forgottenHeading: '# Memories the user deleted (do not learn the same thing again)',
    pressureHeading: '# Memory usage',
    pressureTail: '. Prioritize merging overlapping memories to reduce it',
    taskHeading: '# Finished task',
    taskTitle: 'Title',
    taskResult: 'Result',
    taskNotes: 'Notes',
    taskEvents: 'History',
    transcriptHeading: '# Record of the conversation',
    truncated: '… (truncated)',
    user: 'User',
    tool: name => `Tool ${name}`,
    line: (label, body) => `[${label}] ${body}`,
    bookUser: 'About the user',
    bookNotes: 'Notes and lessons',
    chars: 'characters',
    separator: ', ',
  },
};

const clip = (text: string, max: number, language: Language = DEFAULT_LANGUAGE) => (text.length > max ? `${text.slice(0, max)}${REVIEW_TEXT[language].truncated}` : text);

export function transcriptOf(messages: readonly StoredMessage[], maxChars = 15_000, language: Language = DEFAULT_LANGUAGE): string {
  const text = REVIEW_TEXT[language];
  const lines: string[] = [];
  for (const m of messages) {
    const label = m.role === 'user' ? text.user : m.role === 'assistant' ? 'Clive' : text.tool(m.message.role === 'tool' ? m.message.name : '');
    const body = m.role === 'tool' ? clip(m.text, 300, language) : clip(m.text, 3000, language);
    if (body.trim()) lines.push(text.line(label, body));
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

export function bookPressureText(usage: Record<string, { used: number; max: number }>, language: Language = DEFAULT_LANGUAGE): string {
  const text = REVIEW_TEXT[language];
  return Object.entries(usage).map(([book, u]) => `${book === 'user' ? text.bookUser : text.bookNotes}: ${u.used}/${u.max} ${text.chars}`).join(text.separator);
}

export function reviewPrompt(input: {
  trigger: ReviewTrigger;
  transcript?: string;
  task?: Pick<Task, 'title' | 'status' | 'result_summary' | 'body'> | undefined;
  taskEvents?: readonly Pick<TaskEvent, 'kind' | 'content'>[];
  forgotten: readonly string[];
  bookPressure?: string | undefined;
  language?: Language | undefined;
}): string {
  const language = input.language ?? DEFAULT_LANGUAGE;
  const text = REVIEW_TEXT[language];
  const parts = [
    text.intro(TRIGGER_TEXT[language][input.trigger]),
    '',
    text.policyHeading,
    ...text.policy,
  ];
  if (input.forgotten.length) {
    parts.push('', text.forgottenHeading, ...input.forgotten.map(f => `- ${clip(f, 200, language)}`));
  }
  if (input.bookPressure) parts.push('', `${text.pressureHeading}\n${input.bookPressure}${text.pressureTail}`);
  if (input.task) {
    parts.push('', text.taskHeading, `${text.taskTitle}: ${input.task.title}`, `${text.taskResult}: ${input.task.status}${input.task.result_summary ? ` — ${clip(input.task.result_summary, 2000, language)}` : ''}`);
    if (input.task.body) parts.push(`${text.taskNotes}:\n${clip(input.task.body, 3000, language)}`);
    if (input.taskEvents?.length) parts.push(`${text.taskEvents}:`, ...input.taskEvents.slice(0, 15).filter(e => e.content).map(e => `- ${e.kind}: ${clip(e.content ?? '', 300, language)}`));
  }
  if (input.transcript) parts.push('', text.transcriptHeading, input.transcript);
  return parts.join('\n');
}
