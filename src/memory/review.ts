import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE, type Language } from '../config/schema.ts';
import type { StoredMessage } from '../db/conversations.ts';
import type { Task, TaskEvent } from '../tasks/store.ts';
import { estimateTextTokens } from '../engine/tokens.ts';
import { prefix, type Memory } from './store.ts';

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
  ja: { task: 'タスクが終わった', idle: '会話が途切れた', heavy_run: '道具を多く使った', book_full: '記憶が大きくなった', manual: '手動' },
  en: { task: 'A task finished', idle: 'The conversation went quiet', heavy_run: 'Many tools were used', book_full: 'Memory has grown large', manual: 'Manual' },
};

export const TRIGGER_LABEL = TRIGGER_TEXT.ja;

// 整理の振り返り（book_full）では、記憶を消さず・新しく覚えず、案を知らせる。この実行には渡さず、呼ばれても拒否する道具
export const TIDY_FORBIDDEN_TOOLS: readonly string[] = ['memory_forget', 'memory_save'];

// 整理の案の返事が「案なし」のとき（通知しない）
export const isNoProposal = (reply: string): boolean => /^(?:変更なし|No changes?)[。.!！]?$/iu.test(reply.trim());

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
  tidyPolicy: readonly string[];
  forgottenHeading: string;
  pressureHeading: string;
  pressureSummary: (tokens: number, budget: number, count: number) => string;
  pressureListHeading: string;
  pressureMore: (count: number) => string;
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
    tidyPolicy: [
      '- 今回の目的は、記憶を整理する案を出すこと。新しく覚えることはしない（memory_save は使えない）',
      '- 下に挙げた「会話に入りきらない記憶」のうち、重なりがはっきりしているものだけ、memory_update で 1 つにまとめてよい。memory_forget は使えない（消すかどうかはユーザーが決める）',
      '- 消したほうがよい・まとめたほうがよいと思う記憶は、最後の返事に 1 件 1 行で書く。書き方は「[n3] 消す: 理由（短く）」「[u1] [u4] まとめる: 理由（短く）」。多くても 10 行',
      '- 古くなったもの・ほかの記憶と重なるもの・一時的な出来事のものを優先して挙げる。ユーザーの大事な事実は挙げない',
      '- 提案が無ければ、道具を使わずに「変更なし」とだけ返す',
    ],
    forgottenHeading: '# ユーザーが消した記憶（同じ内容を覚え直さない）',
    pressureHeading: '# 記憶の量',
    pressureSummary: (tokens, budget, count) => `記憶の合計は約 ${tokens} トークンで、会話に入れる量の目安（約 ${budget} トークン）を超えています。会話に入りきらない記憶が ${count} 件あります。重なりをまとめる・古いものを減らす案を出す`,
    pressureListHeading: '会話に入りきらない記憶（古い順）:',
    pressureMore: count => `…（ほか ${count} 件）`,
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
    tidyPolicy: [
      '- The purpose this time is to propose how to tidy up memory. Do not learn anything new (memory_save is not available)',
      '- Of the memories listed below that do not fit in a conversation, you may merge only the clearly overlapping ones into one with memory_update. memory_forget is not available (the user decides what to delete)',
      '- Write the memories you think should be deleted or merged in your final reply, one per line, like "[n3] Delete: reason (short)" or "[u1] [u4] Merge: reason (short)". At most 10 lines',
      '- Prefer outdated memories, ones that overlap with others, and ones about temporary events. Do not list important facts about the user',
      '- If there is nothing to propose, use no tools and reply only "No changes"',
    ],
    forgottenHeading: '# Memories the user deleted (do not learn the same thing again)',
    pressureHeading: '# Memory usage',
    pressureSummary: (tokens, budget, count) => `Memory totals about ${tokens} tokens, over the guideline for what goes into a conversation (about ${budget} tokens). ${count} ${count === 1 ? 'memory does' : 'memories do'} not fit in a conversation. Propose merging overlapping memories and trimming old ones`,
    pressureListHeading: 'Memories that do not fit (oldest first):',
    pressureMore: count => `… (${count} more)`,
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

// 記憶が会話に入りきらないときの、振り返りへの知らせ。入りきらない記憶を古い順に挙げる（挙げる量も、会話に入れる量と同じ予算まで。最初の 1 件は必ず挙げる）。
export function bookPressureText(input: { tokens: number; budget: number; outside: readonly Pick<Memory, 'id' | 'book' | 'content'>[] }, language: Language = DEFAULT_LANGUAGE): string {
  const text = REVIEW_TEXT[language];
  const lines: string[] = [];
  let used = 0;
  for (const m of input.outside) {
    const line = `- [${prefix(m.book)}${m.id}] ${clip(m.content, 600, language)}`;
    const cost = estimateTextTokens(line) + 1;
    if (lines.length > 0 && used + cost > input.budget) break;
    used += cost;
    lines.push(line);
  }
  const rest = input.outside.length - lines.length;
  return [
    text.pressureSummary(input.tokens, input.budget, input.outside.length),
    text.pressureListHeading,
    ...lines,
    ...(rest > 0 ? [text.pressureMore(rest)] : []),
  ].join('\n');
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
    ...(input.trigger === 'book_full' ? text.tidyPolicy : text.policy),
  ];
  if (input.forgotten.length) {
    parts.push('', text.forgottenHeading, ...input.forgotten.map(f => `- ${clip(f, 200, language)}`));
  }
  if (input.bookPressure) parts.push('', `${text.pressureHeading}\n${input.bookPressure}`);
  if (input.task) {
    parts.push('', text.taskHeading, `${text.taskTitle}: ${input.task.title}`, `${text.taskResult}: ${input.task.status}${input.task.result_summary ? ` — ${clip(input.task.result_summary, 2000, language)}` : ''}`);
    if (input.task.body) parts.push(`${text.taskNotes}:\n${clip(input.task.body, 3000, language)}`);
    if (input.taskEvents?.length) parts.push(`${text.taskEvents}:`, ...input.taskEvents.slice(0, 15).filter(e => e.content).map(e => `- ${e.kind}: ${clip(e.content ?? '', 300, language)}`));
  }
  if (input.transcript) parts.push('', text.transcriptHeading, input.transcript);
  return parts.join('\n');
}
