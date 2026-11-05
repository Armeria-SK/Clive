import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE, type AppConfig, type Language } from '../config/schema.ts';
import type { Conversations } from '../db/conversations.ts';
import type { KV } from '../db/kv.ts';
import type { ChatEngine } from '../engine/chat.ts';
import type { EngineResult } from '../engine/types.ts';
import type { CuriosityStore } from '../curiosity/store.ts';
import { curiosityText } from '../curiosity/text.ts';
import { bookPressureText, reviewPrompt, transcriptOf, TRIGGER_LABEL, type ReviewJob, type ReviewJobs } from '../memory/review.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { Notifications } from '../notify/notifications.ts';
import { languageOf } from '../shared/language.ts';
import type { TaskControl } from '../tools/types.ts';
import type { Task, TaskStore } from './store.ts';

const IDLE_POLL_MS = 5 * 60_000;
const LEASE_MS = 30 * 60_000;
const RETRY_DELAYS_MIN = [1, 5, 15];
const STAGNATION_LIMIT = 3;
const STOPPED_RESUME_MS = 20_000;

export type TickResult = 'ran' | 'idle' | 'busy' | 'paused' | 'disabled' | 'budget' | 'no_model';

export interface WorkerDeps {
  db: DatabaseSync;
  tasks: TaskStore;
  engine: ChatEngine;
  conversations: Conversations;
  notifications: Notifications;
  kv: KV;
  config: () => AppConfig;
  log: (line: string) => void;
  now?: () => number;
  autoSchedule?: boolean;
  reviews?: ReviewJobs | undefined;
  memory?: MemoryStore | undefined;
  curiosity?: CuriosityStore | undefined;
}

export interface WorkerRunning { kind: 'task' | 'review'; taskId: string | null; runId: string; title: string }

interface TaskText {
  intro: string;
  heading: string;
  id: string;
  title: string;
  origin: string;
  originLabel: Record<Task['origin'], string>;
  details: string;
  nextAction: string;
  doneCriteria: string;
  historyHeading: string;
  howHeading: string;
  how: readonly string[];
  time: (ms: number, timezone: string) => string;
}

const TASK_TEXT: Record<Language, TaskText> = {
  ja: {
    intro: '[タスクの実行] あなたは今、自分のメモ帳のタスクを進めています（ユーザーとの会話ではありません。返事は記録に残ります）。',
    heading: '# タスク',
    id: 'ID',
    title: 'タイトル',
    origin: '出どころ',
    originLabel: { user: 'ユーザーの依頼', self: '自分で決めたこと', curiosity: '好奇心から', schedule: '予定' },
    details: '詳細',
    nextAction: '次の一手',
    doneCriteria: '完了の条件',
    historyHeading: '# これまでの経過（新しい順）',
    howHeading: '# 進め方',
    how: [
      '- 道具を使って進める。1回の実行でやりすぎない',
      '- 終わったら task_complete（結果の要約）。ユーザーに知らせることが無ければ notify=false で静かに終える',
      '- 続きを後でやる・何かを待つなら task_checkpoint（試したこと・結果・次の一手・何分後に再開するか）',
      '- ユーザーに確かめないと進められないことだけ ask_user で尋ねる',
    ],
    time: (ms, timezone) => new Date(ms).toLocaleString('ja-JP', { timeZone: timezone }),
  },
  en: {
    intro: '[Task run] You are now working on a task from your own notepad (this is not a conversation with the user; your reply is saved to the record).',
    heading: '# Task',
    id: 'ID',
    title: 'Title',
    origin: 'Where it came from',
    originLabel: { user: "The user's request", self: 'Something you decided yourself', curiosity: 'From your curiosity', schedule: 'Scheduled' },
    details: 'Details',
    nextAction: 'Next step',
    doneCriteria: 'Done when',
    historyHeading: '# History so far (newest first)',
    howHeading: '# How to proceed',
    how: [
      '- Make progress with your tools. Do not overdo it in a single run',
      '- When you are done, call task_complete (a summary of the result). If there is nothing to tell the user, finish quietly with notify=false',
      '- To continue later or to wait for something, call task_checkpoint (what you tried, the result, the next step, and how many minutes until you resume)',
      '- Use ask_user only for what you cannot move forward on without checking with the user',
    ],
    time: (ms, timezone) => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium', timeZone: timezone }).format(ms),
  },
};

