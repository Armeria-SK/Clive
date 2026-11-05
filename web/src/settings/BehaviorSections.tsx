import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import { useT } from '../i18n/index.ts';
import { FieldRow, NumberField, RangeField, SegField, SubTitle, TagsField, TextField, UsageField } from './fields.tsx';
import { updateAt, type Config } from './model.ts';
import { differs, errorFor, type SectionProps } from './types.ts';

type Hook = { matcher: string; command: string[]; timeoutMs: number; onError: 'deny' | 'ask' };
const HOOK_STAGES = ['preToolUse', 'postToolUse'] as const;
const HOOK_FIELD_PATH = /^tools\.hooks\.(preToolUse|postToolUse)\.\d+\.(matcher|command|timeoutMs|onError)$/u;
const SHELLS = ['auto', 'pwsh', 'powershell', 'bash', 'sh'] as const;

export function ToolsSection({ draft, saved, update, problems }: SectionProps) {
  const t = useT();
  const tools = draft.tools as Record<string, any>;
  const shell = tools.shell as Record<string, any>;
  const setTools = (patch: Record<string, unknown>) => update(c => updateAt(c, 'tools', patch));
  const setShell = (patch: Record<string, unknown>) => update(c => updateAt(c, 'tools', { shell: { ...(c.tools as Config).shell, ...patch } }));
  const changed = (read: (c: Config) => unknown) => differs(saved, draft, read);
  const hookRow = (stage: (typeof HOOK_STAGES)[number], i: number, key: keyof Hook) => {
    const path = `tools.hooks.${stage}.${i}.${key}`;
    return { path, error: errorFor(problems, path), changed: changed(c => c.tools?.hooks?.[stage]?.[i]?.[key]) };
  };
  const setHooks = (stage: (typeof HOOK_STAGES)[number], hooks: Hook[]) => update(c => updateAt(c, 'tools', { hooks: { ...(c.tools as Config).hooks, [stage]: hooks } }));

  return (
    <div className="set-stack">
      <div className="set-rows">
        <SubTitle>{t('settings.tools.shellTitle')}</SubTitle>
        <FieldRow label={t('settings.tools.deny')} desc={t('settings.tools.denyDesc')} changed={changed(c => c.tools.deny)} path="tools.deny" error={errorFor(problems, 'tools.deny')}>
          <TagsField tags={tools.deny} label={t('settings.tools.deny')} placeholder="~/.ssh" onChange={v => setTools({ deny: v })} />
        </FieldRow>
        <FieldRow label={t('settings.tools.outside')} desc={t('settings.tools.outsideDesc')} changed={changed(c => c.tools.outsideRoots)} path="tools.outsideRoots">
          <SegField value={tools.outsideRoots as string} label={t('settings.tools.outside')} options={[{ value: 'ask', label: t('settings.tools.ask') }, { value: 'deny', label: t('settings.tools.block') }]} onChange={v => setTools({ outsideRoots: v })} />
        </FieldRow>
        <FieldRow label={t('settings.tools.shellEnabled')} changed={changed(c => c.tools.shell.enabled)} path="tools.shell.enabled">
          <SegField value={Boolean(shell.enabled)} label={t('settings.tools.shellEnabled')} options={[{ value: true, label: t('settings.tools.use') }, { value: false, label: t('settings.tools.noUse') }]} onChange={v => setShell({ enabled: v })} />
        </FieldRow>
        <FieldRow label={t('settings.tools.shellKind')} changed={changed(c => c.tools.shell.shell)} path="tools.shell.shell">
          <SegField value={shell.shell as string} label={t('settings.tools.shellKind')} options={SHELLS.map(s => ({ value: s as string, label: s === 'auto' ? t('settings.tools.auto') : s }))} onChange={v => setShell({ shell: v })} />
        </FieldRow>
        <FieldRow label={t('settings.tools.shellTimeout')} changed={changed(c => c.tools.shell.timeoutSec)} path="tools.shell.timeoutSec" error={errorFor(problems, 'tools.shell.timeoutSec')}>
          <NumberField value={shell.timeoutSec as number} label={t('settings.tools.shellTimeout')} unit={t('settings.unit.seconds')} min={1} max={3600} onChange={v => v !== undefined && setShell({ timeoutSec: v })} />
        </FieldRow>
        <FieldRow label={t('settings.tools.allowCmds')} changed={changed(c => c.tools.shell.allow)} path="tools.shell.allow">
          <TagsField tags={shell.allow} label={t('settings.tools.allowCmds')} onChange={v => setShell({ allow: v })} />
        </FieldRow>
        <FieldRow label={t('settings.tools.askCmds')} changed={changed(c => c.tools.shell.ask)} path="tools.shell.ask">
          <TagsField tags={shell.ask} label={t('settings.tools.askCmds')} onChange={v => setShell({ ask: v })} />
        </FieldRow>
        <FieldRow label={t('settings.tools.blockCmds')} desc={t('settings.tools.blockCmdsDesc')} changed={changed(c => c.tools.shell.deny)} path="tools.shell.deny">
          <TagsField tags={shell.deny} label={t('settings.tools.blockCmds')} onChange={v => setShell({ deny: v })} />
        </FieldRow>
        <FieldRow label={t('settings.tools.approvalWait')} desc={t('settings.tools.approvalWaitDesc')} changed={changed(c => c.tools.shell.approvalTimeoutSec)} path="tools.shell.approvalTimeoutSec" error={errorFor(problems, 'tools.shell.approvalTimeoutSec')}>
          <NumberField value={shell.approvalTimeoutSec as number} label={t('settings.tools.approvalWait')} unit={t('settings.unit.seconds')} min={10} max={3600} onChange={v => v !== undefined && setShell({ approvalTimeoutSec: v })} />
        </FieldRow>
      </div>

      <div className="set-rows">
        <SubTitle>{t('settings.tools.hooksTitle')}</SubTitle>
        <span className="set-row-desc">{t('settings.tools.hooksDesc')}</span>
        {HOOK_STAGES.map(stage => {
          const hooks = (tools.hooks?.[stage] ?? []) as Hook[];
          const edit = (i: number, patch: Partial<Hook>) => setHooks(stage, hooks.map((h, j) => (j === i ? { ...h, ...patch } : h)));
          return (
            <div className="set-hooks" key={stage}>
              <div className="set-row-between">
                <span className="set-route-title">{t(stage === 'preToolUse' ? 'settings.tools.hookPre' : 'settings.tools.hookPost')}</span>
                <button className="btn btn-ghost" onClick={() => setHooks(stage, [...hooks, { matcher: '.*', command: [], timeoutMs: 30_000, onError: 'deny' }])}><Icon name="plus" size={13} />{t('settings.tools.hookAdd')}</button>
              </div>
              {hooks.length === 0 && <span className="set-note">{t('settings.tools.hookNone')}</span>}
              {hooks.map((hook, i) => (
                <div className="set-hook" key={i}>
                  <FieldRow label={t('settings.tools.hookMatcher')} desc={t('settings.tools.hookMatcherDesc')} {...hookRow(stage, i, 'matcher')}>
                    <TextField value={hook.matcher} mono label={t('settings.tools.hookMatcher')} onChange={v => edit(i, { matcher: v })} />
                  </FieldRow>
                  <FieldRow label={t('settings.tools.hookCommand')} desc={t('settings.tools.hookCommandDesc')} {...hookRow(stage, i, 'command')}>
                    <TagsField tags={hook.command} label={t('settings.tools.hookCommand')} placeholder="node" onChange={v => edit(i, { command: v })} />
                  </FieldRow>
                  <FieldRow label={t('settings.tools.hookTimeout')} {...hookRow(stage, i, 'timeoutMs')}>
                    <NumberField value={hook.timeoutMs} label={t('settings.tools.hookTimeout')} unit={t('settings.unit.ms')} min={100} max={120000} onChange={v => v !== undefined && edit(i, { timeoutMs: v })} />
                  </FieldRow>
                  <FieldRow label={t('settings.tools.hookOnError')} desc={t('settings.tools.hookOnErrorDesc')} {...hookRow(stage, i, 'onError')}>
                    <SegField value={hook.onError} label={t('settings.tools.hookOnError')} options={[{ value: 'deny', label: t('settings.tools.block') }, { value: 'ask', label: t('settings.tools.ask') }]} onChange={v => edit(i, { onError: v })} />
                  </FieldRow>
                  <div className="set-danger"><button className="btn btn-ghost" onClick={() => setHooks(stage, hooks.filter((_, j) => j !== i))}><Icon name="x" size={13} />{t('settings.tools.hookRemove')}</button></div>
                </div>
              ))}
            </div>
          );
        })}
        {problems.filter(p => p.path.startsWith('tools.hooks') && !HOOK_FIELD_PATH.test(p.path)).map(p => <span className="set-row-error" role="alert" key={p.text}>{p.message}</span>)}
      </div>
    </div>
  );
}

