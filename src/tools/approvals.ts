import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type ApprovalDecision = 'once' | 'conversation' | 'deny';
export type ApprovalOutcome = 'approved' | 'denied' | 'expired' | 'cancelled';

// 確かめの札で見せるコードのファイル（読めないものは text に理由の文を入れる）
export interface PreviewFile { path: string; text: string; truncated: boolean }

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
  preview?: PreviewFile[] | undefined;
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
    onceOnly: v.onceOnly === true, preview: v.preview ?? [],
  };
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

  decide(id: string, decision: ApprovalDecision): boolean {
    const pending = this.#pending.get(id);
    if (!pending) return false;
    // コードを動かす確かめは、古い画面から「この会話では許可」が送られても今回だけとして扱う
    const scope = decision === 'conversation' && pending.view.onceOnly ? 'once' : decision;
    if (scope === 'conversation') this.#conversationGrants.add(`${pending.view.conversationId}:${pending.view.inputHash}`);
    this.#db.prepare('UPDATE approvals SET scope = ? WHERE id = ?').run(scope, id);
    pending.resolve(decision === 'deny' ? 'denied' : 'approved');
    return true;
  }

  pending(): ApprovalView[] { return [...this.#pending.values()].map(p => p.view); }

  cancelAll(): void { for (const p of [...this.#pending.values()]) p.resolve('cancelled'); }
}