export function inQuietHours(now: number, timezone: string, start: string, end: string): boolean {
  if (!start || !end || start === end) return false;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now));
  return start < end ? hm >= start && hm < end : hm >= start || hm < end;
}

export function taskPrompt(task: Task, events: ReadonlyArray<{ kind: string; content: string | null; created_at: number }>, timezone: string, language: Language = DEFAULT_LANGUAGE): string {
  const text = TASK_TEXT[language];
  const history = events.slice(0, 10).filter(e => e.content).map(e => `- ${text.time(e.created_at, timezone)} ${e.kind}: ${e.content}`);
  return [
    text.intro,
    '',
    text.heading,
    `${text.id}: ${task.id.slice(0, 8)}`,
    `${text.title}: ${task.title}`,
    `${text.origin}: ${text.originLabel[task.origin]}`,
    task.body && `${text.details}:\n${task.body}`,
    task.next_action && `${text.nextAction}: ${task.next_action}`,
    task.done_criteria && `${text.doneCriteria}: ${task.done_criteria}`,
    history.length ? `\n${text.historyHeading}\n${history.join('\n')}` : '',
    '',
    text.howHeading,
    ...text.how,
  ].filter((line): line is string => typeof line === 'string').join('\n').replace(/\n{3,}/gu, '\n\n');
}

export class Worker {
  readonly #d: WorkerDeps;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #nextWakeAt: number | undefined;
  #running: WorkerRunning | undefined;
  #forced = new Set<string>();
  #ticking = false;
  #stopped = true;

