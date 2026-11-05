// Esc は、開いている重なりを前から順に 1 つだけ閉じる。どれも開いていなければ呼び出し側の既定の動き（返事を止める）に回す。
export const ESC_ORDER = ['palette', 'dialog', 'notification', 'model', 'sheet', 'drawer'] as const;
export type EscLayer = (typeof ESC_ORDER)[number];

const open = new Map<EscLayer, () => void>();

export function registerEscape(layer: EscLayer, close: () => void): () => void {
  open.set(layer, close);
  return () => { if (open.get(layer) === close) open.delete(layer); };
}

export function closeTopLayer(): boolean {
  for (const layer of ESC_ORDER) {
    const close = open.get(layer);
    if (close) { close(); return true; }
  }
  return false;
}

// 日本語の変換中のキーは、変換のためのもの。Esc も Enter も、画面の操作として扱わない。
export function isComposing(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return e.isComposing === true || e.keyCode === 229;
}

export interface ShortcutEvent { key: string; metaKey: boolean; ctrlKey: boolean; isComposing?: boolean; keyCode?: number }
export type ShortcutAction = 'togglePanel' | 'escape' | 'save' | 'palette';

export function shortcutOf(e: ShortcutEvent): ShortcutAction | null {
  if (isComposing(e)) return null;
  const key = e.key.toLowerCase();
  if (key === 'escape') return 'escape';
  if (e.metaKey || e.ctrlKey) {
    if (key === '/') return 'togglePanel';
    if (key === 's') return 'save';
    if (key === 'k') return 'palette';
  }
  return null;
}

export function modLabel(platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return /mac|iphone|ipad/iu.test(platform) ? '⌘' : 'Ctrl+';
}
