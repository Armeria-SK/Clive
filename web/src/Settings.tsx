import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type ModelView, type Profile, type SettingsView } from './api.ts';
import { useSaveShortcut } from './hooks.ts';
import { Icon } from './icons.tsx';
import { applyServerSettings, formatDateTimeSmart, getLanguagePreference, useT } from './i18n/index.ts';
import { adoptLanguageInDraft, withAdoptedLanguage } from './language.ts';
import { modLabel } from './keys.ts';
import {
  countChanges, isSection, parseProblem, SECTION_GROUPS, sectionChanged, type Config, type Problem, type SettingsSection,
} from './settings/model.ts';
import { SectionView } from './settings/SectionView.tsx';
import { toast } from './toast.tsx';
import './styles/settings.css';

const SECTION_KEY = 'clive.settingsSection';

function loadSection(): SettingsSection {
  try { const saved = sessionStorage.getItem(SECTION_KEY); if (isSection(saved)) return saved; } catch { }
  return 'models';
}

const withoutProfile = (config: Config): string => JSON.stringify({ ...config, profile: undefined });

export function Settings({ onProfile }: { onProfile: (p: Profile) => void }) {
  const t = useT();
  const [view, setView] = useState<SettingsView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saved, setSaved] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [models, setModels] = useState<ModelView[]>([]);
  const [probing, setProbing] = useState(false);
  const [section, setSectionState] = useState<SettingsSection>(loadSection);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [busy, setBusy] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [reverts, setReverts] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const pendingField = useRef<string | null>(null);
  const navRef = useRef<HTMLElement>(null);

  const setSection = useCallback((next: SettingsSection) => {
    setSectionState(next);
    try { sessionStorage.setItem(SECTION_KEY, next); } catch { }
    scroller.current?.scrollTo({ top: 0 });
  }, []);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const [s, m] = await Promise.all([api.settings(), api.models()]);
      setView(s); setModels(m.models); setSaved(s.config); setDraft(s.config); setRestartRequired(s.restartRequired); setProblems([]);
      applyServerSettings(s);
    } catch { setLoadFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // 設定を開いたまま、ほかの場所で言語が保存されたら、保存済みと編集中の language を合わせる
  const preference = getLanguagePreference();
  const savedLanguage = useRef<unknown>(undefined);
  savedLanguage.current = saved?.language;
  useEffect(() => {
    setSaved(current => (current ? withAdoptedLanguage(current, preference) : current));
    setDraft(current => (current ? adoptLanguageInDraft(current, savedLanguage.current, preference) : current));
  }, [preference]);

  const dirty = saved && draft ? countChanges(saved, draft) : 0;
  const update = useCallback((change: (config: Config) => Config) => { setDraft(current => (current ? change(current) : current)); }, []);

  async function probe() {
    setProbing(true);
    try { setModels((await api.probe()).models); } catch { toast({ title: t('toast.actionFailed'), icon: 'alert' }); } finally { setProbing(false); }
  }

  async function save() {
    if (!saved || !draft || busy || dirty === 0) return;
    setBusy(true); setProblems([]);
    try {
      let next: Config;
      if (withoutProfile(draft) !== withoutProfile(saved)) {
        const result = await api.saveSettings(draft);
        setView(result); setModels(result.models); setRestartRequired(result.restartRequired);
        next = result.config;
        void api.profile().then(onProfile).catch(() => undefined);
      } else {
        const p = await api.saveProfile(draft.profile);
        onProfile(p);
        next = { ...saved, profile: { ...saved.profile, name: p.name, shape: p.shape, color: p.color, motion: p.motion } };
      }
      setSaved(next); setDraft(next);
      applyServerSettings({ config: next });
      setLastSavedAt(Date.now());
      toast({ kind: 'done', icon: 'check', title: t('settings.saved') });
    } catch (error) {
      const texts = error instanceof ApiError ? (error.body?.problems?.length ? error.body.problems as string[] : [error.message]) : [t('settings.saveFailed')];
      setProblems(texts.map(text => parseProblem(text, draft)));
    } finally { setBusy(false); }
  }
  useSaveShortcut(() => { void save(); });

  // 元に戻したら、画面の中だけに残っている入力（JSON の欄に書きかけの文字など）も捨てる
  const revert = () => { if (saved) { setDraft(saved); setProblems([]); setReverts(n => n + 1); } };
  const goProblem = (problem: Problem) => {
    if (problem.section) setSection(problem.section);
    if (problem.modelId) setSelectedModel(problem.modelId);
    if (problem.providerId) setSelectedProvider(problem.providerId);
    pendingField.current = problem.path;
  };
  useEffect(() => {
    const path = pendingField.current;
    if (!path) return;
    pendingField.current = null;
    const el = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-field]') ?? [])].find(node => node.dataset.field === path);
    el?.scrollIntoView({ block: 'center' });
  });

  // 狭い画面では節の一覧が横に並ぶので、選んでいる節（前回開いていた節など）が見える所まで寄せる
  const loaded = Boolean(saved && draft && view);
  useEffect(() => { navRef.current?.querySelector('.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }, [section, loaded]);

  const meta = useMemo(() => SECTION_GROUPS.flatMap(g => g.items).find(i => i.id === section)!, [section]);

  if (!saved || !draft || !view) {
    return (
      <section className="set-loading">
        <p className="muted">{loadFailed ? t('settings.loadFailed') : t('settings.loading')}</p>
        {loadFailed && <button className="btn btn-secondary" onClick={() => void load()}>{t('settings.retry')}</button>}
      </section>
    );
  }

  const dot = (id: SettingsSection) => sectionChanged(saved, draft, id) || problems.some(p => p.section === id) || (id === 'server' && restartRequired);

  return (
    <section className="set">
      <nav className="set-nav" ref={navRef} aria-label={t('nav.settings')}>
        <h1 className="set-nav-title">{t('nav.settings')}</h1>
        {SECTION_GROUPS.map(group => (
          <div className="set-nav-group" key={group.label}>
            <span className="set-nav-label">{t(group.label)}</span>
            {group.items.map(item => (
              <button key={item.id} className={`set-nav-item${item.id === section ? ' active' : ''}`} aria-current={item.id === section ? 'page' : undefined} onClick={() => setSection(item.id)}>
                <span>{t(item.label)}</span>
                {dot(item.id) && <span className="set-dot" role="img" aria-label={t('settings.field.changed')} />}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="set-main">
        <div className="set-scroll" ref={scroller}>
          <div className="set-inner" key={section}>
            {view.configError && (
              <div className="set-banner" role="alert">
                <span className="set-banner-icon"><Icon name="alert" size={16} /></span>
                <div className="set-banner-body">
                  <strong>{t('settings.configBroken')}</strong>
                  <ul>{view.configError.problems.map(p => <li key={p}>{p}</li>)}</ul>
                </div>
              </div>
            )}
            <div className="set-head">
              <span className="set-crumb">{t('settings.breadcrumb')}</span>
              <h2 className="set-title">{t(meta.label)}</h2>
              <span className="set-desc">{t(meta.desc)}</span>
            </div>
            {problems.length > 0 && (
              <div className="set-banner" role="alert">
                <span className="set-banner-icon"><Icon name="alert" size={16} /></span>
                <div className="set-banner-body">
                  <strong>{t('settings.problemsTitle', problems.length)}</strong>
                  {problems.map(p => (
                    <button key={p.text} className="set-problem" onClick={() => goProblem(p)}>
                      {p.path && <span className="set-problem-path">{p.path}</span>}<span>{p.message}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {restartRequired && (
              <div className="set-restart" role="status">
                <span className="set-restart-icon"><Icon name="refresh" size={15} /></span>
                <span><strong>{t('settings.restartRequired')}</strong> {t('settings.restartHowto')}</span>
              </div>
            )}
            <SectionView
              key={reverts} section={section} draft={draft} saved={saved} update={update} problems={problems}
              models={models} probing={probing} onProbe={() => void probe()}
              selectedModel={selectedModel} onSelectModel={setSelectedModel} selectedProvider={selectedProvider} onSelectProvider={setSelectedProvider}
              apiKeys={view.apiKeys} configPath={view.configPath} hasConfigError={Boolean(view.configError)} lastSavedAt={lastSavedAt}
            />
          </div>
        </div>
        {dirty > 0 && (
          <div className="set-bar" role="region" aria-label={t('settings.bar.label')}>
            <span className="set-bar-dot" />
            <span className="set-bar-text">{t('settings.bar.changes', dirty)}</span>
            {lastSavedAt && <span className="set-bar-last">{t('settings.bar.lastSaved', formatDateTimeSmart(lastSavedAt))}</span>}
            <span className="set-bar-fill" />
            <button className="btn btn-ghost" onClick={revert} disabled={busy}>{t('settings.bar.revert')}</button>
            <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>{t('settings.bar.save')}<span className="set-bar-kbd">{modLabel()}S</span></button>
          </div>
        )}
      </div>
    </section>
  );
}