  constructor(deps: WorkerDeps) { this.#d = deps; }

  #now(): number { return this.#d.now?.() ?? Date.now(); }

  get paused(): boolean { return this.#d.kv.get('worker:paused') === '1'; }

  setPaused(paused: boolean): void {
    this.#d.kv.set('worker:paused', paused ? '1' : '0');
    this.#d.log(`[INFO] ワーカーを${paused ? '一時停止' : '再開'}しました`);
    this.poke();
  }

  start(): void {
    this.#stopped = false;
    const recovered = this.#d.tasks.recoverExpiredLeases({ all: true });
    if (recovered) this.#d.log(`[INFO] 途中で止まっていたタスク ${recovered} 件を実行待ちに戻しました`);
    const reviews = this.#d.reviews?.recoverRunning() ?? 0;
    if (reviews) this.#d.log(`[INFO] 途中で止まっていた振り返り ${reviews} 件を積み直しました`);
    this.poke();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  requestRun(taskId: string): void {
    this.#forced.add(taskId);
    this.poke();
  }

  stopTask(taskId: string): boolean {
    return this.#running?.kind === 'task' && this.#running.taskId === taskId ? this.#d.engine.stop(this.#running.runId) : false;
  }

  poke(): void {
    if (this.#stopped || this.#d.autoSchedule === false) return;
    this.#schedule(0);
  }

  #schedule(delayMs: number): void {
    clearTimeout(this.#timer);
    this.#nextWakeAt = this.#now() + delayMs;
    this.#timer = setTimeout(() => {
      this.tick().catch(error => {
        this.#d.log(`[ERROR] ワーカー: ${(error as Error).stack ?? error}`);
        if (!this.#stopped) this.#schedule(IDLE_POLL_MS);
      });
    }, Math.max(0, delayMs));
    this.#timer.unref?.();
  }

  runsLastHour(): number {
    // タスクと振り返り（どちらも裏で動く実行）を数える。会話は数えない
    return (this.#d.db.prepare("SELECT COUNT(*) AS n FROM engine_runs WHERE kind IN ('task', 'review') AND started_at > ?").get(this.#now() - 3_600_000) as { n: number }).n;
  }

  quiet(): boolean {
    const c = this.#d.config();
    return inQuietHours(this.#now(), c.timezone, c.worker.quietStart, c.worker.quietEnd);
  }

  status() {
    const c = this.#d.config();
    return {
      enabled: c.worker.enabled, autonomy: c.worker.autonomy, paused: this.paused, quiet: this.quiet(),
      running: this.#running ?? null, nextWakeAt: this.#nextWakeAt ?? null,
      runsLastHour: this.runsLastHour(), maxRunsPerHour: c.worker.maxRunsPerHour,
    };
  }

  async tick(): Promise<TickResult> {
    if (this.#ticking || this.#running) return 'busy';
    this.#ticking = true;
    try {
      const c = this.#d.config();
      const now = this.#now();
      const { tasks } = this.#d;
      const reschedule = (at?: number) => {
        if (this.#stopped || this.#d.autoSchedule === false) return;
        this.#schedule(Math.max(1000, Math.min(at ?? Infinity, now + IDLE_POLL_MS) - now));
      };
      if (!c.worker.enabled) { reschedule(); return 'disabled'; }

      // 予定から実行用のタスクを作る・返事待ちを知らせ直す（どちらもモデルは呼ばない）
      tasks.spawnDueSchedules();
      const remindMs = c.worker.remindAfterHours * 3_600_000;
      for (const t of tasks.waitingSince(remindMs)) {
        this.#d.notifications.notify({ kind: 'task_waiting', title: `返事を待っています: ${t.title}`, body: t.waiting_text ?? undefined, link: `#/tasks/${t.id}`, dedupKey: `remind:${t.id}:${Math.floor(now / remindMs)}` });
      }
      this.#detectReviewTriggers(c, now);
      if (this.paused) { reschedule(); return 'paused'; }
      // ユーザーとの会話の返事を作っている間は始めない（終われば onRunEnd で起こされる）
      if (this.#d.engine.chatting) { reschedule(now + 60_000); return 'busy'; }
      // 「今すぐ実行」を頼まれたものは、1時間の上限より先に実行する（上限は、ひとりでに動く分の費用を抑えるためのもの）
      let task: Task | undefined;
      for (const id of [...this.#forced]) {
        this.#forced.delete(id);
        const forced = tasks.get(id);
        if (forced?.status === 'ready' && forced.attempts < forced.max_attempts) { task = forced; break; }
      }
      if (!task && this.runsLastHour() >= c.worker.maxRunsPerHour) {
        const idleSelf = c.worker.autonomy && !this.quiet() && now - this.#d.engine.lastUserActivity >= c.worker.idleMinutes * 60_000;
        if (tasks.pickNext({ allowSelf: idleSelf })) {
          this.#d.notifications.notify({
            kind: 'info', title: '1時間の実行の上限に達したので、タスクを少し待たせています',
            body: `上限は 1 時間に ${c.worker.maxRunsPerHour} 回です（設定の worker.maxRunsPerHour）。急ぐタスクは「今すぐ実行」で動かせます`,
            link: '#/tasks', dedupKey: `budget:${Math.floor(now / 3_600_000)}`,
          });
        }
        reschedule(now + 10 * 60_000);
        return 'budget';
      }

      const idleEnough = now - this.#d.engine.lastUserActivity >= c.worker.idleMinutes * 60_000;
      const allowSelf = c.worker.autonomy && !this.quiet() && idleEnough;
      task ??= tasks.pickNext({ allowSelf });
      // 実行するタスクが無ければ、振り返り → 好奇心の順に見る
      const job = !task && c.memory.review ? this.#d.reviews?.next() : undefined;
      if (job) {
        const outcome = await this.#review(job);
        reschedule(now);
        return outcome;
      }
      if (!task && allowSelf) task = this.#spawnCuriosity(c, now);
      if (!task) { reschedule(tasks.nextWakeAt({ allowSelf })); return 'idle'; }
      const outcome = await this.#run(task);
      reschedule(now);
      return outcome;
    } finally { this.#ticking = false; }
  }

  #detectReviewTriggers(c: AppConfig, now: number): void {
    const { reviews, memory, kv } = this.#d;
    if (!reviews || !c.memory.review) return;
    // 機能を入れる前の古い会話を一度に振り返らないよう、最初に動いた時刻より後の会話だけを見る
    let since = Number(kv.get('review:since'));
    if (!Number.isFinite(since) || since <= 0) { since = now; kv.set('review:since', String(now)); }
    reviews.enqueueIdleConversations(c.memory.reviewIdleMinutes * 60_000, since);
    if (memory) {
      const day = Math.floor(now / 86_400_000);
      for (const [book, u] of Object.entries(memory.usage())) {
        if (u.max > 0 && u.used / u.max >= 0.9) reviews.enqueue('book_full', `book:${book}:${day}`);
      }
    }
  }

  #reviewInput(job: ReviewJob): string | undefined {
    const { db, conversations, tasks, memory, kv } = this.#d;
    const language = languageOf(this.#d.config());
    const forgotten = (db.prepare("SELECT before FROM memory_events WHERE action = 'forget' AND actor = 'user' AND before IS NOT NULL ORDER BY id DESC LIMIT 20").all() as Array<{ before: string }>).map(r => r.before);
    if (job.trigger === 'book_full') {
      const usage = memory?.usage();
      const pressure = usage ? bookPressureText(usage, language) : undefined;
      return reviewPrompt({ trigger: job.trigger, forgotten, bookPressure: pressure, language });
    }
    if (job.trigger === 'task') {
      const task = job.task_id ? tasks.get(job.task_id) : undefined;
      if (!task) return undefined;
      return reviewPrompt({ trigger: job.trigger, task, taskEvents: tasks.events(task.id, 30), forgotten, language });
    }
    if (!job.conversation_id) return undefined;
    // 前回振り返った発言より後だけを渡す（同じ発言を二度振り返らない）
    const upto = Number(kv.get(`review:upto:${job.conversation_id}`) ?? 0);
    const messages = conversations.messages(job.conversation_id, 200).filter(m => m.id > upto);
    if (!messages.some(m => m.role === 'user')) return undefined;
    return reviewPrompt({ trigger: job.trigger, transcript: transcriptOf(messages, undefined, language), forgotten, language });
  }

  async #review(job: ReviewJob): Promise<TickResult> {
    const { reviews, conversations, engine, kv } = this.#d;
    if (!reviews) return 'idle';
    const prompt = this.#reviewInput(job);
    if (!prompt) { reviews.finish(job.id, 'done', '振り返る記録がありませんでした'); return 'idle'; }
    const lastMessageId = job.conversation_id ? conversations.messages(job.conversation_id, 1).at(-1)?.id : undefined;
    const conversation = conversations.create({ kind: 'task', title: `振り返り: ${TRIGGER_LABEL[job.trigger]}` });
    const started = engine.runReview(conversation.id, prompt);
    if (!started.ok) {
      this.#d.notifications.notify({ kind: 'health_alert', title: '振り返りに使えるモデルがありません', body: started.errorMessage, link: '#/settings', dedupKey: 'no-model-for-review' });
      return 'no_model';
    }
    reviews.claim(job.id, started.runId, conversation.id);
    this.#running = { kind: 'review', taskId: job.task_id, runId: started.runId, title: `振り返り（${TRIGGER_LABEL[job.trigger]}）` };
    try {
      const result = await started.done;
      if (engine.wasPreempted(started.runId)) { reviews.requeue(job.id); return 'ran'; }
      if (result.ok) {
        reviews.finish(job.id, 'done', result.text.trim().slice(0, 1000) || '（返事なし）');
        if (job.conversation_id && lastMessageId) kv.set(`review:upto:${job.conversation_id}`, String(lastMessageId));
      } else {
        // 振り返りは再試行しない（失敗が続いて費用が膨らむのを防ぐ）。次のきっかけでまた積まれる
        reviews.finish(job.id, 'failed', result.errorMessage);
      }
    } finally { this.#running = undefined; }
    return 'ran';
  }

  #spawnCuriosity(c: AppConfig, now: number): Task | undefined {
    const { curiosity, tasks } = this.#d;
    if (!curiosity || c.worker.curiosityPerDay <= 0) return undefined;
    if (tasks.createdSince('curiosity', now - 86_400_000) >= c.worker.curiosityPerDay) return undefined;
    const item = curiosity.nextOpen();
    if (!item) return undefined;
    const text = curiosityText(languageOf(c));
    const task = tasks.create({
      title: text.title(item.topic).slice(0, 200),
      body: [item.why && text.why(item.why), text.summarize].filter(Boolean).join('\n'),
      doneCriteria: text.doneCriteriaQuiet,
      origin: 'curiosity', priority: 3, curiosityId: item.id, propose: c.worker.selfTasksNeedApproval, actor: 'worker',
    });
    curiosity.update(item.id, { status: 'researching', taskId: task.id });
    return task.status === 'ready' ? task : undefined;
  }

  async #run(task: Task): Promise<TickResult> {
    const { tasks, conversations, engine } = this.#d;
    const c = this.#d.config();
    const conversationId = task.conversation_id ?? conversations.create({ kind: 'task', title: `タスク: ${task.title}` }).id;
    if (!tasks.claim(task.id, LEASE_MS, conversationId)) return 'busy';
    const prompt = taskPrompt(task, tasks.events(task.id), c.timezone, languageOf(c));
    const started = engine.runTask(task, conversationId, prompt);
    if (!started.ok) {
      tasks.setReady(task.id, { runAt: this.#now() + 10 * 60_000, reason: `使えるモデルが無いため待ちます: ${started.errorMessage.split('\n')[0]}` });
      this.#d.notifications.notify({ kind: 'health_alert', title: 'タスクを実行できるモデルがありません', body: started.errorMessage, link: '#/settings', dedupKey: 'no-model-for-tasks' });
      return 'no_model';
    }
    this.#running = { kind: 'task', taskId: task.id, runId: started.runId, title: task.title };
    tasks.event(task.id, 'run', 'worker', null, started.runId);
    try {
      const result = await started.done;
      this.#finalize(task, result, started.control.value, started.runId);
    } finally { this.#running = undefined; }
    return 'ran';
  }

  #finalize(task: Task, result: EngineResult, control: TaskControl, runId: string): void {
    const { tasks, notifications } = this.#d;
    const now = this.#now();
    const link = `#/tasks/${task.id}`;
    const idleKey = `task-idle:${task.id}`;
    // 実行中に、ユーザーが取り消した・完了にした（またはモデルが道具で終えた）なら、その状態を尊重する
    if (tasks.get(task.id)?.status !== 'running') return;
    if (this.#d.engine.wasPreempted(runId)) {
      tasks.setReady(task.id, { runAt: now + 2 * 60_000, reason: 'ユーザーとの会話を優先するため中断しました（続きから再開します）' });
      return;
    }
    if (control.outcome === 'complete') {
      this.#d.kv.delete(idleKey);
      tasks.finish(task.id, 'done', control.summary, 'clive', runId);
      if (control.notify) notifications.notify({ kind: 'task_done', title: `タスク完了: ${task.title}`, body: control.summary, link });
      return;
    }
    if (control.outcome === 'question') {
      tasks.setWaiting(task.id, 'question', control.question, runId);
      notifications.notify({ kind: 'task_waiting', title: `質問があります: ${task.title}`, body: control.question, link, dedupKey: `waiting:${task.id}:${now}` });
      return;
    }
    if (control.outcome === 'checkpoint') {
      this.#d.kv.delete(idleKey);
      tasks.update(task.id, { appendNote: control.note, nextAction: control.nextAction }, 'clive', runId);
      tasks.setReady(task.id, { runAt: now + Math.min(Math.max(control.resumeAfterMinutes, 1), 10_080) * 60_000, reason: `${control.resumeAfterMinutes} 分後に再開します` });
      return;
    }
    if (result.ok) {
      // 道具で終わり方を決めずに返事だけ書いた: 進展が無いとみなし、休む時間を延ばす。続いたら相談する
      const strikes = (this.#d.kv.getJson<number>(idleKey) ?? 0) + 1;
      this.#d.kv.setJson(idleKey, strikes);
      if (result.text.trim()) tasks.update(task.id, { appendNote: `メモ: ${result.text.trim().slice(0, 500)}` }, 'clive', runId);
      if (strikes >= STAGNATION_LIMIT) {
        this.#d.kv.delete(idleKey);
        const question = `「${task.title}」を ${strikes} 回進めようとしましたが、進め方が決まりません。どうするか教えてください（やめてよければ取り消してください）`;
        tasks.setWaiting(task.id, 'question', question, runId);
        notifications.notify({ kind: 'task_waiting', title: `相談があります: ${task.title}`, body: question, link, dedupKey: `stuck:${task.id}` });
      } else {
        tasks.setReady(task.id, { runAt: now + 15 * 60_000 * 2 ** (strikes - 1), reason: '進展が無かったので、少し休んでから再開します' });
      }
      return;
    }
    if (result.errorKind === 'cancelled') {
      tasks.setReady(task.id, { runAt: now + STOPPED_RESUME_MS, reason: '止められたので、少し休んでから再開します' });
      return;
    }
    const attempts = task.attempts + 1;
    if (attempts >= task.max_attempts) {
      tasks.finish(task.id, 'failed', result.errorMessage, 'worker', runId);
      notifications.notify({ kind: 'task_failed', title: `タスク失敗: ${task.title}`, body: result.errorMessage, link, dedupKey: `failed:${task.id}` });
      return;
    }
    const delay = RETRY_DELAYS_MIN[Math.min(attempts - 1, RETRY_DELAYS_MIN.length - 1)]!;
    tasks.setReady(task.id, { runAt: now + delay * 60_000, countAttempt: true, reason: `失敗しました（${result.errorMessage.split('\n')[0]}）。${delay} 分後にもう一度試します` });
  }
}
