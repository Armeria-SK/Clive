import type { DatabaseSync } from 'node:sqlite';
import type { TSchema } from '@sinclair/typebox';
import type { AppConfig, Language } from '../config/schema.ts';
import type { ImageRef, RunEvent } from '../engine/types.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { TaskStore } from '../tasks/store.ts';
import type { CuriosityStore } from '../curiosity/store.ts';
import type { SkillStore } from './skills/store.ts';
import type { DownloadNetwork, PageNetwork } from './web/public-page.ts';
import type { SearchThrottle } from './web/search.ts';
import type { AppPaths } from '../paths.ts';
import type { Decision } from './hooks/shell-guard.ts';
import type { ScopePolicy } from './hooks/scope.ts';
import type { ApprovalPath, PreviewFile } from './approvals.ts';
import type { PermissionMode } from '../shared/permission-mode.ts';

export type ToolEffect = 'read' | 'write' | 'exec' | 'network' | 'meta';

// 確かめ（ask）になった理由の種類。段 8b の自動承認は、これを見て判定役に回すかを決める。回してよい種類は auto-approve.ts の CLASSIFIABLE_KINDS だけ。
// precheck: 道具の事前の判定で、細かい種類が付いていない理由（回さない）/ code: コードを動かす / taint: 外から読んだ内容のあと / policy: 道具ごとの方針の ask / hook: 実行前フック。
// 事前の判定が付ける細かい種類 — outside_read: 許可フォルダの外を読む / outside_write: 外に書く / risky_command: サービスの操作・リモートの設定 /
// egress: 外とやり取りする・外のコードを入れる・外を読んだあとの送信 / git_write: git が書く / opaque: 中身や行き先が判定できない / persona: 人格・スキルの書き込み /
// owner: 持ち主が書いた確かめ / web: Web の道具の事前の確かめ。
// 種類の付かない理由・知らない種類は、自動では通さない（新しい確かめを足したときに、黙って自動になることを防ぐ）
export type AskKind =
  | 'precheck' | 'code' | 'taint' | 'policy' | 'hook'
  | 'outside_read' | 'outside_write' | 'risky_command' | 'egress' | 'git_write' | 'opaque' | 'persona' | 'owner' | 'web';

export type RunKind = 'chat' | 'task' | 'review';

