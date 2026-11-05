import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../icons.tsx';
import { formatNumber, useT } from '../i18n/index.ts';
import { isComposing } from '../keys.ts';
import { addTag, parseNumber } from './model.ts';

// 設定の 1 行（デザインの並び: 左に名前・説明・エラー、右に入力）。changed の点は「保存していない変更」。
export function FieldRow({ label, desc, error, changed, path, children }: { label: string; desc?: string; error?: string | undefined; changed?: boolean; path?: string; children: ReactNode }) {
  const t = useT();
  return (
    <div className="set-row" data-field={path}>
      <div className="set-row-text">
        <div className="set-row-label"><span>{label}</span>{changed && <span className="set-dot" role="img" aria-label={t('settings.field.changed')} />}</div>
        {desc && <span className="set-row-desc">{desc}</span>}
        {error && <span className="set-row-error" role="alert">{error}</span>}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

export function NumberField({ value, onChange, unit, optional, min, max, width, label, invalid }: {
  value: number | undefined; onChange: (value: number | undefined) => void; unit?: string; optional?: boolean; min?: number; max?: number; width?: string; label: string; invalid?: boolean;
}) {
  const show = (v: number | undefined) => (v === undefined ? '' : String(v));
  const [text, setText] = useState(show(value));
  useEffect(() => { if (parseNumber(text) !== value) setText(show(value)); }, [value]);
  return (
    <div className="set-num-wrap">
      <input
        className="input set-num" type="number" inputMode="numeric" value={text} min={min} max={max} aria-label={label} aria-invalid={invalid || undefined}
        style={width ? { width } : undefined}
        onChange={e => {
          setText(e.target.value);
          const n = parseNumber(e.target.value);
          if (n === null || (n === undefined && !optional)) return;
          onChange(n);
        }}
        onBlur={() => setText(show(value))}
      />
      {unit && <span className="set-unit">{unit}</span>}
    </div>
  );
}

export function TextField({ value, onChange, mono, placeholder, label, invalid, onCommit }: {
  value: string; onChange?: (value: string) => void; mono?: boolean; placeholder?: string; label: string; invalid?: boolean; onCommit?: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  return (
    <input
      className={`input set-text${mono ? ' mono' : ''}`} value={text} placeholder={placeholder} aria-label={label} aria-invalid={invalid || undefined} spellCheck={false}
      onChange={e => { setText(e.target.value); onChange?.(e.target.value); }}
      onBlur={() => onCommit?.(text)}
      onKeyDown={e => { if (e.key === 'Enter' && !isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) onCommit?.(text); }}
    />
  );
}

export interface SegOption<V extends string | boolean> { value: V; label: string }

export function SegField<V extends string | boolean>({ value, options, onChange, label }: { value: V | undefined; options: ReadonlyArray<SegOption<V>>; onChange: (value: V) => void; label: string }) {
  const name = useId();
  return (
    <div className="seg set-seg" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <label className="seg-opt" key={String(option.value)}>
          <input type="radio" name={name} checked={value === option.value} onChange={() => onChange(option.value)} />
          {option.label}
        </label>
      ))}
    </div>
  );
}

export function RangeField({ from, to, onChange, label }: { from: string; to: string; onChange: (from: string, to: string) => void; label: string }) {
  return (
    <div className="set-range">
      <input className="input" type="time" value={from} aria-label={`${label} (1)`} onChange={e => onChange(e.target.value, to)} />
      <span className="set-range-sep">–</span>
      <input className="input" type="time" value={to} aria-label={`${label} (2)`} onChange={e => onChange(from, e.target.value)} />
    </div>
  );
}

export function TagsField({ tags, onChange, placeholder, label }: { tags: readonly string[]; onChange: (tags: string[]) => void; placeholder?: string; label: string }) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const commit = () => { if (draft.trim()) onChange(addTag(tags, draft)); setDraft(''); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); commit(); }
    else if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
  };
  return (
    <div className="set-tags">
      {tags.map(tag => (
        <span className="tag tag-neutral set-tag" key={tag}>
          {tag}
          <button type="button" onClick={() => onChange(tags.filter(x => x !== tag))} aria-label={`${t('settings.tag.remove')}: ${tag}`}><Icon name="x" size={10} /></button>
        </span>
      ))}
      <input className="set-tag-input" value={draft} placeholder={placeholder} aria-label={t('settings.tag.add', label)} spellCheck={false} onChange={e => setDraft(e.target.value)} onKeyDown={onKey} onBlur={commit} />
    </div>
  );
}

export function ColorField({ value, onChange, fallback, label }: { value: string; onChange: (value: string) => void; fallback: string; label: string }) {
  const t = useT();
  const [hex, setHex] = useState(value);
  useEffect(() => { setHex(value); }, [value]);
  const valid = /^#[0-9a-fA-F]{6}$/u.test(hex);
  return (
    <div className="set-color">
      <input type="color" className="set-color-swatch" value={/^#[0-9a-fA-F]{6}$/u.test(value) ? value : fallback} aria-label={label} onChange={e => onChange(e.target.value.toUpperCase())} />
      <input className="input set-text mono set-hex" value={hex} aria-label={label} aria-invalid={!valid || undefined} spellCheck={false}
        onChange={e => { setHex(e.target.value); if (/^#[0-9a-fA-F]{6}$/u.test(e.target.value)) onChange(e.target.value.toUpperCase()); }}
        onBlur={() => setHex(value)} />
      <button type="button" className="set-link" onClick={() => onChange(fallback)}>{t('settings.field.reset')}</button>
    </div>
  );
}

export function SubTitle({ children }: { children: ReactNode }) { return <span className="set-subtitle">{children}</span>; }
