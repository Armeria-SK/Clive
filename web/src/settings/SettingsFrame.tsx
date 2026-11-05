import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../icons.tsx';

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

// 設定の窓の枠。画面の上に重ね、背景を押す・× を押すと onClose。Tab は窓の中を巡り、閉じたあとは開く前にいた場所へフォーカスを戻す。
// Esc は呼び出し側（Settings）が重なりの順番（keys.ts の 'settings'）に登録する。
export function SettingsFrame({ leaving, label, closeLabel, onClose, children }: { leaving: boolean; label: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    box.current?.focus();
    return () => { if (before instanceof HTMLElement && before.isConnected) before.focus(); };
  }, []);
  const trap = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) { e.preventDefault(); return; }
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <>
      <div className={`set-backdrop${leaving ? ' leaving' : ''}`} onClick={onClose} />
      <div className="set-wrap">
        <div ref={box} className={`set-modal${leaving ? ' leaving' : ''}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={trap}>
          {children}
          <button type="button" className="btn btn-ghost btn-icon set-close" aria-label={closeLabel} onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
      </div>
    </>
  );
}
