import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { registerEscapeUnlessInert, saveKeyHandler, useInert } from './inert.ts';
import type { EscLayer } from './keys.ts';
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
  const inert = useInert();
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => (active ? registerEscapeUnlessInert(layer, () => latest.current(), inert) : undefined), [layer, active, inert]);
}

// ⌘/Ctrl+S。マウントされている間だけ、ブラウザの「ページを保存」を止めて onSave を呼ぶ。
export function useSaveShortcut(onSave: () => void): void {
  const isInert = useInert();
  const inert = useRef(isInert);
  inert.current = isInert;
  const latest = useRef(onSave);
  latest.current = onSave;
  useEffect(() => {
    const onKey = saveKeyHandler(() => inert.current, () => latest.current());
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// 閉じるときの動きが終わるまで、部品を残しておく。open が false になってから ms のあいだは leaving が true。
export function useExit(open: boolean, ms: number): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return undefined; }
    const timer = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(timer);
  }, [open, ms]);
  return { mounted: open || mounted, leaving: !open && mounted };
}
