import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type SkillDraft, type SkillSummary } from './api.ts';
import { Icon } from './icons.tsx';
import { formatDateTime, useT } from './i18n/index.ts';
import type { SkillTarget } from './routes.ts';
import { openSettingsSection } from './settings/model.ts';
import { SkillDialog, type SkillDialogState } from './SkillDialog.tsx';
import { EFFECT_LABEL, findDraft, skillRows, TOOL_CATALOG, type SkillRow } from './skills-meta.ts';
import { toast } from './toast.tsx';
import { ZoneNote } from './ZoneNote.tsx';

type Segment = 'skills' | 'tools';
const SEGMENTS: readonly Segment[] = ['skills', 'tools'];

const rowHash = (row: SkillRow): string => `#/skills/${row.kind === 'draft' ? 'draft/' : ''}${encodeURIComponent(row.name)}`;

interface Props {
  target?: SkillTarget | undefined;
  revision: number;
}

// スキル・ツール。スキルの一覧とレビュー待ちの下書き、道具の一覧（見るだけ。触れてよいフォルダの編集は、設定の「道具」）。
export function SkillsPage({ target, revision }: Props) {
  const t = useT();
  const [segment, setSegment] = useState<Segment>('skills');
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [drafts, setDrafts] = useState<SkillDraft[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(n => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    api.skills().then(r => { if (!cancelled) { setSkills(r.skills); setFailed(false); } }, () => { if (!cancelled) setFailed(true); });
    api.review().then(r => { if (!cancelled) setDrafts(r.skillDrafts); }, () => { if (!cancelled) setDrafts(current => current ?? []); });
    return () => { cancelled = true; };
  }, [revision, tick]);
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

  const counts: Record<Segment, number | null> = { skills: skills || drafts ? rows.length : null, tools: TOOL_CATALOG.length };

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
            <p className="view-note">{t('tools.note')} <a className="chat-link" href="#/settings" onClick={() => openSettingsSection('tools')}>{t('tools.foldersLink')}</a></p>
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
      </div>

      <SkillDialog
        dialog={dialog} drafts={drafts} findDraft={name => findDraft(drafts ?? [], name)}
        onClose={close} onChanged={reload} onSkillMissing={skillMissing} onDraftMissing={draftMissing}
      />
    </section>
  );
}
