import { useState } from 'react';
import { api, ApiError, type Conversation } from './api.ts';
import { ChatDialog } from './ChatDialog.tsx';
import { useT } from './i18n/index.ts';
import { isComposing } from './keys.ts';
import { toast } from './toast.tsx';

interface Props { conversation: Conversation; onClose: () => void; onRenamed: (id: string) => void }

// 左の一覧のメニューの「名前を変える」。入力欄の /rename と同じ API（題は 200 文字まで）
export function RenameDialog({ conversation, onClose, onRenamed }: Props) {
  const t = useT();
  const [value, setValue] = useState(conversation.title ?? '');
  const [busy, setBusy] = useState(false);
  const title = value.trim();
  async function save(): Promise<void> {
    if (!title || busy) return;
    setBusy(true);
    try {
      await api.renameConversation(conversation.id, title.slice(0, 200));
      toast({ kind: 'info', icon: 'pencil', title: t('chat.rename.done'), body: title });
      onRenamed(conversation.id);
      onClose();
    } catch (error) {
      setBusy(false);
      toast({ kind: 'info', icon: 'alert', title: t('chat.rename.failed'), ...(error instanceof ApiError ? { body: error.message } : {}) });
    }
  }
  return (
    <ChatDialog
      title={t('conv.rename')} onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn btn-ghost chat-plain" onClick={onClose}>{t('chat.archive.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={!title || busy} onClick={() => void save()}>{t('conv.renameSave')}</button>
        </>
      )}
    >
      <input
        className="input conv-rename-input" value={value} maxLength={200} autoFocus aria-label={t('conv.renameLabel')}
        onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !isComposing(e.nativeEvent)) { e.preventDefault(); void save(); } }}
      />
    </ChatDialog>
  );
}
