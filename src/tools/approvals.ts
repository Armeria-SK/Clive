import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Placement } from './hooks/scope.ts';
import type { AskKind } from './types.ts';

export type ApprovalDecision = 'once' | 'conversation' | 'folder' | 'deny';
export type ApprovalOutcome = 'approved' | 'denied' | 'expired' | 'cancelled';

// 確かめの札で見せるコードのファイル（読めないものは text に理由の文を入れる）
export interface PreviewFile { path: string; text: string; truncated: boolean }

// 承認の札に出す、見つけたパスごとの判定。in: 許可フォルダの中（mode はそのフォルダの読み書き / 読むだけ）、out: 外、deny: 拒否、unknown: 判定できない（変数など。path は無い）
export interface ApprovalPath { input: string; path?: string; verdict: 'in' | 'out' | 'deny' | 'unknown'; mode?: 'read' | 'write' }

// 判定の材料: 道具の事前判定が、見つけたパスごとに残した置き場所
export interface PlacedPath { input: string; path?: string | undefined; placement: Placement | { kind: 'unresolved'; reason: string } }

const MAX_APPROVAL_PATHS = 30;

// 判定そのものは事前判定が済ませている。ここでは見つけたパスを、画面に渡す形に直すだけで、判定には何も足さない。
// 同じ入力・同じ場所・同じ判定の重なりは 1 行にする
function distinctPaths(found: readonly PlacedPath[]): ApprovalPath[] {
  const out: ApprovalPath[] = [];
  const seen = new Set<string>();
  for (const { input, path, placement } of found) {
    const item: ApprovalPath = placement.kind === 'inside' ? { input, ...(path !== undefined ? { path } : {}), verdict: 'in', mode: placement.mode }
      : placement.kind === 'outside' ? { input, ...(path !== undefined ? { path } : {}), verdict: 'out' }
      : placement.kind === 'deny' ? { input, ...(path !== undefined ? { path } : {}), verdict: 'deny' }
      : { input, verdict: 'unknown' };
    const key = JSON.stringify([item.input, item.path, item.verdict, item.mode]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// 画面に出す行: 許可フォルダの外・拒否・判定できないを先に（それぞれ見つけた順）、中はそのあと。多すぎる分は切る
export function approvalPaths(found: readonly PlacedPath[]): ApprovalPath[] {
  const all = distinctPaths(found);
  return [...all.filter(p => p.verdict !== 'in'), ...all.filter(p => p.verdict === 'in')].slice(0, MAX_APPROVAL_PATHS);
}

// 切って出さなかった行の数
export function approvalPathsMore(found: readonly PlacedPath[]): number {
  return Math.max(0, distinctPaths(found).length - MAX_APPROVAL_PATHS);
}

export interface ApprovalRequest {
  runId: string;
  conversationId: string;
  tool: string;
  input: unknown;
  title: string;
  body: string;
  cwd?: string | undefined;
  reasons: string[];
  details: string[];
  // コードを動かす確かめ。「この会話では許可」を出さず、同じ文字のコマンドの許可を覚えない
  onceOnly?: boolean | undefined;
  // 道具ごとの方針が ask の確かめ。毎回承認を求める（「この会話では許可」を出さず、送られても今回だけ）。コードを動かす確かめ（onceOnly）とは別
  everyTime?: boolean | undefined;
  // 確かめになった理由の種類（画面には渡さない）
  kinds?: AskKind[] | undefined;
  // この札に添える「この返事のあいだ、このフォルダ以下への書き込みを許可」のフォルダ。外から読んだ内容のあとの file_write / file_edit の確かめ（理由の種類が taint だけ）にだけ付く
  grantFolder?: string | undefined;
  preview?: PreviewFile[] | undefined;
  // 見つけたパスごとの判定（details の文と同じものを構造で渡す。無ければ空）
  paths?: ApprovalPath[] | undefined;
  // paths に入りきらず、切った行の数
  pathsMore?: number | undefined;
}

export interface ApprovalView extends ApprovalRequest {
  id: string;
  inputHash: string;
  createdAt: number;
  expiresAt: number;
}

// 画面に渡す承認の形。SSE の知らせ・GET /api/approvals・タスクの詳細で、この 1 か所だけを使う
export function approvalPublic(v: ApprovalView) {
  return {
    id: v.id, tool: v.tool, title: v.title, body: v.body, cwd: v.cwd, reasons: v.reasons, details: v.details, expiresAt: v.expiresAt,
    onceOnly: v.onceOnly === true, everyTime: v.everyTime === true, preview: v.preview ?? [], paths: v.paths ?? [], pathsMore: v.pathsMore ?? 0, grantFolder: v.grantFolder ?? null,
  };
}

// API の応答（GET /api/approvals・会話・タスクの詳細）が返す形。どの実行・会話の承認かを添える
export function approvalWire(v: ApprovalView) {
  return { runId: v.runId, conversationId: v.conversationId, ...approvalPublic(v) };
}

export function inputHash(tool: string, input: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, stable((v as Record<string, unknown>)[k])])) : v;
  return createHash('sha256').update(JSON.stringify([tool, stable(input)])).digest('hex');
}

