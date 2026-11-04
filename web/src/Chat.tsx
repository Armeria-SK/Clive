import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiError, type Approval, type Message, type UploadView } from './api.ts';
import type { Draft } from './events.ts';
import { Markdown } from './Markdown.tsx';

export function ApprovalCard({ approval }: { approval: Approval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, Math.round((approval.expiresAt - now) / 1000));
  async function decide(decision: 'once' | 'conversation' | 'deny') {
    setBusy(true); setError('');
    try { await api.decide(approval.id, decision); }
    catch (e) { setError(e instanceof ApiError ? e.message : '送れませんでした'); setBusy(false); }
  }
  return (
    <div className="approval" role="group" aria-label="承認の依頼">
      <p className="approval-title">承認が必要です: {approval.title}<span className="muted">（残り {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}。過ぎると拒否）</span></p>
      <pre className="approval-body">{approval.body}</pre>
      {approval.cwd && <p className="muted">作業フォルダ: <code>{approval.cwd}</code></p>}
      {approval.reasons.length > 0 && <ul className="reasons">{approval.reasons.map(r => <li key={r}>{r}</li>)}</ul>}
      {approval.details.length > 0 && (
        <details><summary>見つけたパス</summary><ul className="details">{approval.details.map(d => <li key={d}><code>{d}</code></li>)}</ul></details>
      )}
      {error && <p className="error-text">{error}</p>}
      <div className="row">
        <button onClick={() => void decide('once')} disabled={busy}>今回だけ許可</button>
        <button className="secondary" onClick={() => void decide('conversation')} disabled={busy}>この会話では許可</button>
        <button className="stop" onClick={() => void decide('deny')} disabled={busy}>拒否</button>
      </div>
    </div>
  );
}

function MemoryUndo({ eventId }: { eventId: number }) {
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');
  if (state === 'done') return <span className="muted">（取り消しました）</span>;
  return <button className="link" onClick={() => void api.undoMemory(eventId).then(() => setState('done'), () => setState('error'))}>{state === 'error' ? '取り消せませんでした' : '取り消す'}</button>;
}

export function ToolMessage({ message }: { message: Message }) {
  const lines = message.text.split('\n');
  return (
    <details className={`tool-result ${message.isError ? 'failed' : ''}`}>
      <summary>
        <span className="tool-name">{message.toolName}</span>
        <span className={`badge ${message.isError ? 'bad' : 'ok'}`}>{message.isError ? '失敗・不実行' : '成功'}</span>
        <span className="muted preview">{lines.find(l => l.trim())?.slice(0, 120)}</span>
      </summary>
      <pre>{message.text}</pre>
    </details>
  );
}

export interface RunNotice { runId: string; kind: 'warning' | 'error' | 'switch' | 'memory'; message: string; hint?: string | undefined; retryable?: boolean; eventId?: number }

interface Props {
  conversationId: string | null;
  drafts: Draft[];
  notices: RunNotice[];
  approvals: Approval[];
  revision: number;
  onCreated: (id: string) => void;
  onClearNotices: (conversationId: string) => void;
}

