import { useEffect, useState } from 'react';
import { api, type ContextUsage } from './api.ts';

// 会話の使用量。取り直すのは、会話を開いたとき・trigger が変わったとき（返事が終わったとき）だけで、入力中には呼ばない。
// 会話が変わったら前の数は捨てる。読めなければ null（輪は出さない）
export function useContextUsage(conversationId: string | null, trigger: number): ContextUsage | null {
  const [state, setState] = useState<{ id: string; usage: ContextUsage } | null>(null);
  useEffect(() => {
    if (!conversationId) return undefined;
    let live = true;
    void api.contextUsage(conversationId).then(
      usage => { if (live) setState({ id: conversationId, usage }); },
      () => { if (live) setState(null); },
    );
    return () => { live = false; };
  }, [conversationId, trigger]);
  return conversationId && state?.id === conversationId ? state.usage : null;
}
