import { useEffect, useState } from 'react';
import { api, ApiError, type PersonaView, type Profile } from '../api.ts';
import { useT } from '../i18n/index.ts';
import { Icon } from '../icons.tsx';
import { estimateTokens, overPersonaBudget } from '../tokens.ts';
import { toast } from '../toast.tsx';
import { FieldRow } from './fields.tsx';

const errorText = (error: unknown, fallback: string): string => (error instanceof ApiError ? error.message : fallback);

interface EditorProps { label: string; desc: string; text: string; original: string; max: number; onChange: (text: string) => void; onSave: () => void; saving: boolean }

function Editor({ label, desc, text, original, max, onChange, onSave, saving }: EditorProps) {
  const t = useT();
  const dirty = text !== original;
  return (
    <div className="set-rows">
      <span className="set-subtitle">{label}</span>
      <span className="set-row-desc">{desc}</span>
      <textarea className="input set-persona" value={text} maxLength={max} spellCheck={false} onChange={e => onChange(e.target.value)} aria-label={label} />
      <div className="set-persona-bar">
        <span className="set-row-desc">{t('settings.about.tokens', estimateTokens(text))}</span>
        <span className="set-bar-fill" />
        <button type="button" className="btn btn-ghost" disabled={!dirty || saving} onClick={() => onChange(original)}>{t('settings.about.revert')}</button>
        <button type="button" className="btn btn-primary" disabled={!dirty || saving || !text.trim()} onClick={onSave}>{t('settings.about.save')}</button>
      </div>
    </div>
  );
}

// 設定の「Clive について」: 名前（画面の名前と SOUL.md の名乗りを一緒に書く）・振る舞い（SOUL.md 全文）・あなたについて（USER.md 全文）・はじめの設定のやり直し。
// 全文の編集は設定の保存の帯とは別に、ここで保存する（利用者自身の編集なので、承認は要らない）。
export function AboutSection({ profileName, onNameSaved, onRerunSetup }: { profileName: string; onNameSaved: (profile: Profile) => void; onRerunSetup: () => void }) {
  const t = useT();
  const [name, setName] = useState(profileName);
  const [renaming, setRenaming] = useState(false);
  const [view, setView] = useState<PersonaView | null>(null);
  const [failed, setFailed] = useState(false);
  const [soul, setSoul] = useState('');
  const [user, setUser] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { setName(profileName); }, [profileName]);
  useEffect(() => {
    void api.persona().then(v => { setView(v); setSoul(v.soul); setUser(v.user); }).catch(() => setFailed(true));
  }, []);

  async function rename(): Promise<void> {
    setRenaming(true);
    try {
      const result = await api.onboardingPersona({ botName: name.trim() });
      onNameSaved(result.profile);
      toast({ kind: 'done', icon: 'check', title: t('settings.about.renamed') });
    } catch (error) { toast({ icon: 'alert', title: t('settings.about.saveFailed'), body: errorText(error, '') }); }
    finally { setRenaming(false); }
  }

  async function save(patch: { soul?: string; user?: string }): Promise<void> {
    setSaving(true);
    try {
      const next = await api.savePersona(patch);
      setView(next); setSoul(next.soul); setUser(next.user);
      toast({ kind: 'done', icon: 'check', title: t('settings.about.saved') });
    } catch (error) { toast({ icon: 'alert', title: t('settings.about.saveFailed'), body: errorText(error, '') }); }
    finally { setSaving(false); }
  }

  const total = estimateTokens(soul) + estimateTokens(user);
  const warn = view !== null && overPersonaBudget(total, view.budget);
  return (
    <div className="set-stack">
      <div className="set-rows">
        <FieldRow label={t('settings.about.name')} desc={t('settings.about.nameDesc')}>
          <div className="set-name-edit">
            <input className="input set-text" value={name} maxLength={40} aria-label={t('settings.about.name')} onChange={e => setName(e.target.value)} />
            <button type="button" className="btn btn-secondary" disabled={renaming || !name.trim() || name.trim() === profileName} onClick={() => void rename()}>{t('settings.about.rename')}</button>
          </div>
        </FieldRow>
      </div>
      {failed && <p className="set-note">{t('settings.about.loadFailed')}</p>}
      {view && (
        <>
          <Editor label={t('settings.about.soul')} desc={t('settings.about.soulDesc')} text={soul} original={view.soul} max={view.max} onChange={setSoul} saving={saving} onSave={() => void save({ soul })} />
          <Editor label={t('settings.about.user')} desc={t('settings.about.userDesc')} text={user} original={view.user} max={view.max} onChange={setUser} saving={saving} onSave={() => void save({ user })} />
          {warn && view.budget !== null && <div className="set-restart" role="status"><span className="set-restart-icon"><Icon name="alert" size={15} /></span><span>{t('settings.about.warn', total, view.budget)}</span></div>}
        </>
      )}
      <div className="set-rows">
        <FieldRow label={t('settings.about.rerun')} desc={t('settings.about.rerunDesc')}>
          <button type="button" className="btn btn-secondary" onClick={onRerunSetup}>{t('settings.about.rerun')}</button>
        </FieldRow>
      </div>
    </div>
  );
}
