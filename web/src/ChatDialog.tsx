import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeLayer } from './hooks.ts';
import { Icon } from './icons.tsx';
import { useT } from './i18n/index.ts';

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

interface Props {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  wide?: boolean;
  actions: ReactNode;
  onClose: () => void;
  children?: ReactNode;
}

export function ChatDialog({ eyebrow, title, subtitle, wide, actions, onClose, children }: Props) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  useEscapeLayer('dialog', true, onClose);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  function trapTab(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'Tab' || !root.current) return;
    const items = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) { e.preventDefault(); return; }
    if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  // 開いている画面の中に置くと、画面が動いている最中（transform）は fixed の基準がその画面になってしまう。枠（.shell）の直下へ出す
  const host = document.querySelector('.shell') ?? document.body;
  return createPortal(
    <>
      <div className="chat-dialog-backdrop" onClick={onClose} />
      <div className="chat-dialog-wrap">
        <div ref={root} className={`dialog chat-dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" tabIndex={-1} onKeyDown={trapTab}>
          <div className="chat-dialog-head">
            <div className="chat-dialog-titles">
              {eyebrow && <span className="chat-dialog-eyebrow">{eyebrow}</span>}
              <span className="dialog-title">{title}</span>
              {subtitle && <span className="chat-dialog-sub">{subtitle}</span>}
            </div>
            <button type="button" className="btn btn-ghost btn-icon chat-dialog-close" onClick={onClose} aria-label={t('approval.close')}><Icon name="x" size={16} /></button>
          </div>
          {children}
          <div className="dialog-actions chat-dialog-actions">{actions}</div>
        </div>
      </div>
    </>,
    host,
  );
}
