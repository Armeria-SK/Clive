import { useState } from 'react';
import { api, ApiError, type Conversation } from './api.ts';
import { ChatDialog } from './ChatDialog.tsx';
import { useT } from './i18n/index.ts';
import { toast } from './toast.tsx';

interface Props { conversation: Conversation; onClose: () => void; onDeleted: (id: string) => void }

const GOES = ['delete.goes1', 'delete.goes2', 'delete.goes3', 'delete.goes4'] as const;
const STAYS = ['delete.stays1', 'delete.stays2', 'delete.stays3'] as const;

// 会話の削除の確かめ。元に戻せないので、消えるものと残るものを並べて見せてから消す
export function DeleteDialog({ conversation, onClose, onDeleted }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  async function remove(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await api.deleteConversation(conversation.id);
      toast({ kind: 'info', icon: 'circleCheck', title: t('delete.done'), body: conversation.title ?? t('conversation.untitled') });
      onDeleted(conversation.id);
      onClose();
    } catch (error) {
      setBusy(false);
      toast({ kind: 'info', icon: 'alert', title: t('delete.failed'), ...(error instanceof ApiError ? { body: error.message } : {}) });
    }
  }
  return (
    <ChatDialog
      title={t('delete.title')} onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn btn-ghost chat-plain" onClick={onClose}>{t('chat.archive.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void remove()}>{t('delete.confirm')}</button>
        </>
      )}
    >
      <p className="chat-dialog-text">{t('delete.body', conversation.title ?? t('conversation.untitled'))}</p>
      <div className="delete-lists">
        <div>
          <strong className="delete-head">{t('delete.goes')}</strong>
          <ul className="delete-list">{GOES.map(key => <li key={key}>{t(key)}</li>)}</ul>
        </div>
        <div>
          <strong className="delete-head">{t('delete.stays')}</strong>
          <ul className="delete-list">{STAYS.map(key => <li key={key}>{t(key)}</li>)}</ul>
        </div>
      </div>
      <p className="chat-dialog-text">{t('delete.hint')}</p>
    </ChatDialog>
  );
}
