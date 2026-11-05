import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { registerEscape, shortcutOf, type EscLayer } from './keys.ts';
import { getEffectiveTheme, getThemeMode, subscribeTheme, type ThemeMode, type ThemeName } from './theme.ts';

export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

export function useTheme(): { mode: ThemeMode; effective: ThemeName } {
  const effective = useSyncExternalStore(subscribeTheme, getEffectiveTheme);
  const mode = useSyncExternalStore(subscribeTheme, getThemeMode);
  return { mode, effective };
}

export function useEscapeLayer(layer: EscLayer, active: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => (active ? registerEscape(layer, () => latest.current()) : undefined), [layer, active]);
}

// ⌘/Ctrl+S。マウントされている間だけ、ブラウザの「ページを保存」を止めて onSave を呼ぶ。
export function useSaveShortcut(onSave: () => void): void {
  const latest = useRef(onSave);
  latest.current = onSave;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shortcutOf(e) !== 'save') return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
