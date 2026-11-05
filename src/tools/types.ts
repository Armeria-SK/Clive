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
import type { PreviewFile } from './approvals.ts';

export type ToolEffect = 'read' | 'write' | 'exec' | 'network' | 'meta';

export type RunKind = 'chat' | 'task' | 'review';

export interface ToolOutput {
  content: string;
  isError?: boolean;
  fullRef?: string;
}

export interface PreCheck {
  decision: Decision;
  reasons: string[];
  details?: string[];
  // コードを動かす確かめ（種類 'code'）を含む。会話の許可を越えず、毎回確かめる
  onceOnly?: boolean;
  askKinds?: Array<'code'>;
  // 確かめの札で見せるコードのファイル
  preview?: PreviewFile[];
  // 見せたファイルの中身の指紋。承認のあと実行の前にもう一度判定して、変わっていたら実行しない
  bind?: string;
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
  log: (line: string) => void;
  services?: {
    db: DatabaseSync; memory: MemoryStore; emit: (event: RunEvent) => void;
    tasks?: TaskStore | undefined; curiosity?: CuriosityStore | undefined; skills?: SkillStore | undefined;
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
  execute: (input: I, ctx: ToolContext) => Promise<ToolOutput>;
}
