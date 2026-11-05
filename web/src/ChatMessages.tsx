import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { openSetup } from './onboarding.ts';
import type { Message, Profile } from './api.ts';
import { Avatar } from './Avatar.tsx';
import { chatTime, firstLine, toolIcon, type ContextNumbers } from './chat-logic.ts';
import { useNow } from './hooks.ts';
import { formatNumber, useT, type PlainKey } from './i18n/index.ts';
import { Icon, type IconName } from './icons.tsx';
import { Markdown } from './Markdown.tsx';
import { undoMemoryEvent, useMemoryUndone } from './memory-undo.ts';

const KIND_KEY = { image: 'chat.kind.image', pdf: 'chat.kind.pdf', text: 'chat.kind.text' } as const satisfies Record<'image' | 'pdf' | 'text', PlainKey>;

export function ReplyAvatar({ profile, live, size = 26 }: { profile: Profile | null; live: boolean; size?: number }) {
  return (
    <span className="chat-reply-avatar" style={{ width: size, height: size }}>
      {profile && (
        <Avatar
          shape={profile.shape} color={profile.color} motion={live ? profile.motion : 'none'} runtime={live ? 'work' : undefined}
          size={size} seed={profile.name}
        />
      )}
    </span>
  );
}

export function EmptyChat({ profile, onPick }: { profile: Profile | null; onPick: (text: string) => void }) {
  const t = useT();
  const suggestions = [t('chat.suggest.task'), t('chat.suggest.memory'), t('chat.suggest.files')];
  return (
    <div className="chat-empty">
      <ReplyAvatar profile={profile} live={false} size={56} />
      <span className="chat-empty-title">{t('chat.emptyTitle')}</span>
      <span className="chat-empty-body">{t('chat.emptyBody')}</span>
      <div className="chat-suggests">
        {suggestions.map(text => (
          <button key={text} type="button" className="chat-suggest" onClick={() => onPick(text)}>
            <span className="chat-suggest-icon"><Icon name="chevR" size={14} /></span>{text}
          </button>
        ))}
      </div>
    </div>
  );
}

export const UserMessage = memo(function UserMessage({ message }: { message: Message }) {
  const t = useT();
  return (
    <div className="chat-user">
      {message.text && <div className="chat-user-bubble">{message.text}</div>}
      {message.attachments?.length ? (
        <div className="chat-chips">
          {message.attachments.map(a => (
            <span key={a.id} className="tag tag-neutral chat-chip"><Icon name="paperclip" size={11} />{t(KIND_KEY[a.kind])}: {a.name}</span>
          ))}
        </div>
      ) : null}
      <span className="chat-meta">{t('chat.you')} · {chatTime(message.createdAt)}</span>
    </div>
  );
});

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  function copy(): void {
    let pending: Promise<void> | undefined;
    try { pending = navigator.clipboard?.writeText(text); } catch { pending = undefined; }
    void pending?.then(() => {
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1600);
    }, () => undefined);
  }
  return (
    <button type="button" className="chat-copy" aria-label={t('chat.copy')} data-tip={done ? t('chat.copied') : t('chat.copy')} onClick={copy}>
      <Icon name={done ? 'check' : 'copy'} size={12} />
    </button>
  );
}

interface ReplyProps { profile: Profile | null; text: string; time: number }

export const AssistantMessage = memo(function AssistantMessage({ profile, text, time }: ReplyProps) {
  return (
    <div className="chat-reply">
      <ReplyAvatar profile={profile} live={false} />
      <div className="chat-reply-main">
        <ReplyHead profile={profile} time={time} live={false} />
        <div className="chat-reply-body"><Markdown text={text} /></div>
        <div className="chat-reply-foot">
          <CopyButton text={text} />
        </div>
      </div>
    </div>
  );
});

export function LiveReply({ profile, text, time }: ReplyProps) {
  return (
    <div className="chat-reply chat-live">
      <ReplyAvatar profile={profile} live />
      <div className="chat-reply-main">
        <ReplyHead profile={profile} time={time} live />
        <div className="chat-reply-body"><Markdown text={text} /></div>
      </div>
    </div>
  );
}

