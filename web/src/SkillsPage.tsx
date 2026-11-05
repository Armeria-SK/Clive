import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type SettingsView, type SkillDraft, type SkillSummary } from './api.ts';
import { FoldersPanel } from './FoldersPanel.tsx';
import { Icon } from './icons.tsx';
import { formatDateTime, useT } from './i18n/index.ts';
import type { SkillTarget } from './routes.ts';
import { SkillDialog, type SkillDialogState } from './SkillDialog.tsx';
import {
  applyFolders, cloneFolders, EFFECT_LABEL, findDraft, foldersEqual, foldersFromConfig, skillRows, TOOL_CATALOG, type FolderDraft, type SkillRow,
} from './skills-meta.ts';
import { toast } from './toast.tsx';
import { ZoneNote } from './ZoneNote.tsx';

type Segment = 'skills' | 'tools' | 'folders';
const SEGMENTS: readonly Segment[] = ['skills', 'tools', 'folders'];

interface FolderState { saved: FolderDraft; draft: FolderDraft; outside: 'ask' | 'deny' }

const outsideOf = (config: SettingsView['config']): 'ask' | 'deny' => (config.tools?.outsideRoots === 'deny' ? 'deny' : 'ask');
const rowHash = (row: SkillRow): string => `#/skills/${row.kind === 'draft' ? 'draft/' : ''}${encodeURIComponent(row.name)}`;

interface Props {
  target?: SkillTarget | undefined;
  revision: number;
}