export function WorkerSection({ draft, saved, update, problems }: SectionProps) {
  const t = useT();
  const worker = draft.worker as Record<string, any>;
  const set = (patch: Record<string, unknown>) => update(c => updateAt(c, 'worker', patch));
  const changed = (key: string) => differs(saved, draft, c => c.worker[key]);
  const err = (key: string) => errorFor(problems, `worker.${key}`);
  const number = (key: string, label: string, unit: string, min: number, max: number, desc?: string) => (
    <FieldRow label={label} desc={desc} changed={changed(key)} path={`worker.${key}`} error={err(key)}>
      <NumberField value={worker[key] as number} label={label} unit={unit} min={min} max={max} onChange={v => v !== undefined && set({ [key]: v })} />
    </FieldRow>
  );
  return (
    <div className="set-rows">
      <FieldRow label={t('settings.worker.enabled')} desc={t('settings.worker.enabledDesc')} changed={changed('enabled')} path="worker.enabled">
        <SegField value={Boolean(worker.enabled)} label={t('settings.worker.enabled')} options={[{ value: true, label: t('settings.worker.on') }, { value: false, label: t('settings.worker.off') }]} onChange={v => set({ enabled: v })} />
      </FieldRow>
      <FieldRow label={t('settings.worker.autonomy')} desc={t('settings.worker.autonomyDesc')} changed={changed('autonomy')} path="worker.autonomy">
        <SegField value={Boolean(worker.autonomy)} label={t('settings.worker.autonomy')} options={[{ value: true, label: t('settings.worker.on') }, { value: false, label: t('settings.worker.off') }]} onChange={v => set({ autonomy: v })} />
      </FieldRow>
      {number('maxRunsPerHour', t('settings.worker.maxPerHour'), t('settings.unit.times'), 1, 120)}
      {number('idleMinutes', t('settings.worker.idle'), t('settings.unit.minutes'), 0, 1440)}
      <FieldRow label={t('settings.worker.quiet')} desc={t('settings.worker.quietDesc')} changed={changed('quietStart') || changed('quietEnd')} path="worker.quietStart" error={err('quietStart') ?? err('quietEnd')}>
        <RangeField from={worker.quietStart as string} to={worker.quietEnd as string} label={t('settings.worker.quiet')} onChange={(from, to) => set({ quietStart: from, quietEnd: to })} />
      </FieldRow>
      <FieldRow label={t('settings.worker.selfTasks')} changed={changed('selfTasksNeedApproval')} path="worker.selfTasksNeedApproval">
        <SegField value={Boolean(worker.selfTasksNeedApproval)} label={t('settings.worker.selfTasks')} options={[{ value: true, label: t('settings.worker.asProposal') }, { value: false, label: t('settings.worker.runNow') }]} onChange={v => set({ selfTasksNeedApproval: v })} />
      </FieldRow>
      {number('remindAfterHours', t('settings.worker.remind'), t('settings.unit.hours'), 1, 720)}
      {number('curiosityPerDay', t('settings.worker.curiosity'), t('settings.unit.perDay'), 0, 48, t('settings.worker.curiosityDesc'))}
    </div>
  );
}