function ReplyHead({ profile, time, live }: { profile: Profile | null; time: number; live: boolean }) {
  const t = useT();
  return (
    <div className="chat-reply-head">
      <span className="chat-reply-name">{profile?.name ?? 'Clive'}</span>
      <span className="chat-meta">{chatTime(time)}</span>
      {live && <span className="chat-live-label">{t('chat.writing')}</span>}
    </div>
  );
}

const secondsSince = (startedAt: number | null, now: number): number | null => (startedAt === null ? null : Math.max(0, Math.floor((now - startedAt) / 1000)));

export function ThinkingRow({ profile, startedAt }: { profile: Profile | null; startedAt: number | null }) {
  const t = useT();
  const seconds = secondsSince(startedAt, useNow(1000, startedAt !== null));
  return (
    <div className="chat-think">
      <ReplyAvatar profile={profile} live />
      <span className="chat-shimmer chat-think-text">{t('chat.thinking')}</span>
      {seconds !== null && <span className="chat-meta">{t('chat.seconds', seconds)}</span>}
    </div>
  );
}

export function RunningTool({ name, input, startedAt }: { name: string; input: string; startedAt: number | null }) {
  const t = useT();
  const seconds = secondsSince(startedAt, useNow(1000, startedAt !== null));
  return (
    <div className="chat-row chat-run">
      <span className="chat-tool-chev" />
      <span className="chat-tool-icon spin"><Icon name="loader" size={14} /></span>
      <span className="chat-tool-name">{name}</span>
      <span className="chat-shimmer chat-tool-first">{input}</span>
      {seconds !== null && <span className="chat-meta">{t('chat.seconds', seconds)}</span>}
    </div>
  );
}

export const ToolMessage = memo(function ToolMessage({ message }: { message: Message }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const failed = Boolean(message.isError);
  return (
    <div className={`chat-row chat-tool${open ? ' open' : ''}`}>
      <button type="button" className="chat-tool-btn" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="chat-tool-chev"><Icon name="chevR" size={12} /></span>
        <span className="chat-tool-icon"><Icon name={toolIcon(message.toolName)} size={14} /></span>
        <span className="chat-tool-name">{message.toolName}</span>
        <span className="chat-tool-first">{firstLine(message.text)}</span>
        <span className={`chat-tool-state${failed ? ' fail' : ''}`}>
          <Icon name={failed ? 'x' : 'check'} size={13} />
          <span className="sr-only">{failed ? t('chat.tool.failed') : t('chat.tool.ok')}</span>
        </span>
      </button>
      {open && <pre className="chat-tool-out">{message.text}</pre>}
    </div>
  );
});

export function NoteRow({ icon, accent, children }: { icon: IconName; accent?: boolean; children: ReactNode }) {
  return (
    <div className="chat-row chat-note">
      <span className={`chat-note-icon${accent ? ' accent' : ''}`}><Icon name={icon} size={13} /></span>
      <span className="chat-note-text">{children}</span>
    </div>
  );
}

export function MemoryRow({ message, eventId }: { message: string; eventId: number | undefined }) {
  const t = useT();
  const undone = useMemoryUndone(eventId ?? -1);
  const [failed, setFailed] = useState(false);
  return (
    <div className="chat-row chat-note chat-memory">
      <span className="chat-note-icon accent"><Icon name="bookmark" size={13} /></span>
      <span className={`chat-note-text${undone ? ' struck' : ''}`}>{message}</span>
      {undone && <span className="chat-meta">{t('chat.memory.undone')}</span>}
      {!undone && eventId !== undefined && (
        <button type="button" className="chat-link" onClick={() => void undoMemoryEvent(eventId).then(ok => setFailed(!ok))}>
          {failed ? t('chat.memory.undoFailed') : t('chat.memory.undo')}
        </button>
      )}
    </div>
  );
}

