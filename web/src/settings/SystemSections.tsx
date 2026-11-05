import { useState } from 'react';
import { Icon } from '../icons.tsx';
import { formatDateTimeSmart, formatRelative, useT } from '../i18n/index.ts';
import { FieldRow, NumberField, TagsField } from './fields.tsx';
import { updateAt, type Config } from './model.ts';
import { differs, errorFor, type SectionProps } from './types.ts';

export function ServerSection({ draft, saved, update, problems }: SectionProps) {
  const t = useT();
  const server = draft.server as Record<string, any>;
  const set = (patch: Record<string, unknown>) => update(c => updateAt(c, 'server', patch));
  const changed = (key: string) => differs(saved, draft, c => c.server[key]);
  return (
    <div className="set-rows">
      <FieldRow label={t('settings.server.port')} desc={t('settings.server.portDesc')} changed={changed('port')} path="server.port" error={errorFor(problems, 'server.port')}>
        <NumberField value={server.port as number} label={t('settings.server.port')} min={1} max={65535} width="110px" onChange={v => v !== undefined && set({ port: v })} />
      </FieldRow>
      <FieldRow label={t('settings.server.origins')} desc={t('settings.server.originsDesc')} changed={changed('origins')} path="server.origins" error={errorFor(problems, 'server.origins')}>
        <TagsField tags={server.origins} label={t('settings.server.origins')} placeholder="https://…ts.net" onChange={v => set({ origins: v })} />
      </FieldRow>
      <FieldRow label={t('settings.server.logins')} desc={t('settings.server.loginsDesc')} changed={changed('tailscaleLogins')} path="server.tailscaleLogins">
        <TagsField tags={server.tailscaleLogins} label={t('settings.server.logins')} placeholder="name@example.com" onChange={v => set({ tailscaleLogins: v })} />
      </FieldRow>
    </div>
  );
}

interface FileProps extends SectionProps {
  configPath: string;
  hasConfigError: boolean;
  lastSavedAt: number | null;
}

// 設定ファイルの中身。デザインの項目にない設定は、ここの JSON で直す。直した中身は、ほかの節と同じ「保存していない変更」になる。
export function FileSection({ draft, update, problems, configPath, hasConfigError, lastSavedAt }: FileProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [parseError, setParseError] = useState(false);
  const derived = JSON.stringify(draft, null, 2);
  const state = hasConfigError ? t('settings.file.stateBroken') : problems.length ? t('settings.file.stateProblems', problems.length) : t('settings.file.stateOk');
  const edit = (value: string) => {
    setText(value);
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      setParseError(false);
      update(() => parsed as Config);
    } catch { setParseError(true); }
  };
  return (
    <div className="set-stack">
      <div className="set-facts">
        <span className="set-fact-label">{t('settings.file.path')}</span><span className="set-fact-value mono">{configPath}</span>
        <span className="set-fact-label">{t('settings.file.state')}</span><span><span className={`tag ${hasConfigError || problems.length ? 'tag-outline' : 'tag-neutral'}`}>{state}</span></span>
        <span className="set-fact-label">{t('settings.file.lastSaved')}</span>
        <span className="set-fact-value">{lastSavedAt ? `${formatDateTimeSmart(lastSavedAt)} (${formatRelative(lastSavedAt)})` : t('settings.file.neverSaved')}</span>
      </div>
      <span className="set-row-desc">{t('settings.file.backup')}</span>
      <button className="set-disclosure" onClick={() => { setOpen(!open); setText(null); setParseError(false); }} aria-expanded={open}>
        <span className={`set-disclosure-icon${open ? ' open' : ''}`}><Icon name="chevR" size={12} /></span>{t('settings.file.view')}
      </button>
      {open && (
        <>
          <textarea
            className="input set-json" value={text ?? derived} spellCheck={false} rows={26} aria-label={t('settings.file.view')} aria-invalid={parseError || undefined}
            onChange={e => edit(e.target.value)} onBlur={() => { if (!parseError) setText(null); }}
          />
          {parseError && <span className="set-row-error" role="alert">{t('settings.file.parseError')}</span>}
        </>
      )}
    </div>
  );
}
