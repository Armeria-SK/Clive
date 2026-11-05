import { createContext, useContext } from 'react';
import { registerEscape, shortcutOf, type EscLayer, type ShortcutEvent } from './keys.ts';

// 設定のモーダルが開いているあいだ、後ろのページ（.shell-body の中）は true。Esc の重なりと ⌘/Ctrl+S は、true のあいだ受け付けない。
export const InertContext = createContext(false);
export const useInert = (): boolean => useContext(InertContext);

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
