import { PERMISSION_MODES, type PermissionMode } from '../../src/shared/permission-mode.ts';
import { useEscapeLayer } from './hooks.ts';
import { useT } from './i18n/index.ts';
import { Icon, type IconName } from './icons.tsx';

// 入力欄や状態バーのモードの札を押したときに開く一覧。権限モード（ふつう / 自動承認 / 計画）は会話ごとに覚える。
export const OPEN_MODE_MENU_EVENT = 'clive:open-mode-menu';

export const MODE_ICON: Record<PermissionMode, IconName> = { normal: 'shield', auto: 'play', plan: 'file' };

interface Props {
  selected: PermissionMode;
  onSelect: (mode: PermissionMode) => void;
  onClose: () => void;
}

export function ModeMenu({ selected, onSelect, onClose }: Props) {
  const t = useT();
  // モデルの一覧とは同時に開かないので、Esc の層は同じものを使う
  useEscapeLayer('model', true, onClose);
  return (
    <>
      <button type="button" className="model-menu-backdrop" aria-label={t('approval.close')} tabIndex={-1} onClick={onClose} />
      <div className="model-menu mode-menu" role="dialog" aria-label={t('mode.menu')}>
        <div className="model-menu-title">{t('mode.menu')}</div>
        <div role="listbox" aria-label={t('mode.menu')}>
          {PERMISSION_MODES.map(mode => (
            <button
              key={mode} type="button" role="option" aria-selected={selected === mode}
              className={`model-menu-item mode-menu-item mode-${mode}${selected === mode ? ' selected' : ''}`} onClick={() => onSelect(mode)}
            >
              <span className="mode-menu-icon"><Icon name={MODE_ICON[mode]} size={14} /></span>
              <span className="model-menu-main">
                <span className="model-menu-name">{t(`mode.${mode}`)}</span>
                <span className="mode-menu-desc">{t(`mode.${mode}Desc`)}</span>
              </span>
              {selected === mode && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
