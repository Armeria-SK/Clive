import { useState } from 'react';
import { api, ApiError, type ToolInfo } from './api.ts';
import { useEscapeLayer } from './hooks.ts';
import { Icon } from './icons.tsx';
import { useT } from './i18n/index.ts';
import { openSettingsSection } from './settings/model.ts';
import { AccessConfirm } from './settings/AccessConfirm.tsx';
import { toolPolicyLoosened, type Access } from './settings/access.ts';
import { EFFECT_LABEL, orderTools, POLICY_LABEL, toolLook } from './skills-meta.ts';
import { toast } from './toast.tsx';
import { TOOL_POLICIES, type ToolPolicy } from '../../src/tools/tool-policy.ts';

interface Props {
  tools: readonly ToolInfo[] | null;
  failed: boolean;
  onChanged: (tool: ToolInfo) => void;
  onReload: () => void;
}

// 道具の一覧と、道具ごとの方針（承認なし / 承認を求める / 止める）。押すとすぐ保存する。
// 緩める変更（止める → 承認を求める・承認なし、承認を求める → 承認なし）は、設定の「広がる変更」と同じ確かめを出してから保存する
export function ToolsList({ tools, failed, onChanged, onReload }: Props) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ tool: ToolInfo; to: ToolPolicy; item: Access } | null>(null);
  useEscapeLayer('dialog', confirm !== null, () => setConfirm(null));

  async function save(tool: ToolInfo, to: ToolPolicy) {
    setConfirm(null);
    setBusy(tool.name);
    try {
      const saved = (await api.setToolPolicy(tool.name, to)).tool;
      onChanged(saved);
      toast({
        kind: 'done', icon: 'check', title: t('tools.policy.saved', tool.name, t(POLICY_LABEL[saved.policy])),
        ...(saved.policy === 'ask' && saved.allowedIn.includes('review') ? { body: t('tools.policy.reviewNote') } : {}),
      });
    } catch (error) {
      toast({ icon: 'alert', title: t('tools.policy.failed'), ...(error instanceof ApiError ? { body: error.message } : {}) });
      onReload();
    } finally { setBusy(null); }
  }

  function choose(tool: ToolInfo, to: ToolPolicy) {
    if (to === tool.policy || busy) return;
    const loosened = toolPolicyLoosened(tool.name, tool.policy, to);
    if (loosened) setConfirm({ tool, to, item: loosened });
    else void save(tool, to);
  }

  return (
    <div className="sk-tools">
      <p className="view-note">{t('tools.note')} <a className="chat-link" href="#/settings" onClick={() => openSettingsSection('tools')}>{t('tools.foldersLink')}</a></p>
      <p className="view-note sk-policy-note">{t('tools.policy.allowNote')}</p>
      {!tools ? <p className="view-note">{failed ? t('tools.loadFailed') : t('skills.loading')}</p> : null}
      {!tools && failed && <button type="button" className="btn btn-secondary sk-retry" onClick={onReload}>{t('settings.retry')}</button>}
      {tools && orderTools(tools).map(tool => {
        const look = toolLook(tool.name);
        return (
          <div key={tool.name}>
            <div className="sk-tool">
              <span className="sk-tool-icon"><Icon name={look.icon} size={16} /></span>
              <div className="sk-tool-text">
                <span className="sk-tool-name">{tool.name}</span>
                {look.desc && <span className="sk-tool-desc">{t(look.desc)}</span>}
              </div>
              <span className="tag tag-neutral">{t(EFFECT_LABEL[tool.effect])}</span>
              {tool.configurable ? (
                <div className="seg sk-seg sk-policy" role="radiogroup" aria-label={t('tools.policy.label', tool.name)}>
                  {TOOL_POLICIES.map(policy => (
                    <label className="seg-opt" key={policy}>
                      <input type="radio" name={`policy-${tool.name}`} checked={tool.policy === policy} disabled={busy !== null} onChange={() => choose(tool, policy)} />
                      {t(POLICY_LABEL[policy])}
                    </label>
                  ))}
                </div>
              ) : <span className="sk-tool-fixed">{t('tools.policy.fixed')}</span>}
              {tool.configurable && tool.policy === 'block' && <span className="sk-tool-sub">{t('tools.policy.blockNote')}</span>}
              {tool.configurable && tool.policy === 'ask' && tool.allowedIn.includes('review') && <span className="sk-tool-sub">{t('tools.policy.reviewNote')}</span>}
            </div>
            {confirm?.tool.name === tool.name && (
              <AccessConfirm items={[confirm.item]} busy={busy !== null} onCancel={() => setConfirm(null)} onConfirm={() => void save(confirm.tool, confirm.to)} />
            )}
          </div>
        );
      })}
    </div>
  );
}