export function NumbersGrid({ items }: { items: Array<{ label: string; value: number | null; warn?: boolean }> }) {
  return (
    <div className="chat-numbers">
      {items.map(item => (
        <div key={item.label} className="chat-number">
          <span className="chat-number-label">{item.label}</span>
          <span className={`chat-number-value${item.warn ? ' warn' : ''}`}>{item.value === null ? '—' : formatNumber(item.value)}</span>
        </div>
      ))}
    </div>
  );
}

interface FailureProps { message: string; hint?: string | null | undefined; numbers?: { available: number; required: number } | null; onRetry?: (() => void) | undefined }

export function FailureCard({ message, hint, numbers, onRetry }: FailureProps) {
  const t = useT();
  return (
    <div className="chat-fail">
      <div className="chat-card" role="alert">
        <span className="chat-card-icon"><Icon name="alert" size={16} /></span>
        <div className="chat-card-text">
          <span className="chat-card-title">{t('chat.fail.title')}</span>
          <span className="chat-card-reason">{message}</span>
          {numbers && <NumbersGrid items={[{ label: t('chat.num.available'), value: numbers.available }, { label: t('chat.num.required'), value: numbers.required, warn: true }]} />}
          {hint && <span className="chat-card-hint">{hint}</span>}
        </div>
      </div>
      {onRetry && (
        <div className="chat-actions">
          <button type="button" className="btn btn-secondary" onClick={onRetry}><Icon name="refresh" size={13} />{t('chat.fail.retry')}</button>
        </div>
      )}
    </div>
  );
}

interface PreSendProps { message: string; hint: string | null; numbers: ContextNumbers | null }

export function PreSendCard({ message, hint, numbers }: PreSendProps) {
  const t = useT();
  const tooSmall = numbers !== null && numbers.required !== null && numbers.effective !== null && numbers.required > numbers.effective;
  return (
    <div className="chat-fail">
      <div className="chat-card chat-pre" role="alert">
        <div className="chat-pre-head">
          <span className="chat-card-icon accent"><Icon name="alert" size={16} /></span>
          <span className="chat-card-title">{t('chat.pre.title')}</span>
        </div>
        <p className="chat-pre-message">{message}</p>
        {numbers && (
          <NumbersGrid
            items={[
              { label: t('chat.num.effective'), value: numbers.effective },
              { label: t('chat.num.required'), value: numbers.required, warn: tooSmall },
              { label: t('chat.num.declared'), value: numbers.declared },
              { label: t('chat.num.measured'), value: numbers.measured },
              { label: t('chat.num.modelMax'), value: numbers.modelMax },
            ]}
          />
        )}
        {hint && <div className="chat-pre-hint"><strong>{t('chat.fail.fix')}</strong>{hint}</div>}
        <span className="chat-meta">{t('chat.pre.kept')}</span>
      </div>
      <div className="chat-actions">
        <a className="btn btn-primary" href="#/settings"><Icon name="sliders" size={13} />{t('chat.settings')}</a>
      </div>
    </div>
  );
}

export function SendErrorCard({ message, hint, setup = false }: { message: string; hint: string | null; setup?: boolean }) {
  const t = useT();
  return (
    <div className="chat-fail">
      <div className="chat-card" role="alert">
        <span className="chat-card-icon"><Icon name="alert" size={16} /></span>
        <div className="chat-card-text">
          <span className="chat-card-title">{t('chat.send.failedTitle')}</span>
          <span className="chat-card-reason">{message}</span>
          {hint && <span className="chat-card-hint"><strong>{t('chat.fail.fix')}</strong>{hint}</span>}
        </div>
      </div>
      <div className="chat-actions">
        {setup
          ? <button type="button" className="btn btn-primary" onClick={openSetup}><Icon name="sparkles" size={13} />{t('chat.send.setupModel')}</button>
          : <a className="btn btn-secondary" href="#/settings"><Icon name="sliders" size={13} />{t('chat.settings')}</a>}
      </div>
    </div>
  );
}
