import { useEffect, useLayoutEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import type { UploadView } from './api.ts';
import { slashMatches, type SlashCommand } from './chat-logic.ts';
import { useT } from './i18n/index.ts';
import { Icon } from './icons.tsx';
import { isComposing } from './keys.ts';

const MAX_HEIGHT = 200;
const ATTACH_ACCEPT = '.txt,.md,.csv,.json,.yaml,.yml,.log,.pdf,.png,.jpg,.jpeg,.gif,.webp,text/*,application/pdf,image/png,image/jpeg,image/gif,image/webp';
const MAX_ATTACHMENTS = 5;

interface Props {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  attached: UploadView[];
  uploading: boolean;
  sending: boolean;
  generating: boolean;
  approvalId: string | null;
  assistantName: string;
  modelName: string | null;
  onInput: (value: string) => void;
  onAttach: (files: FileList | null) => void;
  onDetach: (id: string) => void;
  onSend: () => void;
  onStop: () => void;
  onApproveOnce: (approvalId: string) => void;
  onSlash: (command: SlashCommand) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
}

export function Composer(props: Props) {
  const { textareaRef, input, attached, uploading, sending, generating, approvalId, assistantName, modelName } = props;
  const hasApproval = approvalId !== null;
  const t = useT();
  const [focused, setFocused] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const matches = slashMatches(input);
  const slashOpen = focused && matches.length > 0;
  const index = Math.min(slashIndex, Math.max(0, matches.length - 1));
  const empty = !input.trim() && attached.length === 0;

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(MAX_HEIGHT, el.scrollHeight)}px`;
  }, [input, textareaRef]);

  useEffect(() => {
    if (window.matchMedia?.('(pointer: coarse)').matches) return;
    textareaRef.current?.focus();
  }, [textareaRef]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (isComposing(e.nativeEvent)) return;
    if (matches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((index + 1) % matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((index - 1 + matches.length) % matches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); props.onSlash(matches[index]!); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); props.onInput(''); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (empty && approvalId !== null) props.onApproveOnce(approvalId);
      else props.onSend();
    }
  }

  const hint = hasApproval && empty ? t('chat.hintApprove') : t('chat.hintSend');
  return (
    <div className="chat-composer">
      {slashOpen && (
        <div className="chat-slash" role="listbox" aria-label={t('slash.list')}>
          {matches.map((command, i) => (
            <button
              key={command.name} type="button" role="option" aria-selected={i === index} className={`chat-slash-item${i === index ? ' active' : ''}`}
              onMouseDown={e => { e.preventDefault(); props.onSlash(command); }} onMouseEnter={() => setSlashIndex(i)}
            >
              <span className="chat-slash-cmd">/{command.name}</span>
              <span className="chat-slash-desc">{t(command.desc)}</span>
            </button>
          ))}
          <div className="chat-slash-foot"><span>{t('slash.hintMove')}</span><span>{t('slash.hintRun')}</span><span>{t('slash.hintClose')}</span></div>
        </div>
      )}
      <div className="chat-box">
        {attached.length > 0 && (
          <div className="chat-attached">
            {attached.map(a => (
              <span key={a.id} className="tag tag-neutral chat-chip">
                <Icon name="paperclip" size={11} />
                {a.kind === 'pdf' && a.pages ? t('chat.pdfPages', a.pages) : t(`chat.kind.${a.kind}`)}: {a.name}
                <button type="button" className="chat-chip-x" aria-label={t('chat.detach', a.name)} onClick={() => props.onDetach(a.id)}><Icon name="x" size={11} /></button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef} className="chat-input" rows={1} value={input} readOnly={sending} data-composer
          aria-label={t('chat.message')} placeholder={hasApproval ? t('chat.placeholderApproval') : t('chat.placeholder', assistantName)}
          onChange={e => { props.onInput(e.target.value); setSlashIndex(0); }} onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        />
        <div className="chat-tools">
          <input ref={props.fileInputRef} type="file" multiple hidden accept={ATTACH_ACCEPT} onChange={e => props.onAttach(e.target.files)} />
          <button
            type="button" className="btn btn-ghost btn-icon chat-ctl chat-attach" aria-label={t('chat.attach')} data-tip={t('chat.attach')}
            disabled={sending || uploading || attached.length >= MAX_ATTACHMENTS} onClick={() => props.fileInputRef.current?.click()}
          >
            {uploading ? <span className="spin"><Icon name="loader" size={15} /></span> : <Icon name="paperclip" size={15} />}
          </button>
          {modelName && (
            <span className="chat-model-chip" data-tip={t('chat.model')}>
              <Icon name="cpu" size={13} />
              <span className="chat-model-name">{modelName}</span>
            </span>
          )}
          <span className="chat-tools-fill" />
          <span className="chat-hint">{hint}</span>
          {generating
            ? (
              <button type="button" className="btn btn-secondary btn-icon chat-ctl chat-stop" aria-label={t('chat.stop')} data-tip={t('chat.stop')} data-kbd="Esc" onClick={props.onStop}>
                <Icon name="square" size={12} />
              </button>
            )
            : (
              <button
                type="button" className="btn btn-primary btn-icon chat-ctl chat-send" aria-label={t('chat.send')} data-tip={t('chat.send')} data-kbd="↵"
                disabled={sending || uploading || empty} onClick={props.onSend}
              >
                <Icon name="arrowUp" size={15} />
              </button>
            )}
        </div>
      </div>
    </div>
  );
}
