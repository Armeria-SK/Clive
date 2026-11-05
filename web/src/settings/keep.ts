import { applyEdits, diffConfig } from './merge.ts';
import { countChanges, type Config } from './model.ts';

// 設定のモーダルが、保存していない編集を持ったまま閉じられたとき（戻る・トーストの操作・パレット・通知のリンクなど）に残すもの。
export interface KeptEdits { saved: Config; draft: Config }

export function editsToKeep(saved: Config | null, draft: Config | null): KeptEdits | null {
  return saved && draft && countChanges(saved, draft) > 0 ? { saved, draft } : null;
}

// 開き直したとき、残していた編集を最新の設定へ当て直す。ぶつかる所があれば、残していた画面のまま返し、保存の合流が衝突として知らせる。
export function restoreKept(kept: KeptEdits | null, latest: Config): { saved: Config; draft: Config; restored: boolean } {
  const fresh = { saved: latest, draft: latest, restored: false };
  if (!kept || countChanges(kept.saved, kept.draft) === 0) return fresh;
  const merged = applyEdits(latest, diffConfig(kept.saved, kept.draft));
  if (merged.conflicts.length) return { saved: kept.saved, draft: kept.draft, restored: true };
  return countChanges(latest, merged.config) > 0 ? { saved: latest, draft: merged.config, restored: true } : fresh;
}