// スキル・ツール。スキルの一覧とレビュー待ちの下書き、道具の一覧（見るだけ）、触れてよいフォルダ。
export function SkillsPage({ target, revision }: Props) {
  const t = useT();
  const [segment, setSegment] = useState<Segment>('skills');
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [drafts, setDrafts] = useState<SkillDraft[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [folders, setFolders] = useState<FolderState | null>(null);
  const [foldersBusy, setFoldersBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(n => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    api.skills().then(r => { if (!cancelled) { setSkills(r.skills); setFailed(false); } }, () => { if (!cancelled) setFailed(true); });
    api.review().then(r => { if (!cancelled) setDrafts(r.skillDrafts); }, () => { if (!cancelled) setDrafts(current => current ?? []); });
    return () => { cancelled = true; };
  }, [revision, tick]);
  useEffect(() => {
    let cancelled = false;
    api.settings().then(s => {
      if (cancelled) return;
      const saved = foldersFromConfig(s.config);
      setFolders({ saved, draft: cloneFolders(saved), outside: outsideOf(s.config) });
    }, () => undefined);
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => skillRows(drafts ?? [], skills ?? []), [drafts, skills]);
  const dialog: SkillDialogState | null = creating ? { kind: 'new' } : target ? { kind: target.kind, name: target.name } : null;
  const close = useCallback(() => {
    if (creating) setCreating(false);
    else if (target) location.hash = '#/skills';
  }, [creating, target]);
  // 無いスキルへのリンクは、戻るで同じリンクに戻らないよう、履歴を置き換えて一覧へ移す
  const skillMissing = useCallback(() => location.replace('#/skills'), []);
  // 下書きが一覧に無いとき、古い一覧のせいかもしれないので、取り直してから「もう処理されている」と判断する
  const checking = useRef<string | null>(null);
  const draftMissing = useCallback((name: string) => {
    if (checking.current === name) return;
    checking.current = name;
    api.review().then(r => {
      setDrafts(r.skillDrafts);
      if (findDraft(r.skillDrafts, name)) return;
      toast({ kind: 'info', icon: 'info', title: t('skills.draft.gone'), body: name });
      location.replace(skills?.some(s => s.name === name) ? `#/skills/${encodeURIComponent(name)}` : '#/skills');
    }).catch(() => undefined).finally(() => { checking.current = null; });
  }, [skills, t]);

  const foldersDirty = folders !== null && !foldersEqual(folders.draft, folders.saved);
  // 保存していないフォルダの変更があるまま、再読み込みや閉じる操作をしようとしたら、ブラウザに確かめさせる
  useEffect(() => {
    if (!foldersDirty) return undefined;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [foldersDirty]);

  // 保存の直前に最新の設定を取り直す。開いてから別の場所で変わっていたら、上書きせずに止める
  const saveFolders = async () => {
    if (!folders) return;
    setFoldersBusy(true); setProblems([]);
    try {
      const latest = await api.settings();
      if (!foldersEqual(foldersFromConfig(latest.config), folders.saved)) { setProblems([t('folders.changedElsewhere')]); return; }
      const result = await api.saveSettings(applyFolders(latest.config, folders.draft));
      const saved = foldersFromConfig(result.config);
      setFolders({ saved, draft: cloneFolders(saved), outside: outsideOf(result.config) });
      toast({ kind: 'done', title: t('folders.saved') });
    } catch (error) {
      if (error instanceof ApiError) setProblems(error.body?.problems?.length ? error.body.problems : [error.message]);
      else setProblems([t('folders.saveFailed')]);
    } finally { setFoldersBusy(false); }
  };

  // 「元に戻す」は、サーバーの最新の設定を読み直す（別の場所で変わっていた分も、ここで取り込む）
  const revertFolders = () => {
    setProblems([]);
    api.settings().then(s => {
      const saved = foldersFromConfig(s.config);
      setFolders({ saved, draft: cloneFolders(saved), outside: outsideOf(s.config) });
    }, () => setFolders(current => (current ? { ...current, draft: cloneFolders(current.saved) } : current)));
  };

  const counts: Record<Segment, number | null> = { skills: skills || drafts ? rows.length : null, tools: TOOL_CATALOG.length, folders: folders ? folders.draft.roots.length : null };

  return (
    <section className="view">
      <div className="view-inner">
        <div className="view-head">
          <div className="view-titles">
            <h1 className="view-title">{t('skills.title')}</h1>
            <span className="view-sub">{t('skills.subtitle')}</span>
          </div>
          <div className="view-actions">
            {segment === 'skills' && (
              <button className="btn btn-secondary" onClick={() => setCreating(true)}><Icon name="plus" size={13} />{t('skills.new')}</button>
            )}
            <div className="seg sk-seg" role="radiogroup" aria-label={t('skills.segLabel')}>
              {SEGMENTS.map(seg => (
                <label className="seg-opt" key={seg}>
                  <input type="radio" name="skills-segment" checked={segment === seg} onChange={() => setSegment(seg)} />
                  {t(`skills.seg.${seg}`)}
                  {counts[seg] !== null && <span className="sk-count">{counts[seg]}</span>}
                </label>
              ))}
            </div>
          </div>
        </div>

        {segment === 'skills' && (
          <>
            <p className="view-zone"><ZoneNote /></p>
            {!skills && !drafts ? <p className="view-note">{failed ? t('skills.loadFailed') : t('skills.loading')}</p>
              : !rows.length ? <p className="view-note">{t('skills.empty')}</p>
              : (
                <div className="sk-list">
                  {rows.map(row => (
                    <a key={`${row.kind}:${row.name}`} className="sk-row" href={rowHash(row)}>
                      <span className="sk-row-head">
                        <span className="sk-row-name">{row.name}</span>
                        {row.kind === 'draft' && <span className="tag tag-outline">{t('skills.draftTag')}</span>}
                        {row.kind === 'draft' && <span className="tag tag-neutral">{t(row.revises ? 'skills.draftRevision' : 'skills.draftNew')}</span>}
                      </span>
                      <span className="sk-row-meta">
                        {row.kind === 'draft' ? t('skills.draftWhen', formatDateTime(row.at))
                          : row.uses > 0 ? t('skills.usage', row.uses, formatDateTime(row.lastUsedAt)) : t('skills.unused')}
                      </span>
                      <span className="sk-row-desc">{row.description}</span>
                    </a>
                  ))}
                </div>
              )}
          </>
        )}

        {segment === 'tools' && (
          <div className="sk-tools">
            <p className="view-note">{t('tools.note')}</p>
            {TOOL_CATALOG.map(tool => (
              <div className="sk-tool" key={tool.name}>
                <span className="sk-tool-icon"><Icon name={tool.icon} size={16} /></span>
                <div className="sk-tool-text">
                  <span className="sk-tool-name">{tool.name}</span>
                  <span className="sk-tool-desc">{t(tool.desc)}</span>
                </div>
                <span className="tag tag-neutral">{t(EFFECT_LABEL[tool.effect])}</span>
              </div>
            ))}
          </div>
        )}

        {segment === 'folders' && (
          folders
            ? (
              <FoldersPanel
                draft={folders.draft} saved={folders.saved} outside={folders.outside} dirty={foldersDirty} busy={foldersBusy} problems={problems}
                onChange={draft => { setFolders({ ...folders, draft }); setProblems([]); }}
                onSave={() => void saveFolders()}
                onRevert={revertFolders}
              />
            )
            : <p className="view-note">{t('skills.loading')}</p>
        )}
      </div>

      <SkillDialog
        dialog={dialog} drafts={drafts} findDraft={name => findDraft(drafts ?? [], name)}
        onClose={close} onChanged={reload} onSkillMissing={skillMissing} onDraftMissing={draftMissing}
      />
    </section>
  );
}
