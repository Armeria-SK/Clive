import { useEffect, useState } from 'react';

interface Tip { x: number; y: number; transform: string; text: string; kbd: string }

const SHOW_DELAY_MS = 200;
const WARM_MS = 300;
const EDGE = 70;

function place(el: Element, text: string): Tip {
  const rect = el.getBoundingClientRect();
  const where = el.getAttribute('data-tip-pos') ?? 'above';
  const cx = Math.max(EDGE, Math.min(window.innerWidth - EDGE, rect.left + rect.width / 2));
  const kbd = el.getAttribute('data-kbd') ?? '';
  if (where === 'right') return { x: rect.right + 8, y: rect.top + rect.height / 2, transform: 'translateY(-50%)', text, kbd };
  if (where === 'below') return { x: cx, y: rect.bottom + 6, transform: 'translateX(-50%)', text, kbd };
  return { x: cx, y: rect.top - 6, transform: 'translate(-50%, -100%)', text, kbd };
}

// data-tip / data-kbd / data-tip-pos を持つ要素の上にマウスを置くと、小さな説明を出す。
export function Tooltip({ disabled }: { disabled: boolean }) {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    if (disabled) { setTip(null); return undefined; }
    let target: Element | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let warmUntil = 0;
    let shown = false;
    const hide = () => {
      clearTimeout(timer);
      target = null;
      if (shown) warmUntil = Date.now() + WARM_MS;
      shown = false;
      setTip(null);
    };
    const over = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
      if (!el || el === target) return;
      const text = el.getAttribute('data-tip');
      if (!text) return;
      target = el;
      clearTimeout(timer);
      const show = () => { if (target === el && el.isConnected) { shown = true; setTip(place(el, text)); } };
      if (Date.now() < warmUntil) show(); else timer = setTimeout(show, SHOW_DELAY_MS);
    };
    const out = (e: MouseEvent) => {
      if (!target) return;
      const to = e.relatedTarget;
      if (to instanceof Node && target.contains(to)) return;
      hide();
    };
    document.addEventListener('mouseover', over);
    document.addEventListener('mouseout', out);
    document.addEventListener('mousedown', hide);
    document.addEventListener('keydown', hide);
    document.addEventListener('scroll', hide, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mouseover', over);
      document.removeEventListener('mouseout', out);
      document.removeEventListener('mousedown', hide);
      document.removeEventListener('keydown', hide);
      document.removeEventListener('scroll', hide, true);
    };
  }, [disabled]);

  if (!tip) return null;
  return (
    <div className="tooltip" role="tooltip" style={{ left: tip.x, top: tip.y, transform: tip.transform }}>
      {tip.text}
      {tip.kbd && <span className="tooltip-kbd">{tip.kbd}</span>}
    </div>
  );
}
