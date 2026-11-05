import { useState, type KeyboardEvent } from 'react';
import { useSaveShortcut } from './hooks.ts';
import { Icon } from './icons.tsx';
import { useT } from './i18n/index.ts';
import { isComposing, modLabel } from './keys.ts';
import { addDeny, addRoot, removeDeny, removeRoot, setRootMode, type FolderDraft, type RootMode } from './skills-meta.ts';

interface Props {
  draft: FolderDraft;
  outside: 'ask' | 'deny';
  dirty: boolean;
  busy: boolean;
  problems: string[];
  onChange: (next: FolderDraft) => void;
  onSave: () => void;
  onRevert: () => void;
}

const MODES: readonly RootMode[] = ['write', 'read'];

export function FoldersPanel({ draft, outside, dirty, busy, problems, onChange, onSave, onRevert }: Props) {
  const t = useT();
  const [path, setPath] = useState('');
  const [deny, setDeny] = useState('');
  useSaveShortcut(() => { if (dirty && !busy) onSave(); });

  const submitPath = () => { onChange(addRoot(draft, path, 'read')); setPath(''); };
  const submitDeny = () => { onChange(addDeny(draft, deny)); setDeny(''); };
  const enter = (submit: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); submit(); }
  };

  return (
    <div className="sk-folders">
      <section className="sk-group">
        <span className="sk-label">{t('folders.allowed')}</span>
        {!draft.roots.length && <p className="sk-note">{t('folders.empty')}</p>}
        {draft.roots.map(root => (
          <div className="sk-folder" key={root.path}>
            <span className="sk-folder-icon"><Icon name="folder" size={15} /></span>
            <span className="sk-folder-path">{root.path}</span>
            <div className="seg sk-seg-small" role="radiogroup" aria-label={t('folders.modeLabel', root.path)}>
              {MODES.map(mode => (
                <label className="seg-opt" key={mode}>
                  <input type="radio" name={`folder-${root.path}`} checked={root.mode === mode} onChange={() => onChange(setRootMode(draft, root.path, mode))} />
                  {t(mode === 'write' ? 'folders.mode.write' : 'folders.mode.read')}
                </label>
              ))}
            </div>
            <button className="btn btn-ghost btn-icon sk-remove" onClick={() => onChange(removeRoot(draft, root.path))} aria-label={t('folders.remove', root.path)}><Icon name="x" size={14} /></button>
          </div>
        ))}
        <div className="sk-add">
          <input className="input sk-mono" value={path} onChange={e => setPath(e.target.value)} onKeyDown={enter(submitPath)} placeholder={t('folders.pathPlaceholder')} aria-label={t('folders.addPath')} spellCheck={false} />
          <button className="btn btn-secondary" onClick={submitPath} disabled={!path.trim()}><Icon name="plus" size={13} />{t('folders.add')}</button>
        </div>
      </section>

      <section className="sk-group">
        <span className="sk-label">{t('folders.denied')}</span>
        {!draft.deny.length && <p className="sk-note">{t('folders.denyEmpty')}</p>}
        <div className="sk-tags">
          {draft.deny.map(item => (
            <span className="tag tag-outline sk-deny" key={item}>
              {item}
              <button className="sk-deny-x" onClick={() => onChange(removeDeny(draft, item))} aria-label={t('folders.remove', item)}><Icon name="x" size={10} /></button>
            </span>
          ))}
        </div>
        <div className="sk-add">
          <input className="input sk-mono" value={deny} onChange={e => setDeny(e.target.value)} onKeyDown={enter(submitDeny)} placeholder={t('folders.denyPlaceholder')} aria-label={t('folders.addDeny')} spellCheck={false} />
          <button className="btn btn-secondary" onClick={submitDeny} disabled={!deny.trim()}><Icon name="plus" size={13} />{t('folders.add')}</button>
        </div>
        <span className="sk-hint">{t(outside === 'deny' ? 'folders.outsideDeny' : 'folders.outsideAsk')}</span>
      </section>

      {problems.length > 0 && (
        <div className="sk-problems" role="alert">
          <ul>{problems.map(p => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {dirty && (
        <div className="sk-savebar">
          <span>{t('folders.dirty')}</span>
          <button className="btn btn-ghost sk-plain" onClick={onRevert} disabled={busy}>{t('folders.revert')}</button>
          <button className="btn btn-primary" onClick={onSave} disabled={busy}>{t('folders.save')}<span className="sk-kbd">{modLabel()}S</span></button>
        </div>
      )}
    </div>
  );
}
