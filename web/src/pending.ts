import { useCallback, useState } from 'react';

// 送信中のもの（タスクの id・操作の名前など）を覚えておき、同じものへの 2 回目の送信を止める。
// 画面の状態（useState）は描き直しのあとに変わるので、Enter を続けて押した 2 回目には間に合わない。
// そのため「いま送信中か」はこの入れ物が持ち、描き直しのために写しだけを状態に置く。
export class PendingSet {
  readonly #keys = new Set<string>();

  // 始められたら true。すでに送信中なら false（何もしない）。
  begin(key: string): boolean {
    if (this.#keys.has(key)) return false;
    this.#keys.add(key);
    return true;
  }

  end(key: string): void { this.#keys.delete(key); }
  has(key: string): boolean { return this.#keys.has(key); }
  snapshot(): ReadonlySet<string> { return new Set(this.#keys); }
}

// key が送信中なら何もせず undefined を返す。そうでなければ fn を実行し、終わる（失敗でも）まで key を送信中にする。
export async function runOnce<T>(set: PendingSet, key: string, fn: () => Promise<T>, changed: () => void = () => undefined): Promise<T | undefined> {
  if (!set.begin(key)) return undefined;
  changed();
  try { return await fn(); } finally { set.end(key); changed(); }
}

export interface PendingRunner {
  pending: ReadonlySet<string>;
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T | undefined>;
}

export function usePending(): PendingRunner {
  const [core] = useState(() => new PendingSet());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const run = useCallback(<T,>(key: string, fn: () => Promise<T>) => runOnce(core, key, fn, () => setPending(core.snapshot())), [core]);
  return { pending, run };
}