export interface ToolOutput {
  content: string;
  isError?: boolean;
  fullRef?: string;
  noRemoteContent?: boolean;
  // この結果が外の中身を持ち込んだ（実行の結果を見てからでないと分からないとき。file_search が downloads/ の下の行を返したときなど）。パイプラインは「外から読んだ」印を付ける。印を付ける向きにしか働かない（付けない・外す効果は無い）
  fetched?: boolean;
  // この結果に添える画像（image_view）。エンジンが道具の結果の発言に持たせて保存し、画像を読めるモデルにだけ渡す。失敗（isError）の結果の画像は保存しない。tool.result の出来事・tool_calls の行・output_preview には入れない（文字だけ）
  images?: ImageRef[];
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
  // ask の理由の種類（理由ごとに付ける。付けなければ pipeline が precheck とみなして、自動では通さない）
  askKinds?: AskKind[];
  // 確かめの札で見せるコードのファイル
  preview?: PreviewFile[];
  // 見せたファイルの中身の指紋。承認のあと実行の前にもう一度判定して、変わっていたら実行しない
  bind?: string;
  // シェル: コマンドの git がすべて、設定に core.hooksPath の無い 1 つのリポジトリのもので、そのリポジトリ自身のフックの置き場所。許されたときだけ、git のフックをここに向ける
  ownHooksDir?: string;
  // 事前の判定: この呼び出しが外の中身を持ち込む（シェルの取得・doc_read・downloads/ の下を読む道具など。シェルは git の fetch・pull・clone、パッケージの導入を含む）。実行したら、パイプラインは「外から読んだ」印を付ける（通信の道具と同じ）
  fetched?: boolean;
  // 事前の判定: この呼び出しが外へ送りうる / 消しうる（ファイルの上書きは消すに入れない）。自動承認が判定役に回すかの材料で、false とはっきり言わなければ true とみなす（迷ったら人）。シェルは checkShellCommand の sends / removes。file_write・file_edit・table_write は removes: false と言う
  sends?: boolean;
  removes?: boolean;
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
  // この実行が作る・触るタスクを、手元のモデルだけで動かすか。手元のモデルを選んだ会話の実行と、手元のモデルだけで動かすタスクの実行が true
  localOnly?: boolean | undefined;
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
    web?: { network?: PageNetwork | undefined; download?: DownloadNetwork | undefined; fetch?: ((url: string | URL, init?: RequestInit) => Promise<Response>) | undefined; throttle?: SearchThrottle | undefined } | undefined;
  } | undefined;
  task?: { id: string; control: TaskControl } | undefined;
  // 道具の結果を返せる量の上限（見積もりのトークン。モデルのコンテキストの残りに合わせて、エンジンが呼ぶたびに決める）。
  // 文字数の上限（pipeline.ts の TOOL_OUTPUT_LIMIT = 16,000 文字）とは別で、先に達した方で切る。無ければ文字数の上限だけ
  outputTokens?: number | undefined;
  // いまモデルを呼んでいる（この道具の結果を次に読む）モデル。エンジンが道具を呼ぶ直前に入れる（鎖で替わったら替わる）。vision は設定の models[].vision。無い（試験・ほかの呼び方）なら、画像を読めないとみなす
  model?: { id: string; vision: boolean } | undefined;
  // この実行では渡さず、呼ばれても拒否する道具の名前（例: 整理の振り返りでは memory_forget）
  forbiddenTools?: ReadonlySet<string> | undefined;
  // 会話のチャットの実行が始まったときの権限モード（段 8b）。無ければふつう。実行に効くのは、これと会話のいまのモードの厳しい方（pipeline.ts の effectiveMode）
  permissionMode?: PermissionMode | undefined;
  // 自動承認で「許可フォルダの外を読む」を許した。パイプラインが付け、エンジンが読んだ時点で会話の印（conversations.ever_auto_read）に書く。この実行の残りも、あとの実行も、通信の道具（network）とシェルのコマンド（exec）は毎回確かめる（外で読んだ中身を、確かめなしに外へ送らせない）
  autoReadOutside?: boolean | undefined;
  // 「この返事のあいだ、このフォルダ以下への書き込みを許可」で許されたフォルダ（この実行だけ。別の実行には渡らない）と、許可した札の承認の記録の id
  writeGrants?: Array<{ folder: string; approvalId: string }> | undefined;
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
  // 書き込み先のフォルダ単位で、外から読んだ内容のあとの確かめ（理由の種類が taint だけ）を、その実行のあいだ許せる道具（file_write / file_edit）。事前の判定が書き込み先のパスを 1 つ返すこと
  folderGrant?: boolean;
  // 効果は network のまま、ファイルも書く道具（web_download）。計画モードでは書き込みと同じに断り（planAllows）、振り返りでも断り（reviewAllows。効果が何でも）、外から読んだ内容のあとは書き込みと同じに確かめる
  writesFiles?: true;
  // この呼び出し（引数の確かめを通ったあと）が外へ出るか。true なら、効果が network でなくても、外から読んだ印（動かしたら付く）と、自動承認で外を読んだ会話の毎回の確かめを network と同じにする。効果・計画モード・振り返りの扱いは変えない。投げる・false 以外を返すときは外へ出るとみなす
  networkCall?: (input: I) => boolean;
  // 呼び出しの引数に関わらず、必ず何かを消す道具（memory_forget）。事前の判定が removes を言わなくても、自動承認は判定役に回さない
  removes?: true;
  summarize?: (input: I, language: Language) => { title: string; body: string; cwd?: string };
  execute: (input: I, ctx: ToolContext, info?: ExecuteInfo) => Promise<ToolOutput>;
}
