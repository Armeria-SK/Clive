import { ApiError, type ServerApplyResult } from '../api.ts';

// 画面からのサーバーの設定の反映（POST /api/server/apply）の、画面を使わない部分。

// 反映したあと、画面がすること。ポートが変わった（url がある）ときは、新しいアドレスを見せる（自分では移らない）。それ以外は、その場で済む。
// 自動で移らない理由: 移るには、古い画面（別のポート）から新しいアドレスへ最上位の移動をする（Sec-Fetch-Site: same-site）ことになる。同じサイトの別のポートのページからも同じことができてしまうので、サーバーは断る。
// 持ち主がアドレス欄に入力・貼り付けて開く移動は Sec-Fetch-Site: none なので通る。だから新しいアドレスは文字で見せ、リンクにはしない
export type ApplyStep = { kind: 'moved'; url: string; restartRequired: boolean } | { kind: 'stay'; restartRequired: boolean };

// 新しいアドレスには、いま開いている画面の場所（# 以降）も付ける
export function applyStep(result: ServerApplyResult, hash: string): ApplyStep {
  if (result.url) return { kind: 'moved', url: `${result.url.replace(/\/+$/u, '')}/${hash}`, restartRequired: result.restartRequired };
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