export function MemorySection({ draft, saved, update, problems }: SectionProps) {
  const t = useT();
  const memory = draft.memory as Record<string, any>;
  const [used, setUsed] = useState<{ user?: number; notes?: number }>({});
  useEffect(() => { void api.memories().then(r => setUsed({ user: r.books.user.used, notes: r.books.notes.used })).catch(() => undefined); }, []);
  const set = (patch: Record<string, unknown>) => update(c => updateAt(c, 'memory', patch));
  return (
    <div className="set-stack">
      <div className="set-rows">
        <FieldRow label={t('settings.memory.user')} desc={t('settings.memory.userDesc')} changed={differs(saved, draft, c => c.memory.userMaxChars)} path="memory.userMaxChars" error={errorFor(problems, 'memory.userMaxChars')}>
          <UsageField value={memory.userMaxChars as number} used={used.user} label={t('settings.memory.user')} min={200} max={50000} onChange={v => set({ userMaxChars: v })} />
        </FieldRow>
        <FieldRow label={t('settings.memory.notes')} desc={t('settings.memory.notesDesc')} changed={differs(saved, draft, c => c.memory.notesMaxChars)} path="memory.notesMaxChars" error={errorFor(problems, 'memory.notesMaxChars')}>
          <UsageField value={memory.notesMaxChars as number} used={used.notes} label={t('settings.memory.notes')} min={200} max={50000} onChange={v => set({ notesMaxChars: v })} />
        </FieldRow>
      </div>
      <a className="set-link-out" href="#/memory"><Icon name="bookmark" size={14} />{t('settings.memory.open')}</a>
    </div>
  );
}
