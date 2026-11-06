import { api, ApiError } from './api.ts';
import type { useT } from './i18n/index.ts';
import { toast } from './toast.tsx';

export type ConversationChange = { kind: 'renamed' | 'archived' | 'unarchived' | 'model' | 'mode' | 'deleted'; id: string };
type T = ReturnType<typeof useT>;

// 会話の画面（/archive）と左の一覧のメニューで同じ動きにする。アーカイブは確かめなしで、トーストの「元に戻す」で戻せる
export async function unarchiveConversation(id: string, t: T, onChanged: (change: ConversationChange) => void): Promise<void> {
  try {
    await api.unarchiveConversation(id);
    toast({ kind: 'info', icon: 'undo', title: t('chat.unarchive.done') });
    onChanged({ kind: 'unarchived', id });
  } catch (error) {
    toast({ kind: 'info', icon: 'alert', title: t('chat.unarchive.failed'), ...(error instanceof ApiError ? { body: error.message } : {}) });
  }
}

export async function archiveConversation(id: string, title: string | null, t: T, onChanged: (change: ConversationChange) => void): Promise<void> {
  try {
    await api.archiveConversation(id);
    toast({
      kind: 'info', icon: 'archive', title: t('chat.archive.done'), ...(title ? { body: title } : {}),
      action: { label: t('chat.archive.undo'), run: () => { void unarchiveConversation(id, t, onChanged); } },
    });
    onChanged({ kind: 'archived', id });
  } catch (error) {
    toast({ kind: 'info', icon: 'alert', title: t('chat.archive.failed'), ...(error instanceof ApiError ? { body: error.message } : {}) });
  }
}
