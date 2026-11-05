import { useEffect, useState } from 'react';
import { api, type ConversationSummary } from './api.ts';
import { ChatDialog } from './ChatDialog.tsx';
import { useT } from './i18n/index.ts';
import { Markdown } from './Markdown.tsx';

interface Props { conversationId: string; title: string | null; onClose: () => void }

// 会話の要約（古い部分を置き換えたもの）を読むだけの窓。直せない・消せない
export function SummaryDialog({ conversationId, title, onClose }: Props) {
  const t = useT();
  const [state, setState] = useState<{ summary: ConversationSummary } | { failed: true } | null>(null);
  useEffect(() => {
    let live = true;
    void api.summary(conversationId).then(summary => { if (live) setState({ summary }); }, () => { if (live) setState({ failed: true }); });
    return () => { live = false; };
  }, [conversationId]);
  const summary = state && 'summary' in state ? state.summary : null;
  return (
    <ChatDialog
      title={t('summary.title')} subtitle={title ?? t('conversation.untitled')} wide onClose={onClose}
      actions={<button type="button" className="btn btn-secondary" onClick={onClose}>{t('summary.close')}</button>}
    >
      {state === null && <p className="chat-dialog-text">{t('summary.loading')}</p>}
      {state !== null && 'failed' in state && <p className="chat-dialog-text" role="alert">{t('summary.failed')}</p>}
      {summary && summary.summary === null && <p className="chat-dialog-text">{t('summary.empty')}</p>}
      {summary && summary.summary !== null && (
        <>
          <p className="chat-dialog-text">{t('summary.count', summary.summarizedMessages)}</p>
          <div className="summary-body"><Markdown text={summary.summary} /></div>
          <p className="chat-dialog-text">{t('summary.note')}</p>
        </>
      )}
    </ChatDialog>
  );
}
