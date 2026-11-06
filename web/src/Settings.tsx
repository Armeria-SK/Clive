import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, type ModelView, type Profile, type SettingsView } from './api.ts';
import { ChatDialog } from './ChatDialog.tsx';
import { useEscapeLayer, useSaveShortcut } from './hooks.ts';
import { Icon } from './icons.tsx';
import { applyServerSettings, formatDateTimeSmart, getLanguagePreference, useT } from './i18n/index.ts';
import { adoptLanguageInDraft, withAdoptedLanguage } from './language.ts';
import { modLabel } from './keys.ts';
import { AccessConfirm } from './settings/AccessConfirm.tsx';
import { accessKey, accessWidening, type Access } from './settings/access.ts';
import { applyEdits, deepEqual, diffConfig, profilePatch } from './settings/merge.ts';
import {
  blockUnload, closeAction, countChanges, isSection, parseProblem, problemsOf, SECTION_GROUPS, SECTION_KEY, sectionChanged, type Config, type Problem, type SettingsSection,
} from './settings/model.ts';
import { editsToKeep, restoreKept, type KeptEdits } from './settings/keep.ts';
import { applyFailure, applyStep } from './settings/server-apply.ts';
import { SectionView } from './settings/SectionView.tsx';
import { SettingsFrame } from './settings/SettingsFrame.tsx';
import { toast } from './toast.tsx';
import './styles/settings.css';

function loadSection(): SettingsSection {
  try { const saved = sessionStorage.getItem(SECTION_KEY); if (isSection(saved)) return saved; } catch { }
  return 'models';
}


interface Props { onProfile: (p: Profile) => void; open: boolean; leaving: boolean; onClose: () => void; kept: { current: KeptEdits | null }; onRerunSetup: () => void }

