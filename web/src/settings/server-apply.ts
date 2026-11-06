import { ApiError, type ServerApplyResult } from '../api.ts';

// 画面からのサーバーの設定の反映（POST /api/server/apply）の、画面を使わない部分。

// 反映したあと、画面がすること。ポートが変わった（url がある）ときは、新しいアドレスへ移る。それ以外は、その場で済み
export type ApplyStep = { kind: 'move'; to: string } | { kind: 'stay'; restartRequired: boolean };

// 新しいアドレスへ移るとき、いま開いている画面の場所（# 以降）も持っていく
export function applyStep(result: ServerApplyResult, hash: string): ApplyStep {
  if (result.url) return { kind: 'move', to: `${result.url.replace(/\/+$/u, '')}/${hash}` };
  return { kind: 'stay', restartRequired: result.restartRequired };
}

export type ApplyFailure =
  // 反映すると、この端末から入れなくなる（確かめて、もう一度押すときだけ force を付ける）。message は理由
  | { kind: 'lockout'; message: string }
  // 反映するものが無い（もう反映済み）
  | { kind: 'nothing' }
  | { kind: 'failed'; message: string | null };

export function applyFailure(error: unknown): ApplyFailure {
  if (!(error instanceof ApiError)) return { kind: 'failed', message: null };
  const kind = (error.body as { error?: unknown } | null | undefined)?.error;
  if (error.status === 409 && kind === 'would_lock_out') return { kind: 'lockout', message: error.message };
  if (error.status === 409 && kind === 'nothing_to_apply') return { kind: 'nothing' };
  return { kind: 'failed', message: error.message };
}
