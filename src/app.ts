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
import { ApprovalBroker, approvalPublic } from './tools/approvals.ts';
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
import { fileSearch } from './tools/builtin/file-search.ts';
import { calculate, dateCalc } from './tools/builtin/calc.ts';
import { checklistWrite } from './tools/builtin/checklist.ts';
import { notifyOwner } from './tools/builtin/notify.ts';
import type { PageNetwork } from './tools/web/public-page.ts';
import { SearchThrottle } from './tools/web/search.ts';
import { SkillStore } from './tools/skills/store.ts';
import { TaskStore, taskView } from './tasks/store.ts';
import { Worker } from './tasks/worker.ts';
import { Uploads } from './uploads/store.ts';
import { ToolRegistry } from './tools/registry.ts';
import { ignoredPolicyNames } from './tools/tool-policy.ts';
import type { ToolDef } from './tools/types.ts';
import { MemoryStore, renderBooks } from './memory/store.ts';

export function builtinTools(): ToolDef[] {
  return [
    taskComplete, taskCheckpoint, askUser,
    memorySave, historySearch, webSearch, webFetch, fileRead, fileList, fileWrite, fileEdit, shellRun,
    taskCreate, taskList, taskUpdate,
    memoryUpdate, memoryForget, memorySearch, historyRead,
    skillView, skillDraft, curiosityAdd, curiosityList, curiosityUpdate,
    fileSearch, calculate, dateCalc,
    checklistWrite, notifyOwner,
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
  // 提供元が鍵を読む環境変数（ふだんは process.env）。画面から入れた鍵はここにも入れ、起動し直さなくても効かせる
  readonly env: Record<string, string | undefined>;
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
  // いま動いている Web サーバーの設定（起動したとき、または画面から反映したときの値）。設定ファイルの server がこれと違えば、反映が要る
  bootServer: AppConfig['server'];

  constructor(options: AppOptions) {
    this.paths = options.paths;
    this.env = (options.env ?? process.env) as Record<string, string | undefined>;
    this.log = options.log ?? (line => process.stdout.write(`${line}\n`));
    this.configStore = new ConfigStore(this.paths.config);
    const config = this.configStore.load();
    ensureWorkspace(this.paths, languageOf(config));
    this.bootServer = structuredClone(config.server);
    this.#warnIgnoredPolicies(config);
    this.db = openDatabase(options.databasePath ?? this.paths.database, MIGRATIONS, { backupDir: this.paths.backups });
    const now = options.now ?? Date.now;
    this.conversations = new Conversations(this.db, now, this.log);
    this.runs = new Runs(this.db, now);
    this.kv = new KV(this.db, now);
    const dangling = this.runs.closeDangling(engineText(languageOf(config), 'run.restart_interrupted'));
    if (dangling) this.log(`[INFO] 前回の終了時に途中だった実行 ${dangling} 件を中断扱いにしました`);
    this.registry = new ProviderRegistry({
      env: this.env,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.adapterOverride ? { override: options.adapterOverride } : {}),
    });
    this.registry.reload(config);
    this.status = new ModelStatus({ registry: this.registry, kv: this.kv, baseTokens: () => this.baseTokens(), memoryTokens: () => this.memoryTokens(), log: this.log });
    this.bus = new RunBus();
    this.limiter = new EndpointLimiter();
    this.tools = new ToolRegistry();
    for (const tool of options.tools ?? builtinTools()) this.tools.register(tool);
    this.approvals = new ApprovalBroker(this.db, event => {
      const v = event.view;
      if (event.type === 'requested') {
        this.bus.publish({ type: 'approval.requested', runId: v.runId, conversationId: v.conversationId, approval: approvalPublic(v) });
        // タスクの実行中は画面を見ていないことが多いので、通知でも知らせる
        const task = this.tasks.byConversation(v.conversationId);
        if (task) {
          this.notifications.notify({ kind: 'approval_needed', title: taskText(languageOf(this.config()), 'notify.approval_needed', { title: task.title }), body: `${v.title}\n${v.body}`, link: `#/tasks/${task.id}`, dedupKey: `approval:${v.id}` });
        }
      } else {
        this.bus.publish({ type: 'approval.resolved', runId: v.runId, conversationId: v.conversationId, approvalId: v.id, outcome: event.outcome });
        this.notifications.settle('approval_needed', { dedupKey: `approval:${v.id}` });
      }
    });
    this.memory = new MemoryStore(this.db, undefined, () => languageOf(this.config()));
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
      notify: input => this.notifications.notify(input),
      ...(options.now ? { now: () => new Date(now()) } : {}),
    });
    this.worker = new Worker({
      db: this.db, tasks: this.tasks, engine: this.engine, conversations: this.conversations, notifications: this.notifications,
      kv: this.kv, config: () => this.config(), log: this.log, now, autoSchedule: options.workerTimers ?? true,
      reviews: this.reviews, memory: this.memory, curiosity: this.curiosity, memoryBudget: () => this.engine.memoryBudget(),
    });
    this.tasks.onChange = task => {
      this.bus.publish({ type: 'task.changed', task: taskView(task, languageOf(this.config())) });
      // 返事待ち・失敗でなくなったタスクの、返事や確認を求める通知は、もう答えることが無い
      if (task.status !== 'waiting') this.notifications.settle('task_waiting', { link: `#/tasks/${task.id}` });
      if (task.status !== 'failed') this.notifications.settle('task_failed', { link: `#/tasks/${task.id}` });
      if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
        this.curiosity.onTaskFinished(task);
        // 実行したタスクが終わったら振り返る（実行の記録があるものだけ）
        if (task.status !== 'cancelled' && task.conversation_id && this.config().memory.review) {
          this.reviews.enqueue('task', `task:${task.id}`, { taskId: task.id, conversationId: task.conversation_id });
        }
      }
      this.worker.poke();
    };
    this.tasks.onUncancelled = task => this.curiosity.onTaskRestored(task);
    this.notifications.onNotify = notification => this.bus.publish({ type: 'notification', notification });
    this.notifications.onSettled = ids => this.bus.publish({ type: 'notification.read', ids, unread: this.notifications.unread() });
    this.health = new HealthMonitor({ status: this.status, runs: this.runs, notifications: this.notifications, now, log: this.log, language: () => languageOf(this.config()) });
    this.bus.subscribe(entry => this.health.observe(entry.event));
    this.skills.onDraft = draft => {
      this.notifications.notify({ kind: 'info', title: taskText(languageOf(this.config()), 'notify.skill_draft', { name: draft.name }), body: draft.reason ?? undefined, link: `#/skills/draft/${encodeURIComponent(draft.name)}`, dedupKey: `skill-draft:${draft.id}` });
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

  // Web サーバーを起動するときに呼ぶ（doctor など、動いているサーバーと同じ DB を開くだけの使い方では呼ばない。呼ぶと動いている承認待ちの通知まで既読になる）。
  // もう答えようのない大事な未読を既読にする（片づいたときに既読にする仕組みの前からあった通知と、落ちて承認の札ごと消えた通知）。
  // 起動直後は承認の札がひとつも無いので、承認待ちは全部。返事待ち・失敗は、タスクが無いか、今その状態でないものだけ既読にする
  settleStaleNotifications(): void {
    const stale = this.notifications.list(0).filter(n => {
      if (n.kind === 'approval_needed') return true;
      if (!n.link?.startsWith('#/tasks/')) return false;
      const task = this.tasks.get(n.link.slice('#/tasks/'.length));
      return task === undefined || task.status !== (n.kind === 'task_waiting' ? 'waiting' : 'failed');
    });
    if (stale.length) this.notifications.settleIds(stale.map(n => n.id));
  }

  #applied = '';

  // tools.policies に書かれていても、方針を持てない道具（task_complete など）の分は効かない。気づけるよう 1 行ログに出す
  #warnIgnoredPolicies(config: AppConfig): void {
    for (const name of ignoredPolicyNames(config)) this.log(`[WARN] tools.policies の「${name}」は、方針を持てない道具（タスクの進め方に必要）なので無視します`);
  }

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
      this.#warnIgnoredPolicies(config);
      this.worker?.poke();
    }
    this.#applied ||= json;
    return config;
  }

  baseTokens(): number {
    const config = this.config();
    // probeAll はコンストラクタの途中（記憶やツールを作る前）からも呼ばれうるので、無ければ 0 として扱う
    const language = languageOf(config);
    const tools = this.tools ? estimateToolTokens(ToolRegistry.specs(this.tools.forRun('chat'))) : 0;
    return estimateTextTokens(buildSnapshot(this.paths, { skills: this.skills?.index(language) ?? '' }, language).text) + tools
      + estimateTextTokens(buildDynamic(config.timezone, language)) + 64;
  }

  // 記憶を全部入れたときの見積もり。必要な長さには、各モデルの available の 12% までだけが数えられる（requiredContext）
  memoryTokens(): number {
    return this.memory ? estimateTextTokens(renderBooks(this.memory.list(), languageOf(this.config()))) : 0;
  }

  // probe: false は、モデルやプロバイダに関わらない変更（道具の方針など）で、モデルの確認の通信をしない
  async applyConfig(next: AppConfig, options: { probe?: boolean } = {}): Promise<AppConfig> {
    const saved = this.configStore.save(next);
    this.#applied = JSON.stringify(saved);
    this.registry.reload(saved);
    if (options.probe !== false) await this.status.probeAll(saved);
    this.worker.poke();
    return saved;
  }

  // 画面から反映した server の設定を、「いま動いているもの」として覚える（restartRequired の比べ先）
  markServerApplied(server: AppConfig['server']): void { this.bootServer = structuredClone(server); }

  restartRequired(): boolean {
    return JSON.stringify(this.config().server) !== JSON.stringify(this.bootServer);
  }

  close(): void {
    this.worker.stop();
    this.engine.saveQueued();
    this.engine.stopAll();
    this.approvals.cancelAll();
    this.db.close();
  }
}
