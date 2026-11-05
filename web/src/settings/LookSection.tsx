import { useState } from 'react';
import { api, type TemplatesView } from '../api.ts';
import { Avatar, SHAPE_NAMES } from '../Avatar.tsx';
import type { Runtime } from '../avatar.ts';
import { useTheme } from '../hooks.ts';
import { copyText } from '../clipboard.ts';
import { Icon } from '../icons.tsx';
import { LANGUAGES, useT, type LanguagePreference } from '../i18n/index.ts';
import { configWithLanguage } from '../language.ts';
import { setThemeMode, type ThemeMode } from '../theme.ts';
import { toast } from '../toast.tsx';
import { ColorField, FieldRow, SegField } from './fields.tsx';
import { updateAt } from './model.ts';
import { differs, errorFor, type SectionProps } from './types.ts';

const MOTIONS = ['auto', 'none', 'float', 'sway', 'pulse'] as const;
const DEFAULT_COLOR = '#61B8A5';
type Preview = 'work' | 'wait' | 'sleep' | 'idle' | 'celebrate';
const PREVIEWS: readonly Preview[] = ['work', 'wait', 'sleep', 'idle', 'celebrate'];
const RUNTIME_OF: Record<Preview, { runtime: Runtime; sleeping: boolean }> = {
  work: { runtime: 'work', sleeping: false }, wait: { runtime: 'wait', sleeping: false }, sleep: { runtime: 'idle', sleeping: true },
  idle: { runtime: 'idle', sleeping: false }, celebrate: { runtime: 'celebrate', sleeping: false },
};

export function LookSection({ draft, saved, update, problems }: SectionProps) {
  const t = useT();
  const { mode: themeMode } = useTheme();
  const profile = draft.profile as { name: string; shape: string; color: string; motion: string };
  const language = (draft.language as LanguagePreference | undefined) ?? 'auto';
  const [preview, setPreview] = useState<Preview>('idle');
  const [defaults, setDefaults] = useState<TemplatesView | null>(null);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const [defaultsFailed, setDefaultsFailed] = useState(false);
  const set = (patch: Record<string, unknown>) => update(c => updateAt(c, 'profile', patch));
  const changed = (key: string) => differs(saved, draft, c => c.profile?.[key]);
  const motionLabel = (motion: string) => t(`settings.look.motion.${motion as (typeof MOTIONS)[number]}`);

  const toggleDefaults = () => {
    const open = !defaultsOpen;
    setDefaultsOpen(open);
    if (open && !defaults) {
      setDefaultsFailed(false);
      void api.templates('en').then(setDefaults).catch(() => setDefaultsFailed(true));
    }
  };
  const copy = (text: string) => {
    void copyText(text).then(ok => toast(ok
      ? { kind: 'done', icon: 'copy', title: t('settings.keys.copied') }
      : { icon: 'alert', title: t('settings.keys.copyFailed'), body: t('settings.keys.copyFailedBody') }));
  };
  const state = RUNTIME_OF[preview];

  return (
    <div className="set-stack">
      <div className="set-look-card">
        <span className="set-look-avatar"><Avatar key={preview} shape={profile.shape} color={profile.color} motion={profile.motion} runtime={state.runtime} sleeping={state.sleeping} size={88} seed={profile.name} /></span>
        <div className="set-look-text">
          <span className="set-look-name">{profile.name || 'Clive'}</span>
          <span className="set-look-desc">{t('settings.look.summary', profile.shape, motionLabel(profile.motion))}</span>
          <div className="set-look-states" role="group" aria-label={t('settings.look.previewLabel')}>
            {PREVIEWS.map(p => <button key={p} className={`set-chip${p === preview ? ' on' : ''}`} aria-pressed={p === preview} onClick={() => setPreview(p)}>{t(`settings.look.state.${p}`)}</button>)}
          </div>
        </div>
      </div>

      <div className="set-rows">
        <span className="set-subtitle">{t('settings.look.shape')}</span>
        <div className="set-shapes" role="radiogroup" aria-label={t('settings.look.shape')}>
          {SHAPE_NAMES.map(name => (
            <button key={name} type="button" role="radio" aria-checked={profile.shape === name} aria-label={name} data-tip={name} className={`set-shape${profile.shape === name ? ' on' : ''}`} onClick={() => set({ shape: name })}>
              <Avatar shape={name} color={profile.color} motion="none" size={34} />
            </button>
          ))}
        </div>
      </div>

      <div className="set-rows">
        <FieldRow label={t('settings.look.color')} desc={t('settings.look.colorDesc')} changed={changed('color')} path="profile.color" error={errorFor(problems, 'profile.color')}>
          <ColorField value={profile.color} fallback={DEFAULT_COLOR} label={t('settings.look.color')} onChange={v => set({ color: v })} />
        </FieldRow>
        <FieldRow label={t('settings.look.motion')} desc={t('settings.look.motionDesc')} changed={changed('motion')} path="profile.motion">
          <SegField value={profile.motion} label={t('settings.look.motion')} options={MOTIONS.map(m => ({ value: m as string, label: motionLabel(m) }))} onChange={v => set({ motion: v })} />
        </FieldRow>
        <FieldRow label={t('settings.theme')} desc={t('settings.theme.desc')}>
          <SegField<ThemeMode> value={themeMode} label={t('settings.theme')} options={[{ value: 'auto', label: t('settings.theme.auto') }, { value: 'light', label: t('settings.theme.light') }, { value: 'dark', label: t('settings.theme.dark') }]} onChange={setThemeMode} />
        </FieldRow>
        <FieldRow label={t('settings.language')} desc={t('settings.language.desc')} changed={differs(saved, draft, c => c.language ?? null)} path="language" error={errorFor(problems, 'language')}>
          <SegField<LanguagePreference> value={language} label={t('settings.language')} options={[{ value: 'auto', label: t('settings.language.auto') }, ...LANGUAGES.map(l => ({ value: l as LanguagePreference, label: t(`lang.${l}`) }))]} onChange={v => update(c => configWithLanguage(c, v))} />
        </FieldRow>
      </div>

      <div className="set-rows">
        <button className="set-disclosure" onClick={toggleDefaults} aria-expanded={defaultsOpen}>
          <span className={`set-disclosure-icon${defaultsOpen ? ' open' : ''}`}><Icon name="chevR" size={12} /></span>{t('settings.language.defaults')}
        </button>
        <span className="set-row-desc">{t('settings.language.defaultsDesc')}</span>
        {defaultsOpen && !defaults && <span className="set-note">{defaultsFailed ? t('settings.language.defaultsFailed') : t('settings.loading')}</span>}
        {defaultsOpen && defaults && (
          <div className="set-defaults">
            {[{ name: 'rules.md', content: defaults.rules }, ...defaults.files].map(file => (
              <div className="set-default" key={file.name}>
                <div className="set-row-between"><span className="set-default-name">{file.name}</span><button className="btn btn-secondary" onClick={() => copy(file.content)}><Icon name="copy" size={13} />{t('settings.keys.copy')}</button></div>
                <pre className="set-pre">{file.content}</pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