// 設定は、今の画面の上に重ねるモーダル。open が false になったあとも、閉じる動きが終わる（leaving）まで描かれる。
export function Settings({ onProfile, open, leaving, onClose, kept, onRerunSetup }: Props) {
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
  const [conflicted, setConflicted] = useState(false);
  const [confirm, setConfirm] = useState<{ items: Access[]; key: string } | null>(null);
  const [askDiscard, setAskDiscard] = useState(false);
  const [applying, setApplying] = useState(false);
  const [lockOut, setLockOut] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pendingField = useRef<string | null>(null);
  const navRef = useRef<HTMLElement>(null);

  const setSection = useCallback((next: SettingsSection) => {
    setSectionState(next);
    try { sessionStorage.setItem(SECTION_KEY, next); } catch { }
    scroller.current?.scrollTo({ top: 0 });
  }, []);

  const keptToast = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;
  const load = useCallback(async (restore = false) => {
    setLoadFailed(false);
    try {
      const [s, m] = await Promise.all([api.settings(), api.models()]);
      const next = restore ? restoreKept(kept.current, s.config) : { saved: s.config, draft: s.config, restored: false };
      setView(s); setModels(m.models); setSaved(next.saved); setDraft(next.draft); setRestartRequired(s.restartRequired); setProblems([]);
      applyServerSettings(s);
      if (next.restored && !keptToast.current) { keptToast.current = true; toast({ kind: 'info', icon: 'info', title: tRef.current('settings.kept') }); }
    } catch { setLoadFailed(true); }
  }, [kept]);
  useEffect(() => { void load(true); }, [load]);

  // 設定を開いたまま、ほかの場所で言語が保存されたら、保存済みと編集中の language を合わせる
  const preference = getLanguagePreference();
  const savedLanguage = useRef<unknown>(undefined);
  savedLanguage.current = saved?.language;
  useEffect(() => {
    setSaved(current => (current ? withAdoptedLanguage(current, preference) : current));
    setDraft(current => (current ? adoptLanguageInDraft(current, savedLanguage.current, preference) : current));
  }, [preference]);

  const dirty = saved && draft ? countChanges(saved, draft) : 0;
  // 保存していない編集は、設定が閉じられても（戻る・トーストの操作など）次に開いたとき戻せるよう、いつも App の持ち物に写しておく
  useEffect(() => { if (saved && draft) kept.current = editsToKeep(saved, draft); }, [saved, draft, kept]);
  // 保存していない編集があるまま、ページを閉じる・読み直すときは、ブラウザに確かめさせる
  useEffect(() => {
    if (dirty === 0) return undefined;
    addEventListener('beforeunload', blockUnload);
    return () => removeEventListener('beforeunload', blockUnload);
  }, [dirty > 0]);
  // 編集が変わったら、出していた確認は取り下げる（確認した内容と、これから書く内容が食い違わないように）
  const update = useCallback((change: (config: Config) => Config) => { setConfirm(null); setDraft(current => (current ? change(current) : current)); }, []);

  async function probe() {
    setProbing(true);
    try { setModels((await api.probe()).models); } catch { toast({ title: t('toast.actionFailed'), icon: 'alert' }); } finally { setProbing(false); }
  }

  // 保存は「画面を開いたあとにほかの場所が変えた値」を巻き戻さない。直前に最新の設定を読み直し、自分が触った所だけを当てる。
  // 触った所をほかの場所も先に変えていたら、何も書かずに、その行を示す。
  // confirmedKey: 広がる内容を確かめてもらった印。いまの最新の設定で数え直した広がりが、確かめたものと同じときだけ書く。
  async function save(confirmedKey?: string) {
    if (!saved || !draft || busy || dirty === 0) return;
    setBusy(true); setProblems([]); setConflicted(false);
    try {
      const latest = (await api.settings()).config;
      const edits = diffConfig(saved, draft);
      const merged = applyEdits(latest, edits);
      if (merged.conflicts.length) {
        setProblems(merged.conflicts.map(c => parseProblem(`${c.path}: ${t('settings.conflict')}`, draft)));
        setConflicted(true);
        return;
      }
      // 範囲が広がる保存（触れないパスを外す・フォルダやシェルや外からの入口を足す・フックを足す、など）は、広がるものを並べて確かめてから書く
      const widening = accessWidening(latest, merged.config);
      if (widening.length && accessKey(widening) !== confirmedKey) {
        setConfirm({ items: widening, key: accessKey(widening) });
        return;
      }
      setConfirm(null);
      const profileOnly = profilePatch(edits);
      let next: Config;
      if (deepEqual(merged.config, latest)) {
        next = latest;
      } else if (profileOnly) {
        const p = await api.saveProfile(profileOnly);
        onProfile(p);
        next = { ...merged.config, profile: { ...merged.config.profile, name: p.name, shape: p.shape, color: p.color, motion: p.motion } };
      } else {
        const result = await api.saveSettings(merged.config);
        setView(result); setModels(result.models); setRestartRequired(result.restartRequired);
        next = result.config;
        void api.profile().then(onProfile).catch(() => undefined);
      }
      setSaved(next); setDraft(next);
      applyServerSettings({ config: next });
      setLastSavedAt(Date.now());
      toast({ kind: 'done', icon: 'check', title: t('settings.saved') });
    } catch (error) {
      setProblems(error instanceof ApiError ? problemsOf(error.body, error.message, draft) : problemsOf(undefined, t('settings.saveFailed'), draft));
    } finally { setBusy(false); }
  }
  // サーバーの設定（待ち受けと認証）を、止めずに入れ替える。反映するのは保存した設定で、編集中の分は含まない。この端末から入れなくなるときは、確かめて、もう一度押すときだけ force を付ける
  async function applyServer(force = false) {
    if (applying) return;
    setApplying(true); setLockOut(null);
    let moving = false;
    try {
      const step = applyStep(await api.applyServer(force), location.hash);
      if (step.kind === 'move') { moving = true; location.assign(step.to); return; }
      setRestartRequired(step.restartRequired);
      toast({ kind: 'done', icon: 'check', title: t('settings.restart.done') });
    } catch (error) {
      const failure = applyFailure(error);
      if (failure.kind === 'lockout') setLockOut(failure.message);
      else if (failure.kind === 'nothing') { setRestartRequired(false); toast({ kind: 'info', icon: 'info', title: t('settings.restart.already') }); }
      else toast({ icon: 'alert', title: t('settings.restart.failed'), ...(failure.message ? { body: failure.message } : {}) });
    } finally { if (!moving) setApplying(false); }
  }
  useSaveShortcut(() => { if (!confirm) void save(); });
  useEscapeLayer('dialog', confirm !== null, () => setConfirm(null));
  // × ・Esc・背景で閉じるとき、保存していない変更があれば、捨てる前に確かめる
  const requestClose = () => {
    const action = closeAction({ dirty, busy });
    if (action === 'close') onClose();
    else if (action === 'confirm') setAskDiscard(true);
  };
  useEscapeLayer('settings', open && !askDiscard, requestClose);

  // 元に戻したら、画面の中だけに残っている入力（JSON の欄に書きかけの文字など）も捨てる
  const revert = () => { if (saved) { setDraft(saved); setProblems([]); setConflicted(false); setConfirm(null); setReverts(n => n + 1); } };
  // 名前は画面に出る名前と SOUL.md の名乗りの両方をサーバーが書く。保存済みと編集中の名前も合わせる（合わせないと、次の保存で元に戻る）
  const renamed = (profile: Profile) => {
    const rename = (config: Config | null) => (config ? { ...config, profile: { ...config.profile, name: profile.name } } : config);
    setSaved(rename); setDraft(rename); onProfile(profile);
  };
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

  const frame = (children: ReactNode) => (
    <SettingsFrame leaving={leaving} label={t('nav.settings')} closeLabel={t('settings.close')} onClose={requestClose}>
      {children}
      {lockOut !== null && (
        <ChatDialog
          title={t('settings.restart.lockoutTitle')} onClose={() => setLockOut(null)}
          actions={(
            <>
              <button type="button" className="btn btn-ghost chat-plain" onClick={() => setLockOut(null)}>{t('settings.restart.lockoutCancel')}</button>
              <button type="button" className="btn btn-primary" onClick={() => void applyServer(true)}>{t('settings.restart.lockoutDo')}</button>
            </>
          )}
        >
          <p className="chat-dialog-text">{lockOut}</p>
          <p className="chat-dialog-text">{t('settings.restart.lockoutNote')}</p>
        </ChatDialog>
      )}
      {askDiscard && (
        <ChatDialog
          title={t('settings.discard.title')} onClose={() => setAskDiscard(false)}
          actions={(
            <>
              <button type="button" className="btn btn-ghost chat-plain" onClick={() => setAskDiscard(false)}>{t('settings.discard.keep')}</button>
              <button type="button" className="btn btn-primary" onClick={() => { revert(); setAskDiscard(false); onClose(); }}>{t('settings.discard.do')}</button>
            </>
          )}
        >
          <p className="chat-dialog-text">{t('settings.discard.body', dirty)}</p>
        </ChatDialog>
      )}
    </SettingsFrame>
  );

  if (!saved || !draft || !view) {
    return frame(
      <section className="set-loading">
        <p className="muted">{loadFailed ? t('settings.loadFailed') : t('settings.loading')}</p>
        {loadFailed && <button className="btn btn-secondary" onClick={() => void load()}>{t('settings.retry')}</button>}
      </section>,
    );
  }

  const dot = (id: SettingsSection) => sectionChanged(saved, draft, id) || problems.some(p => p.section === id) || (id === 'server' && restartRequired);

  return frame(
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
                  {conflicted && <button className="btn btn-secondary set-reload" onClick={() => void load()}>{t('settings.conflict.reload')}</button>}
                </div>
              </div>
            )}
            {restartRequired && (
              <div className="set-restart" role="status">
                <span className="set-restart-icon"><Icon name="refresh" size={15} /></span>
                <span><strong>{t('settings.restartRequired')}</strong> {t('settings.restartHowto')}</span>
                <button type="button" className="btn btn-secondary set-restart-do" onClick={() => void applyServer()} disabled={applying || busy}>
                  {applying && <span className="spin"><Icon name="loader" size={13} /></span>}{t(applying ? 'settings.restart.busy' : 'settings.restart.button')}
                </button>
              </div>
            )}
            <SectionView
              key={reverts} section={section} draft={draft} saved={saved} update={update} problems={problems}
              models={models} probing={probing} onProbe={() => void probe()}
              selectedModel={selectedModel} onSelectModel={setSelectedModel} selectedProvider={selectedProvider} onSelectProvider={setSelectedProvider}
              apiKeys={view.apiKeys} configPath={view.configPath} hasConfigError={Boolean(view.configError)} lastSavedAt={lastSavedAt}
              onNameSaved={renamed} onRerunSetup={onRerunSetup}
            />
          </div>
        </div>
        {confirm && <AccessConfirm items={confirm.items} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => void save(confirm.key)} />}
        {dirty > 0 && !confirm && (
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
    </section>,
  );
}
