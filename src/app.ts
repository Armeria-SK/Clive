import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig, ProviderConfig } from './config/schema.ts';
import { ConfigStore } from './config/store.ts';
import { Conversations } from './db/conversations.ts';
import { openDatabase } from './db/database.ts';
import { KV } from './db/kv.ts';
import { MIGRATIONS } from './db/migrations.ts';
import { Runs } from './db/runs.ts';
import { RunBus } from './engine/bus.ts';
import { ChatEngine } from './engine/chat.ts';
import { HealthMonitor } from './engine/health.ts';
import { ModelStatus } from './engine/status.ts';
import { estimateTextTokens, estimateToolTokens } from './engine/tokens.ts';
import { buildDynamic, buildSnapshot, ensureWorkspace } from './engine/workspace.ts';
import type { AppPaths } from './paths.ts';
import { languageOf } from './shared/language.ts';
import { engineText } from './shared/messages/engine.ts';
import { taskText } from './shared/messages/tasks.ts';
import { EndpointLimiter } from './providers/limiter.ts';
import { ProviderRegistry } from './providers/registry.ts';
import type { Env, FetchLike, ProviderAdapter } from './providers/types.ts';
import { ApprovalBroker } from './tools/approvals.ts';
import { fileEdit, fileList, fileRead, fileWrite } from './tools/builtin/files.ts';
import { historyRead, historySearch, memoryForget, memorySave, memorySearch, memoryUpdate } from './tools/builtin/memory.ts';
import { shellRun } from './tools/builtin/shell.ts';
import { askUser, taskCheckpoint, taskComplete, taskCreate, taskList, taskUpdate } from './tools/builtin/tasks.ts';
import { Notifications } from './notify/notifications.ts';
import { CuriosityStore } from './curiosity/store.ts';
import { ReviewJobs } from './memory/review.ts';
import { curiosityAdd, curiosityList, curiosityUpdate } from './tools/builtin/curiosity.ts';
import { skillDraft, skillView } from './tools/builtin/skills.ts';
import { webFetch, webSearch } from './tools/builtin/web.ts';
import type { PageNetwork } from './tools/web/public-page.ts';
import { SearchThrottle } from './tools/web/search.ts';
import { SkillStore } from './tools/skills/store.ts';
import { TaskStore, taskView } from './tasks/store.ts';
import { Worker } from './tasks/worker.ts';
import { Uploads } from './uploads/store.ts';
import { ToolRegistry } from './tools/registry.ts';
import type { ToolDef } from './tools/types.ts';
import { MemoryStore, renderBooks } from './memory/store.ts';

export function builtinTools(): ToolDef[] {
  return [
    taskComplete, taskCheckpoint, askUser,
    memorySave, historySearch, webSearch, webFetch, fileRead, fileList, fileWrite, fileEdit, shellRun,
    taskCreate, taskList, taskUpdate,
    memoryUpdate, memoryForget, memorySearch, historyRead,
    skillView, skillDraft, curiosityAdd, curiosityList, curiosityUpdate,
  ];
}

export interface AppOptions {
  paths: AppPaths;
  env?: Env;
  fetch?: FetchLike;
  adapterOverride?: (provider: ProviderConfig) => ProviderAdapter | undefined;
  log?: (line: string) => void;
  databasePath?: string;
  tools?: ToolDef[];
  now?: () => number;
  workerTimers?: boolean;
  webNetwork?: PageNetwork;
}

export class App {
  readonly paths: AppPaths;
  readonly configStore: ConfigStore;
  readonly db: DatabaseSync;
  readonly conversations: Conversations;
  readonly runs: Runs;
  readonly kv: KV;
  readonly registry: ProviderRegistry;
  readonly status: ModelStatus;
  readonly bus: RunBus;
  readonly limiter: EndpointLimiter;
  readonly tools: ToolRegistry;
  readonly approvals: ApprovalBroker;
  readonly memory: MemoryStore;
  readonly tasks: TaskStore;
  readonly notifications: Notifications;
  readonly reviews: ReviewJobs;
  readonly curiosity: CuriosityStore;
  readonly skills: SkillStore;
  readonly uploads: Uploads;
  readonly engine: ChatEngine;
  readonly worker: Worker;
  readonly health: HealthMonitor;
  readonly log: (line: string) => void;
  readonly bootServer: AppConfig['server'];

