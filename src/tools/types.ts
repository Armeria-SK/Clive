import type { DatabaseSync } from 'node:sqlite';
import type { TSchema } from '@sinclair/typebox';
import type { AppConfig, Language } from '../config/schema.ts';
import type { RunEvent } from '../engine/types.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { TaskStore } from '../tasks/store.ts';
import type { CuriosityStore } from '../curiosity/store.ts';
import type { SkillStore } from './skills/store.ts';
import type { PageNetwork } from './web/public-page.ts';
import type { SearchThrottle } from './web/search.ts';
import type { AppPaths } from '../paths.ts';
import type { Decision } from './hooks/shell-guard.ts';
import type { ScopePolicy } from './hooks/scope.ts';
import type { ApprovalPath, PreviewFile } from './approvals.ts';

export type ToolEffect = 'read' | 'write' | 'exec' | 'network' | 'meta';

export type RunKind = 'chat' | 'task' | 'review';

export interface ToolOutput {
  content: string;
  isError?: boolean;
  fullRef?: string;
  noRemoteContent?: boolean;
}

export interface PreCheck {
  decision: Decision;
  reasons: string[];
  details?: string[];
  // 見つけたパスごとの判定（details と同じ材料を構造で。判定には使わず、承認の札に出すだけ）
  paths?: ApprovalPath[];
  pathsMore?: number;
  // コードを動かす確かめ（種類 'code'）を含む。会話の許可を越えず、毎回確かめる
  onceOnly?: boolean;
  askKinds?: Array<'code'>;
  // 確かめの札で見せるコードのファイル
  preview?: PreviewFile[];
  // 見せたファイルの中身の指紋。承認のあと実行の前にもう一度判定して、変わっていたら実行しない
  bind?: string;
  // シェル: コマンドの git がすべて、設定に core.hooksPath の無い 1 つのリポジトリのもので、そのリポジトリ自身のフックの置き場所。許されたときだけ、git のフックをここに向ける
  ownHooksDir?: string;
}

// 実行の直前に、パイプラインが道具へ渡す、この 1 回の呼び出しの承認の結果
export interface ExecuteInfo {
  // 持ち主が、この呼び出しの「今回だけ」の確かめ（コードを動かす確かめ）を許した
  approvedOnce: boolean;
  // 許したときに持ち主に見せた事前の判定
  check?: PreCheck;
}

export interface ToolContext {
  runId: string;
  conversationId: string;
  kind: RunKind;
  signal: AbortSignal;
  config: AppConfig;
  paths: AppPaths;
  policy: ScopePolicy;
  workspace: string;
  taint: { tainted: boolean; sources: string[] };
  // この実行が使うモデルが、すべて手元（提供元の接続先がループバック）か。そうでなければ、手元のモデルを選んだ会話の履歴は、検索にも読み出しにも出さない
  modelsLocal?: boolean | undefined;
  // この実行で、検索が自動アクセスの判定（ボット判定）で続けて止められた回数（成功・別の失敗で 0 に戻る）
  searchBlocks?: number | undefined;
  // この実行で、task_create で作った・task_update で触ったタスクの id（会話の実行が終わるとき、会話で進んだ分を渡す先を決める）
  touchedTasks?: Set<string> | undefined;
  log: (line: string) => void;
  services?: {
    db: DatabaseSync; memory: MemoryStore; emit: (event: RunEvent) => void;
    tasks?: TaskStore | undefined; curiosity?: CuriosityStore | undefined; skills?: SkillStore | undefined;
    // 持ち主へのお知らせ（同じ dedupKey は 1 日に重ねない）
    notify?: ((input: { kind: 'info' | 'health_alert'; title: string; body?: string; link?: string; dedupKey: string }) => unknown) | undefined;
    web?: { network?: PageNetwork | undefined; fetch?: ((url: string | URL, init?: RequestInit) => Promise<Response>) | undefined; throttle?: SearchThrottle | undefined } | undefined;
  } | undefined;
  task?: { id: string; control: TaskControl } | undefined;
  // 道具の結果を返せる文字数の上限（モデルのコンテキストに合わせて、エンジンが呼ぶたびに決める）。無ければ 16,000 文字
  outputLimit?: number | undefined;
  // この実行では渡さず、呼ばれても拒否する道具の名前（例: 整理の振り返りでは memory_forget）
  forbiddenTools?: ReadonlySet<string> | undefined;
}

export type TaskControl =
  | { outcome: 'none' }
  | { outcome: 'complete'; summary: string; notify: boolean }
  | { outcome: 'checkpoint'; note: string; nextAction: string; resumeAfterMinutes: number }
  | { outcome: 'question'; question: string };

export interface ToolDef<I = any> {
  name: string;
  description: string;
  input: TSchema;
  effect: ToolEffect;
  allowedIn: readonly RunKind[];
  preCheck?: (input: I, ctx: ToolContext) => PreCheck | Promise<PreCheck>;
  // 外から読んだ内容（Web・添付）のあとで確認を求める道具。書き込み・実行の道具は、これが無くても確認する
  escalateOnTaint?: boolean;
  summarize?: (input: I, language: Language) => { title: string; body: string; cwd?: string };
  execute: (input: I, ctx: ToolContext, info?: ExecuteInfo) => Promise<ToolOutput>;
}
