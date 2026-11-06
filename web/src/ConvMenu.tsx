import type { Conversation } from './api.ts';
import { useEscapeLayer } from './hooks.ts';
import { useT } from './i18n/index.ts';
import { Icon, type IconName } from './icons.tsx';

interface Props {
  conversation: Conversation;
  onClose: () => void;
  onRename: (conversation: Conversation) => void;
  onSummary: (conversation: Conversation) => void;
  onArchive: (conversation: Conversation) => void;
}

// 左の一覧の会話の行のメニュー（行にポインタを乗せたときの「…」・右クリック・長押しで開く）
export function ConvMenu({ conversation, onClose, onRename, onSummary, onArchive }: Props) {
  const t = useT();
  useEscapeLayer('model', true, onClose);
  const item = (icon: IconName, label: string, run: (c: Conversation) => void) => (
    <button type="button" role="menuitem" className="conv-menu-item" onClick={() => { onClose(); run(conversation); }}>
      <Icon name={icon} size={14} />{label}
    </button>
  );
  return (
    <>
      <button type="button" className="model-menu-backdrop" aria-label={t('approval.close')} tabIndex={-1} onClick={onClose} />
      <div className="conv-menu" role="menu" aria-label={t('conv.menu')}>
        {item('pencil', t('conv.rename'), onRename)}
        {conversation.has_summary && item('info', t('conv.summary'), onSummary)}
        {item('archive', t('conv.archive'), onArchive)}
      </div>
    </>
  );
}
