import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Approval } from './api.ts';
import { decideApproval, useDecisionPending, type ApprovalDecision } from './approval-decide.ts';
import { approvalFraction, formatCountdown } from './chat-logic.ts';
import { ChatDialog } from './ChatDialog.tsx';
import { useNow } from './hooks.ts';
import { useT } from './i18n/index.ts';
import { Icon } from './icons.tsx';

let windowRequest: Promise<number | null> | null = null;

function loadApprovalWindow(): Promise<number | null> {
  windowRequest ??= api.settings()
    .then(settings => {
      const seconds = settings.config?.tools?.shell?.approvalTimeoutSec;
      return typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : null;
    })
    .catch(() => { windowRequest = null; return null; });
  return windowRequest;
}

function useApprovalWindow(approval: Approval): number {
  const [configured, setConfigured] = useState<number | null>(null);
  const seen = useRef(Date.now());
  useEffect(() => {
    let live = true;
    void loadApprovalWindow().then(ms => { if (live) setConfigured(ms); });
    return () => { live = false; };
  }, []);
  return configured ?? Math.max(approval.expiresAt - seen.current, 1);
}

function useDecision(approval: Approval) {
  const t = useT();
  const busy = useDecisionPending(approval.id);
  const [error, setError] = useState('');
  async function decide(decision: ApprovalDecision): Promise<void> {
    setError('');
    try { await decideApproval(approval.id, decision); }
    catch (e) { setError(e instanceof ApiError ? e.message : t('approval.failed')); }
  }
  return { busy, error, decide };
}

interface PanelProps { approval: Approval; hint: boolean; position?: { index: number; total: number } | undefined; onDetails: () => void }

function ApprovalPanel({ approval, hint, position, onDetails }: PanelProps) {
  const t = useT();
  const now = useNow(1000);
  const total = useApprovalWindow(approval);
  const { busy, error, decide } = useDecision(approval);
  const left = Math.max(0, approval.expiresAt - now);
  return (
    <div className="chat-approval" role="alertdialog" aria-label={t('approval.title')}>
      <div className="chat-approval-line"><div className="chat-approval-fill" style={{ width: `${approvalFraction(approval.expiresAt, now, total) * 100}%` }} /></div>
      <div className="chat-approval-head">
        <span className="chat-approval-icon"><Icon name="terminal" size={14} /></span>
        <span className="chat-approval-title">{approval.title}</span>
        <span className="chat-approval-tool">{approval.tool}</span>
        {position && position.total > 1 && <span className="chat-approval-pos">{t('approval.position', position.index, position.total)}</span>}
        <span className="chat-approval-left">{t('approval.left', formatCountdown(left))}</span>
        <button type="button" className="chat-link" onClick={onDetails}>{t('approval.details')}</button>
      </div>
      <pre className="chat-approval-body">{approval.body}</pre>
      {approval.reasons.length > 0 && <div className="chat-approval-reasons">{approval.reasons.join(' · ')}</div>}
      {approval.onceOnly && <div className="chat-approval-note">{t('approval.checkContent')}</div>}
      {error && <div className="chat-approval-error" role="alert">{error}</div>}
      <div className="chat-approval-actions">
        <button type="button" className="btn btn-ghost chat-plain" disabled={busy} onClick={() => void decide('deny')}>{t('approval.deny')}</button>
        {!approval.onceOnly && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void decide('conversation')}>{t('approval.conversation')}</button>}
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide('once')}>
          {hint && !approval.onceOnly ? <>{t('approval.run')}<span className="chat-approval-key">↵</span></> : t('approval.once')}
        </button>
      </div>
    </div>
  );
}

function ApprovalDetails({ approval, onClose }: { approval: Approval; onClose: () => void }) {
  const t = useT();
  const now = useNow(1000);
  const total = useApprovalWindow(approval);
  const { busy, error, decide } = useDecision(approval);
  const left = Math.max(0, approval.expiresAt - now);
  return (
    <ChatDialog
      wide
      eyebrow={<>{t('approval.title')} · <span className="chat-approval-tool">{approval.tool}</span></>}
      title={approval.title}
      subtitle={t('approval.expires', formatCountdown(left))}
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn btn-ghost chat-plain" disabled={busy} onClick={() => void decide('deny')}>{t('approval.deny')}</button>
          {!approval.onceOnly && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void decide('conversation')}>{t('approval.conversation')}</button>}
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide('once')}>{t('approval.once')}</button>
        </>
      )}
    >
      <div className="chat-approval-line"><div className="chat-approval-fill" style={{ width: `${approvalFraction(approval.expiresAt, now, total) * 100}%` }} /></div>
      <pre className="chat-dialog-body">{approval.body}</pre>
      {approval.onceOnly && <div className="chat-approval-note">{t('approval.checkContent')}</div>}
      {approval.preview.map(file => (
        <div key={file.path} className="chat-dialog-file">
          <div className="chat-dialog-mono small">{file.path}{file.truncated ? t('approval.previewCut') : ''}</div>
          <pre className="chat-dialog-body" aria-label={t('approval.preview')}>{file.text}</pre>
        </div>
      ))}
      <div className="chat-dialog-grid">
        {approval.cwd && (
          <>
            <span className="chat-dialog-key">{t('approval.cwd')}</span>
            <span className="chat-dialog-mono">{approval.cwd}</span>
          </>
        )}
        {approval.reasons.length > 0 && (
          <>
            <span className="chat-dialog-key">{t('approval.reasons')}</span>
            <div className="chat-dialog-list">{approval.reasons.map(reason => <span key={reason}>{reason}</span>)}</div>
          </>
        )}
        {approval.details.length > 0 && (
          <>
            <span className="chat-dialog-key">{t('approval.paths')}</span>
            <div className="chat-dialog-list">{approval.details.map(path => <span key={path} className="chat-dialog-mono small">{path}</span>)}</div>
          </>
        )}
      </div>
      {error && <div className="chat-approval-error" role="alert">{error}</div>}
    </ChatDialog>
  );
}

export function ApprovalDock({ approvals }: { approvals: Approval[] }) {
  const [detailId, setDetailId] = useState<string | null>(null);
  const first = approvals[0];
  const detail = approvals.find(a => a.id === detailId);
  if (!first) return null;
  return (
    <>
      <div className={`chat-approval-stack${approvals.length > 1 ? ' behind' : ''}`}>
        {approvals.length > 1 && <div className="chat-approval-behind" />}
        <ApprovalPanel key={first.id} approval={first} hint position={{ index: 1, total: approvals.length }} onDetails={() => setDetailId(first.id)} />
      </div>
      {detail && <ApprovalDetails approval={detail} onClose={() => setDetailId(null)} />}
    </>
  );
}

export function ApprovalCard({ approval }: { approval: Approval }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-approval-single">
      <ApprovalPanel approval={approval} hint={false} onDetails={() => setOpen(true)} />
      {open && <ApprovalDetails approval={approval} onClose={() => setOpen(false)} />}
    </div>
  );
}
