import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, type SkillDraft, type SkillSummary } from './api.ts';
import { useEscapeLayer, useExit } from './hooks.ts';
import { Icon } from './icons.tsx';
import { formatDateTime, useT } from './i18n/index.ts';
import { skillFileText } from './skills-meta.ts';
import { toast } from './toast.tsx';

export type SkillDialogState = { kind: 'skill' | 'draft'; name: string } | { kind: 'new' };

type SkillDetail = SkillSummary & { body: string };

const EXIT_MS = 240;
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

// 画面の上に重ねる窓。Esc・背景を押す・Tab の巡回・閉じたあとの元の場所へのフォーカスを受け持つ。
function DialogFrame({ open, label, dirty, wide, onClose, children }: { open: boolean; label: string; dirty: boolean; wide: boolean; onClose: () => void; children: ReactNode }) {
  const { mounted, leaving } = useExit(open, EXIT_MS);
  const box = useRef<HTMLDivElement>(null);
  useEscapeLayer('dialog', open, onClose);

  useEffect(() => {
    if (!open) return undefined;
    const before = document.activeElement;
    return () => { if (before instanceof HTMLElement && before.isConnected) before.focus(); };
  }, [open]);
  useEffect(() => {
    const el = box.current;
    if (open && el && !el.contains(document.activeElement)) el.focus();
  });

  if (!mounted) return null;
  const trap = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) { e.preventDefault(); return; }
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const host = document.querySelector('.shell') ?? document.body;
  return createPortal(
    <>
      <div className={`sk-backdrop${leaving ? ' leaving' : ''}`} onClick={() => { if (!dirty) onClose(); }} />
      <div className="sk-wrap">
        <div ref={box} className={`dialog sk-dialog${wide ? ' wide' : ''}${leaving ? ' leaving' : ''}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={trap}>
          {children}
        </div>
      </div>
    </>,
    host,
  );
}

const errorText = (error: unknown, fallback: string): string => (error instanceof ApiError ? error.message : fallback);

function Head({ path, title, meta, onClose }: { path?: string | undefined; title: string; meta?: string | undefined; onClose: () => void }) {
  const t = useT();
  return (
    <div className="sk-head">
      <div className="sk-head-text">
        {path && <span className="sk-path">{path}</span>}
        <h2 className="dialog-title sk-title">{title}</h2>
        {meta && <span className="sk-meta">{meta}</span>}
      </div>
      <button className="btn btn-ghost btn-icon sk-close" onClick={onClose} aria-label={t('skills.close')}><Icon name="x" size={16} /></button>
    </div>
  );
}

function Fields({ name, onName, description, onDescription, body, onBody }: {
  name?: string; onName?: (v: string) => void; description: string; onDescription: (v: string) => void; body: string; onBody: (v: string) => void;
}) {
  const t = useT();
  return (
    <>
      {onName && (
        <div className="field">
          <label htmlFor="skill-name">{t('skills.field.name')}</label>
          <input id="skill-name" className="input sk-mono" autoFocus value={name ?? ''} onChange={e => onName(e.target.value)} placeholder={t('skills.field.namePlaceholder')} spellCheck={false} />
        </div>
      )}
      <div className="field">
        <label htmlFor="skill-description">{t('skills.field.description')}</label>
        <input id="skill-description" className="input" autoFocus={!onName} value={description} onChange={e => onDescription(e.target.value)} maxLength={300} />
      </div>
      <div className="field">
        <label htmlFor="skill-body">{t('skills.field.body')}</label>
        <textarea id="skill-body" className="input sk-code" value={body} onChange={e => onBody(e.target.value)} spellCheck={false} />
      </div>
    </>
  );
}

function SkillForm({ onClose, onSaved, setDirty }: { onClose: () => void; onSaved: () => void; setDirty: (v: boolean) => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDirty(Boolean(name || description || body)); }, [name, description, body, setDirty]);
  const save = () => {
    setError(''); setBusy(true);
    api.saveSkill(name.trim(), description, body).then(() => { toast({ kind: 'done', title: t('skills.toast.saved'), body: name.trim() }); onSaved(); onClose(); }, e => { setError(errorText(e, t('skills.error'))); setBusy(false); });
  };
  return (
    <>
      <Head title={t('skills.newTitle')} onClose={onClose} />
      <Fields name={name} onName={setName} description={description} onDescription={setDescription} body={body} onBody={setBody} />
      {error && <p className="sk-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="btn btn-ghost sk-plain" onClick={onClose}>{t('skills.cancel')}</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !name.trim()}>{t('skills.save')}</button>
      </div>
    </>
  );
}

function SkillView({ name, onClose, onMissing, onSaved, setDirty }: { name: string; onClose: () => void; onMissing: () => void; onSaved: () => void; setDirty: (v: boolean) => void }) {
  const t = useT();
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.skill(name).then(r => { if (!cancelled) setSkill(r.skill); }, e => {
      if (cancelled) return;
      if (e instanceof ApiError && e.status === 404) { toast({ kind: 'info', icon: 'alert', title: t('skills.toast.notFound'), body: name }); onMissing(); }
      else setError(errorText(e, t('skills.loadFailed')));
    });
    return () => { cancelled = true; };
  }, [name]);
  useEffect(() => { setDirty(mode === 'edit' && skill !== null && (description !== skill.description || body !== skill.body)); }, [mode, skill, description, body, setDirty]);

  const startEdit = () => { if (!skill) return; setDescription(skill.description); setBody(skill.body); setError(''); setMode('edit'); };
  const save = () => {
    setError(''); setBusy(true);
    api.saveSkill(name, description, body)
      .then(() => api.skill(name))
      .then(r => { setSkill(r.skill); setMode('view'); toast({ kind: 'done', title: t('skills.toast.saved'), body: name }); onSaved(); })
      .catch(e => setError(errorText(e, t('skills.error'))))
      .finally(() => setBusy(false));
  };
  const remove = () => {
    setError(''); setBusy(true);
    api.deleteSkill(name).then(() => { toast({ kind: 'info', icon: 'circleSlash', title: t('skills.toast.deleted'), body: name }); onSaved(); onClose(); }, e => { setError(errorText(e, t('skills.error'))); setBusy(false); });
  };

  const meta = skill && (skill.uses > 0 ? t('skills.meta', skill.uses, formatDateTime(skill.lastUsedAt)) : t('skills.metaUnused'));
  return (
    <>
      <Head path={`skills/${name}/SKILL.md`} title={name} meta={meta ?? undefined} onClose={onClose} />
      {!skill && !error && <p className="sk-note">{t('skills.loading')}</p>}
      {skill && mode !== 'edit' && <pre className="sk-pre">{skillFileText(skill)}</pre>}
      {skill && mode === 'edit' && <Fields description={description} onDescription={setDescription} body={body} onBody={setBody} />}
      {error && <p className="sk-error" role="alert">{error}</p>}
      {skill && mode === 'view' && (
        <div className="dialog-actions sk-actions">
          <button className="btn btn-ghost sk-plain sk-left" onClick={() => setMode('delete')}>{t('skills.delete')}</button>
          <button className="btn btn-primary" onClick={startEdit}><Icon name="pencil" size={13} />{t('skills.edit')}</button>
        </div>
      )}
      {skill && mode === 'edit' && (
        <div className="dialog-actions">
          <button className="btn btn-ghost sk-plain" onClick={() => { setMode('view'); setError(''); }}>{t('skills.cancel')}</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>{t('skills.save')}</button>
        </div>
      )}
      {skill && mode === 'delete' && (
        <div className="sk-confirm" role="alertdialog" aria-label={t('skills.deleteConfirm', name)}>
          <span className="sk-confirm-text">{t('skills.deleteConfirm', name)}</span>
          <div className="dialog-actions">
            <button className="btn btn-ghost sk-plain" onClick={() => setMode('view')}>{t('skills.cancel')}</button>
            <button className="btn sk-danger" onClick={remove} disabled={busy} autoFocus>{t('skills.deleteDo')}</button>
          </div>
        </div>
      )}
    </>
  );
}

function DraftReview({ draft, onClose, onDone }: { draft: SkillDraft; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = (approve: boolean) => {
    setError(''); setBusy(true);
    (approve ? api.approveDraft(draft.id) : api.rejectDraft(draft.id)).then(() => {
      toast({ kind: approve ? 'done' : 'info', icon: approve ? 'circleCheck' : 'circleSlash', title: t(approve ? 'skills.toast.approved' : 'skills.toast.rejected'), body: draft.name });
      onDone(); onClose();
    }, e => { setError(errorText(e, t('skills.error'))); setBusy(false); });
  };
  const revision = draft.current !== null;
  return (
    <>
      <Head path={`skills/${draft.name}/SKILL.md`} title={draft.name} meta={t('skills.draftMeta', formatDateTime(draft.created_at))} onClose={onClose} />
      <div className="sk-tags">
        <span className="tag tag-outline">{t('skills.draftTag')}</span>
        <span className="tag tag-neutral">{t(revision ? 'skills.draftRevision' : 'skills.draftNew')}</span>
      </div>
      {draft.reason && <p className="sk-reason"><span className="sk-label">{t('skills.draft.reason')}</span>{draft.reason}</p>}
      <div className={`sk-versions${revision ? ' two' : ''}`}>
        {draft.current && (
          <section className="sk-version">
            <span className="sk-label">{t('skills.draft.current')}</span>
            <p className="sk-version-desc">{draft.current.description}</p>
            <pre className="sk-pre">{draft.current.body}</pre>
          </section>
        )}
        <section className="sk-version">
          <span className="sk-label">{t(revision ? 'skills.draft.after' : 'skills.draft.content')}</span>
          <p className="sk-version-desc">{draft.description}</p>
          <pre className="sk-pre">{draft.body}</pre>
        </section>
      </div>
      {error && <p className="sk-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="btn btn-ghost sk-plain" onClick={() => decide(false)} disabled={busy}>{t('skills.draft.reject')}</button>
        <button className="btn btn-primary" onClick={() => decide(true)} disabled={busy}>{t('skills.draft.approve')}</button>
      </div>
    </>
  );
}

interface Props {
  dialog: SkillDialogState | null;
  drafts: SkillDraft[] | null;
  findDraft: (name: string) => SkillDraft | undefined;
  onClose: () => void;
  onChanged: () => void;
  onSkillMissing: () => void;
  onDraftMissing: (name: string) => void;
}

export function SkillDialog({ dialog, drafts, findDraft, onClose, onChanged, onSkillMissing, onDraftMissing }: Props) {
  const t = useT();
  const last = useRef(dialog);
  if (dialog) last.current = dialog;
  const shown = dialog ?? last.current;
  const [dirty, setDirty] = useState(false);
  const found = shown?.kind === 'draft' ? findDraft(shown.name) : undefined;
  const lastDraft = useRef(found);
  if (found) lastDraft.current = found;
  // 承認や却下のあと、閉じる動きの間は、直前の下書きを見せたままにする
  const draft = found ?? (dialog === null ? lastDraft.current : undefined);
  const draftName = dialog?.kind === 'draft' ? dialog.name : null;
  const draftKnown = found !== undefined;
  useEffect(() => {
    if (draftName !== null && drafts !== null && !draftKnown) onDraftMissing(draftName);
  }, [draftName, drafts, draftKnown]);
  useEffect(() => { if (dialog === null) setDirty(false); }, [dialog]);

  return (
    <DialogFrame open={dialog !== null} label={t('skills.dialogLabel')} dirty={dirty} wide={shown?.kind === 'draft' && draft?.current != null} onClose={onClose}>
      {shown?.kind === 'new' && <SkillForm key="new" onClose={onClose} onSaved={onChanged} setDirty={setDirty} />}
      {shown?.kind === 'skill' && <SkillView key={`skill:${shown.name}`} name={shown.name} onClose={onClose} onMissing={onSkillMissing} onSaved={onChanged} setDirty={setDirty} />}
      {shown?.kind === 'draft' && draft && <DraftReview key={`draft:${draft.id}`} draft={draft} onClose={onClose} onDone={onChanged} />}
    </DialogFrame>
  );
}
