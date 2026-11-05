export type LayoutMode = 'narrow' | 'mid' | 'wide';

export const NARROW_BELOW = 760;
export const MID_BELOW = 1180;

export function layoutModeFor(width: number): LayoutMode {
  if (width < NARROW_BELOW) return 'narrow';
  return width < MID_BELOW ? 'mid' : 'wide';
}

const PANEL_KEY = 'clive.rightPane';

export function loadPanelPreference(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): boolean {
  try { return storage?.getItem(PANEL_KEY) === '1'; } catch { return false; }
}

export function savePanelPreference(open: boolean, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try { storage?.setItem(PANEL_KEY, open ? '1' : '0'); } catch { }
}

function safeStorage(): Storage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}