interface Pending { view: ApprovalView; resolve: (o: ApprovalOutcome) => void; timer: ReturnType<typeof setTimeout> }

export type ApprovalNotify = (event: { type: 'requested'; view: ApprovalView } | { type: 'resolved'; view: ApprovalView; outcome: ApprovalOutcome }) => void;

export class ApprovalBroker {
  #pending = new Map<string, Pending>();
  #conversationGrants = new Set<string>();
  readonly #db: DatabaseSync;
  readonly #notify: ApprovalNotify;

  constructor(db: DatabaseSync, notify: ApprovalNotify) { this.#db = db; this.#notify = notify; }

  isGranted(conversationId: string, hash: string): boolean { return this.#conversationGrants.has(`${conversationId}:${hash}`); }

  // 会話を消したとき、その会話の「この会話では許可」の覚えも消す
  forgetConversation(conversationId: string): void {
    for (const key of [...this.#conversationGrants]) if (key.startsWith(`${conversationId}:`)) this.#conversationGrants.delete(key);
  }

  request(req: ApprovalRequest, timeoutMs: number, signal: AbortSignal): Promise<ApprovalOutcome> {
    const now = Date.now();
    const view: ApprovalView = { ...req, id: randomUUID(), inputHash: inputHash(req.tool, req.input), createdAt: now, expiresAt: now + timeoutMs };
    this.#db.prepare(`INSERT INTO approvals (id, run_id, conversation_id, tool, input, input_hash, reasons, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(view.id, view.runId, view.conversationId, view.tool, JSON.stringify(view.input), view.inputHash, JSON.stringify(view.reasons), now, view.expiresAt);
    return new Promise(resolve => {
      const finish = (outcome: ApprovalOutcome, status: string) => {
        const pending = this.#pending.get(view.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(view.id);
        signal.removeEventListener('abort', onAbort);
        this.#db.prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?').run(status, Date.now(), view.id);
        this.#notify({ type: 'resolved', view, outcome });
        resolve(outcome);
      };
      const onAbort = () => finish('cancelled', 'cancelled');
      const timer = setTimeout(() => finish('expired', 'expired'), timeoutMs);
      timer.unref?.();
      this.#pending.set(view.id, { view, resolve: outcome => finish(outcome, outcome === 'approved' ? 'approved' : outcome), timer });
      signal.addEventListener('abort', onAbort, { once: true });
      this.#notify({ type: 'requested', view });
    });
  }

  // 自動承認（判定役）が許したことを記録する。札は出さない。status は approved、scope は auto。reasons には、元の確かめの理由のあとに判定役の理由を 1 つ足す（最後の要素）。
  // 戻り値の id を、道具の記録（tool_calls.approval_id）につなぐ
  recordAuto(req: ApprovalRequest, classifierReason: string): string {
    const now = Date.now();
    const id = randomUUID();
    this.#db.prepare(`INSERT INTO approvals (id, run_id, conversation_id, tool, input, input_hash, reasons, status, scope, created_at, expires_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', 'auto', ?, ?, ?)`).run(id, req.runId, req.conversationId, req.tool, JSON.stringify(req.input), inputHash(req.tool, req.input), JSON.stringify([...req.reasons, classifierReason]), now, now, now);
    return id;
  }

  decide(id: string, decision: ApprovalDecision): boolean {
    const pending = this.#pending.get(id);
    if (!pending) return false;
    // コードを動かす確かめと、方針が ask の確かめは、古い画面から「この会話では許可」が送られても今回だけとして扱う。フォルダの許可を添えていない札に「フォルダ」が送られたときも、今回だけ
    const scope = decision === 'conversation' && (pending.view.onceOnly || pending.view.everyTime) ? 'once'
      : decision === 'folder' && !pending.view.grantFolder ? 'once' : decision;
    if (scope === 'conversation') this.#conversationGrants.add(`${pending.view.conversationId}:${pending.view.inputHash}`);
    this.#db.prepare('UPDATE approvals SET scope = ?, grant_folder = ? WHERE id = ?').run(scope, scope === 'folder' ? pending.view.grantFolder ?? null : null, id);
    pending.resolve(decision === 'deny' ? 'denied' : 'approved');
    return true;
  }

  // 「この返事のあいだ、このフォルダ以下への書き込みを許可」で許可された札なら、そのフォルダ（記録から読む）
  grantedFolder(id: string): string | undefined {
    const row = this.#db.prepare('SELECT grant_folder FROM approvals WHERE id = ?').get(id) as { grant_folder: string | null } | undefined;
    return row?.grant_folder ?? undefined;
  }

  pending(): ApprovalView[] { return [...this.#pending.values()].map(p => p.view); }

  cancelAll(): void { for (const p of [...this.#pending.values()]) p.resolve('cancelled'); }
}
