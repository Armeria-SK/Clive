import type { ModelView } from './api.ts';
import { useEscapeLayer } from './hooks.ts';
import { useT } from './i18n/index.ts';
import { Icon } from './icons.tsx';

// 入力欄や状態バーのモデルの札を押したときに開く一覧。「自動（設定の順番）」と設定のモデル全部。確認の結果が使えないものは選べない。
// そのモデルが受け付ける考える深さ（efforts）があれば、その下に並べる（無いモデルには出さない）。
export const OPEN_MODEL_MENU_EVENT = 'clive:open-model-menu';

interface Props {
  models: readonly ModelView[];
  selected: string | null;
  effort: string | null;
  efforts: readonly string[];
  onModel: (id: string | null) => void;
  onEffort: (effort: string | null) => void;
  onClose: () => void;
}

export function ModelMenu({ models, selected, effort, efforts, onModel, onEffort, onClose }: Props) {
  const t = useT();
  useEscapeLayer('model', true, onClose);
  return (
    <>
      <button type="button" className="model-menu-backdrop" aria-label={t('approval.close')} tabIndex={-1} onClick={onClose} />
      <div className="model-menu" role="dialog" aria-label={t('model.menu')}>
        <div className="model-menu-title">{t('model.menu')}</div>
        <div role="listbox" aria-label={t('model.menu')}>
          <button type="button" role="option" aria-selected={selected === null} className={`model-menu-item${selected === null ? ' selected' : ''}`} onClick={() => onModel(null)}>
            <span className="model-menu-main"><span className="model-menu-name">{t('model.auto')}</span><span className="model-menu-sub">{t('model.autoDesc')}</span></span>
            {selected === null && <Icon name="check" size={14} />}
          </button>
          {models.map(model => {
            const usable = model.probe?.status === 'ok';
            const isSelected = selected === model.id;
            return (
              <button
                key={model.id} type="button" role="option" aria-selected={isSelected} aria-disabled={!usable && !isSelected}
                className={`model-menu-item${isSelected ? ' selected' : ''}`} disabled={!usable && !isSelected} onClick={() => onModel(model.id)}
              >
                <span className="model-menu-main">
                  <span className="model-menu-name">{model.label}</span>
                  <span className="model-menu-sub">{usable ? model.model : `${model.model} · ${t('model.unavailable')}`}</span>
                </span>
                {isSelected && <Icon name="check" size={14} />}
              </button>
            );
          })}
        </div>
        {efforts.length > 0 && (
          <>
            <div className="model-menu-title">{t('model.effort')}</div>
            <div role="listbox" aria-label={t('model.effort')}>
              {[null, ...efforts].map(value => (
                <button key={value ?? 'default'} type="button" role="option" aria-selected={effort === value} className={`model-menu-item${effort === value ? ' selected' : ''}`} onClick={() => onEffort(value)}>
                  <span className="model-menu-main"><span className="model-menu-name">{value ?? t('model.effortDefault')}</span></span>
                  {effort === value && <Icon name="check" size={14} />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