export function Chat({ conversationId, drafts, notices, approvals, revision, onCreated, onClearNotices }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<{ message: string; hint?: string } | null>(null);
  const [attached, setAttached] = useState<UploadView[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const draft = drafts.find(d => d.conversationId === conversationId);

  const load = useCallback(async () => {
    if (!conversationId) { setMessages([]); return; }
    try { setMessages((await api.messages(conversationId)).messages); }
    catch (error) { if (error instanceof ApiError && error.status === 404) setMessages([]); }
  }, [conversationId]);

  useEffect(() => { void load(); setSendError(null); }, [load]);
  useEffect(() => { void load(); }, [revision, load]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [messages.length, draft?.text.length]);

  async function attach(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true); setSendError(null);
    try {
      for (const file of [...files].slice(0, 5 - attached.length)) {
        const upload = await api.upload(file);
        setAttached(list => [...list, upload]);
      }
    } catch (error) {
      setSendError({ message: error instanceof ApiError ? error.message : '添付できませんでした' });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function send() {
    const text = input.trim();
    if ((!text && !attached.length) || sending) return;
    setSending(true); setSendError(null);
    try {
      let id = conversationId;
      if (!id) { id = (await api.createConversation()).conversation.id; onCreated(id); }
      onClearNotices(id);
      await api.send(id, text, attached.map(a => a.id));
      setInput('');
      setAttached([]);
      await load();
    } catch (error) {
      if (error instanceof ApiError) setSendError({ message: error.message, hint: error.body?.detail?.hint });
      else setSendError({ message: '送信できませんでした。サーバーが動いているか確認してください' });
    } finally { setSending(false); }
  }

  async function retry() {
    if (!conversationId) return;
    onClearNotices(conversationId);
    setSendError(null);
    try { await api.retry(conversationId); }
    catch (error) { setSendError({ message: error instanceof ApiError ? error.message : 'やり直せませんでした' }); }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // 日本語入力の変換確定の Enter では送らない
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void send();
    }
  }

  const lastIsUser = messages.at(-1)?.role === 'user';
  const errorNotice = notices.find(n => n.kind === 'error');

  return (
    <section className="chat">
      <div className="messages">
        {!messages.length && !draft && (
          <div className="empty">
            <h2>Clive</h2>
            <p>話しかけてください。Enter で送信、Shift+Enter で改行します。</p>
          </div>
        )}
        {messages.map(m => {
          if (m.role === 'tool') return <ToolMessage key={m.id} message={m} />;
          if (m.role === 'assistant' && !m.text.trim() && m.toolCalls?.length) return null; // ツールを呼んだだけの返事は、結果の表示に任せる
          return (
            <article key={m.id} className={`message ${m.role}`}>
              {m.role === 'assistant' ? <Markdown text={m.text} /> : <p className="plain">{m.text}</p>}
              {m.attachments?.length ? <p className="attachments">{m.attachments.map(a => <span key={a.id} className="tag">{a.kind === 'image' ? '画像' : a.kind === 'pdf' ? 'PDF' : 'ファイル'}: {a.name}</span>)}</p> : null}
              {m.toolCalls?.length ? <p className="muted tool-hint">ツールを使います: {m.toolCalls.map(c => c.name).join('、')}</p> : null}
            </article>
          );
        })}
        {draft && (
          <article className="message assistant streaming">
            {draft.text ? <Markdown text={draft.text} />
              : <p className="muted">{draft.activeTool ? `ツールを実行しています: ${draft.activeTool}` : `考えています…（${draft.modelId}）`}</p>}
          </article>
        )}
        {approvals.map(a => <ApprovalCard key={a.id} approval={a} />)}
        {notices.filter(n => n.kind !== 'error').map((n, i) => (
          <p key={`${n.runId}-${i}`} className={`notice ${n.kind}`}>
            {n.message}
            {n.kind === 'memory' && n.eventId !== undefined && <MemoryUndo eventId={n.eventId} />}
          </p>
        ))}
        {errorNotice && (
          <div className="error-panel">
            <p className="pre">{errorNotice.message}</p>
            {errorNotice.hint && <p className="hint">直し方: {errorNotice.hint}</p>}
            {lastIsUser && !draft && <button onClick={() => void retry()}>もう一度送る</button>}
          </div>
        )}
        <div ref={bottom} />
      </div>
      {sendError && (
        <div className="error-panel compose-error">
          <p className="pre">{sendError.message}</p>
          {sendError.hint && <p className="hint">直し方: {sendError.hint}</p>}
          <a href="#/settings">設定を開く</a>
        </div>
      )}
      {attached.length > 0 && (
        <div className="attached">
          {attached.map(a => (
            <span key={a.id} className="tag">
              {a.kind === 'image' ? '画像' : a.kind === 'pdf' ? `PDF ${a.pages} ページ` : 'ファイル'}: {a.name}
              <button className="link" aria-label={`${a.name} を外す`} onClick={() => setAttached(list => list.filter(x => x.id !== a.id))}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="composer">
        <input ref={fileInput} type="file" multiple hidden onChange={e => void attach(e.target.files)}
          accept=".txt,.md,.csv,.json,.yaml,.yml,.log,.pdf,.png,.jpg,.jpeg,.gif,.webp,text/*,application/pdf,image/png,image/jpeg,image/gif,image/webp" />
        <button className="secondary" onClick={() => fileInput.current?.click()} disabled={sending || uploading || attached.length >= 5} title="ファイルを添付（テキスト・PDF・画像、10MB まで）">
          {uploading ? '添付中…' : '添付'}
        </button>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="メッセージ"
          rows={3}
          disabled={sending}
          aria-label="メッセージ"
        />
        {draft
          ? <button className="stop" onClick={() => void api.stop(draft.runId)}>止める</button>
          : <button onClick={() => void send()} disabled={sending || uploading || (!input.trim() && !attached.length)}>送信</button>}
      </div>
    </section>
  );
}
