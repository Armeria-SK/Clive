import { useId, useState, type KeyboardEvent } from 'react';
import { Icon } from '../icons.tsx';
import { useT } from '../i18n/index.ts';
import { isComposing } from '../keys.ts';
import { addRoot, removeRoot, setRootMode, type Root, type RootMode } from '../skills-meta.ts';

const MODES: readonly RootMode[] = ['write', 'read'];

// 触れてよいフォルダ（tools.roots）。保存・広がる変更の確かめ・ほかの場所の変更とのぶつかりは、設定の保存の仕組み（Settings.tsx）に任せる
export function RootsField({ roots, onChange }: { roots: readonly Root[]; onChange: (roots: Root[]) => void }) {
  const t = useT();
  const group = useId();
  const [path, setPath] = useState('');
  const folders = { roots: [...roots], deny: [] as string[] };
  const submit = () => { onChange(addRoot(folders, path, 'read').roots); setPath(''); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); submit(); }
  };
  return (
    <div className="set-roots">
      {!roots.length && <span className="set-note">{t('folders.empty')}</span>}
      {roots.map(root => (
        <div className="set-root" key={root.path}>
          <span className="set-root-icon"><Icon name="folder" size={15} /></span>
          <span className="set-root-path">{root.path}</span>
          <div className="seg set-seg" role="radiogroup" aria-label={t('folders.modeLabel', root.path)}>
            {MODES.map(mode => (
              <label className="seg-opt" key={mode}>
                <input type="radio" name={`${group}-${root.path}`} checked={root.mode === mode} onChange={() => onChange(setRootMode(folders, root.path, mode).roots)} />
                {t(mode === 'write' ? 'folders.mode.write' : 'folders.mode.read')}
              </label>
            ))}
          </div>
          <button type="button" className="btn btn-ghost btn-icon set-root-remove" onClick={() => onChange(removeRoot(folders, root.path).roots)} aria-label={t('folders.remove', root.path)}><Icon name="x" size={14} /></button>
        </div>
      ))}
      <div className="set-root-add">
        <input className="input set-text mono" value={path} onChange={e => setPath(e.target.value)} onKeyDown={onKey} placeholder={t('folders.pathPlaceholder')} aria-label={t('folders.addPath')} spellCheck={false} />
        <button type="button" className="btn btn-secondary" onClick={submit} disabled={!path.trim()}><Icon name="plus" size={13} />{t('folders.add')}</button>
      </div>
    </div>
  );
}
