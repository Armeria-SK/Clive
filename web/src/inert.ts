import { createContext, useContext, type CSSProperties } from 'react';
import { registerEscape, shortcutOf, type EscLayer, type ShortcutEvent } from './keys.ts';

// 設定のモーダルが開いているあいだ、後ろのページ（.shell-body の中）は true。Esc の重なりと ⌘/Ctrl+S は、true のあいだ受け付けない。
export const InertContext = createContext(false);
export const useInert = (): boolean => useContext(InertContext);

// 画面全体に重ねる窓（確かめ・スキルの窓・新しいタスク）は枠（.shell）の直下へ出るので、設定のモーダルと同じ高さに並ぶ。後ろの窓は、設定が開いているあいだ隠す。
export const hideWhenInert = (inert: boolean): CSSProperties | undefined => (inert ? { display: 'none' } : undefined);

export function registerEscapeUnlessInert(layer: EscLayer, close: () => void, inert: boolean): (() => void) | undefined {
  return inert ? undefined : registerEscape(layer, close);
}

export function saveKeyHandler(isInert: () => boolean, onSave: () => void): (e: ShortcutEvent & { preventDefault: () => void }) => void {
  return e => {
    if (isInert() || shortcutOf(e) !== 'save') return;
    e.preventDefault();
    onSave();
  };
}