  constructor(options: AppOptions) {
    this.paths = options.paths;
    this.log = options.log ?? (line => process.stdout.write(`${line}\n`));
    this.configStore = new ConfigStore(this.paths.config);
    const config = this.configStore.load();
    ensureWorkspace(this.paths, languageOf(config));
    this.bootServer = structuredClone(config.server);
    this.db = openDatabase(options.databasePath ?? this.paths.database, MIGRATIONS, { backupDir: this.paths.backups });
    const now = options.now ?? Date.now;
    this.conversations = new Conversations(this.db, now);
    this.runs = new Runs(this.db, now);
    this.kv = new KV(this.db, now);
    const dangling = this.runs.closeDangling(engineText(languageOf(config), 'run.restart_interrupted'));
    if (dangling) this.log(`[INFO] 前回の終了時に途中だった実行 ${dangling} 件を中断扱いにしました`);
    this.registry = new ProviderRegistry({
      env: options.env ?? process.env,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.adapterOverride ? { override: options.adapterOverride } : {}),
    });
    this.registry.reload(config);
    this.status = new ModelStatus({ registry: this.registry, kv: this.kv, baseTokens: () => this.baseTokens(), log: this.log });
    this.bus = new RunBus();
    this.limiter = new EndpointLimiter();
    this.tools = new ToolRegistry();
    for (const tool of options.tools ?? builtinTools()) this.tools.register(tool);
    this.approvals = new ApprovalBroker(this.db, event => {
      const v = event.view;
      if (event.type === 'requested') {
        this.bus.publish({ type: 'approval.requested', runId: v.runId, conversationId: v.conversationId, approval: {
          id: v.id, tool: v.tool, title: v.title, body: v.body, cwd: v.cwd, reasons: v.reasons, details: v.details, expiresAt: v.expiresAt,
        } });
        // タスクの実行中は画面を見ていないことが多いので、通知でも知らせる
        const task = this.tasks.byConversation(v.conversationId);
        if (task) {
          this.notifications.notify({ kind: 'approval_needed', title: taskText(languageOf(this.config()), 'notify.approval_needed', { title: task.title }), body: `${v.title}\n${v.body}`, link: `#/tasks/${task.id}`, dedupKey: `approval:${v.id}` });
        }
      } else {
        this.bus.publish({ type: 'approval.resolved', runId: v.runId, conversationId: v.conversationId, approvalId: v.id, outcome: event.outcome });
      }
    });
    this.memory = new MemoryStore(this.db, () => {
      const m = this.config().memory;
      return { user: m.userMaxChars, notes: m.notesMaxChars };
    }, undefined, () => languageOf(this.config()));
    this.tasks = new TaskStore(this.db, now, () => languageOf(this.config()));
    this.notifications = new Notifications(this.db, now);
    this.reviews = new ReviewJobs(this.db, now);
    this.curiosity = new CuriosityStore(this.db, now);
    this.skills = new SkillStore(this.db, join(this.paths.workspace, 'skills'), now, () => languageOf(this.config()));
    this.#importCuriosity();
    this.uploads = new Uploads(this.db, this.paths.uploads, now);
    this.engine = new ChatEngine({
      config: () => this.config(), conversations: this.conversations, runs: this.runs, kv: this.kv,
      registry: this.registry, status: this.status, bus: this.bus, limiter: this.limiter, paths: this.paths,
      tools: { registry: this.tools, approvals: this.approvals }, memory: this.memory, tasks: this.tasks,
      curiosity: this.curiosity, skills: this.skills, log: this.log,
      web: { network: options.webNetwork, fetch: options.fetch, throttle: new SearchThrottle(now) },
      ...(options.now ? { now: () => new Date(now()) } : {}),
    });
    this.worker = new Worker({
      db: this.db, tasks: this.tasks, engine: this.engine, conversations: this.conversations, notifications: this.notifications,
      kv: this.kv, config: () => this.config(), log: this.log, now, autoSchedule: options.workerTimers ?? true,
      reviews: this.reviews, memory: this.memory, curiosity: this.curiosity,
    });
    this.tasks.onChange = task => {
      this.bus.publish({ type: 'task.changed', task: taskView(task, languageOf(this.config())) });
      if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
        this.curiosity.onTaskFinished(task);
        // 実行したタスクが終わったら振り返る（実行の記録があるものだけ）
        if (task.status !== 'cancelled' && task.conversation_id && this.config().memory.review) {
          this.reviews.enqueue('task', `task:${task.id}`, { taskId: task.id, conversationId: task.conversation_id });
        }
      }
      this.worker.poke();
    };
    this.notifications.onNotify = notification => this.bus.publish({ type: 'notification', notification });
    this.health = new HealthMonitor({ status: this.status, runs: this.runs, notifications: this.notifications, now, log: this.log, language: () => languageOf(this.config()) });
    this.bus.subscribe(entry => this.health.observe(entry.event));
    this.skills.onDraft = draft => {
      this.notifications.notify({ kind: 'info', title: taskText(languageOf(this.config()), 'notify.skill_draft', { name: draft.name }), body: draft.reason ?? undefined, link: '#/review', dedupKey: `skill-draft:${draft.id}` });
    };
    this.engine.onRunEnd = run => {
      // 道具を多く使った重い会話の後に振り返る
      const config = this.config();
      if (run.kind === 'chat' && config.memory.review) {
        const row = this.runs.get(run.runId);
        if (row && row.ok && row.tool_calls >= config.memory.reviewAfterToolCalls) {
          this.reviews.enqueue('heavy_run', `run:${run.runId}`, { conversationId: run.conversationId });
        }
      }
      this.worker.poke();
    };
  }

  #applied = '';

  #importCuriosity(): void {
    if (this.kv.get('curiosity:imported')) return;
    const path = join(this.paths.workspace, 'CURIOSITY.md');
    let added = 0;
    try { if (existsSync(path)) added = this.curiosity.importMarkdown(readFileSync(path, 'utf8')); }
    catch (error) { this.log(`[WARN] CURIOSITY.md を読めませんでした: ${(error as Error).message}`); }
    this.kv.set('curiosity:imported', String(Date.now()));
    if (added) this.log(`[INFO] CURIOSITY.md から好奇心リストに ${added} 件取り込みました（以後は画面の「好奇心」で編集します）`);
  }

  config(): AppConfig {
    const config = this.configStore.current();
    const json = JSON.stringify(config);
    if (this.#applied && json !== this.#applied) {
      this.#applied = json;
      this.registry.reload(config);
      void this.status.probeAll(config).catch(error => this.log(`[ERROR] 設定の再読み込み後の確認に失敗: ${(error as Error).message}`));
      this.log('[INFO] 設定ファイルの変更を読み込みました');
      this.worker?.poke();
    }
    this.#applied ||= json;
    return config;
  }

  baseTokens(): number {
    const config = this.config();
    // probeAll はコンストラクタの途中（記憶やツールを作る前）からも呼ばれうるので、無ければ 0 として扱う
    const memoryBudget = config.memory.userMaxChars + config.memory.notesMaxChars;
    const language = languageOf(config);
    const memoryNow = this.memory ? estimateTextTokens(renderBooks(this.memory.list(), language)) : 0;
    const tools = this.tools ? estimateToolTokens(ToolRegistry.specs(this.tools.forRun('chat'))) : 0;
    return estimateTextTokens(buildSnapshot(this.paths, { skills: this.skills?.index(language) ?? '' }, language).text) + Math.max(memoryBudget, memoryNow) + tools
      + estimateTextTokens(buildDynamic(config.timezone, language)) + 64;
  }

  async applyConfig(next: AppConfig): Promise<AppConfig> {
    const saved = this.configStore.save(next);
    this.#applied = JSON.stringify(saved);
    this.registry.reload(saved);
    await this.status.probeAll(saved);
    this.worker.poke();
    return saved;
  }

  restartRequired(): boolean {
    return JSON.stringify(this.config().server) !== JSON.stringify(this.bootServer);
  }

  close(): void {
    this.worker.stop();
    this.engine.stopAll();
    this.approvals.cancelAll();
    this.db.close();
  }
}
