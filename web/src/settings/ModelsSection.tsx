import { useState } from 'react';
import type { ModelView } from '../api.ts';
import { copyText } from '../clipboard.ts';
import { Icon, type IconName } from '../icons.tsx';
import { formatNumber, getLanguage, useT, type PlainKey } from '../i18n/index.ts';
import { probeMessage } from '../server-text.ts';
import { toast } from '../toast.tsx';
import { FieldRow, IdField, NumberField, SegField, SubTitle, TextField } from './fields.tsx';
import { KeyField } from './KeyField.tsx';
import {
  addModel, addProvider, addToRoute, keyReady, keyUsage, moveInRoute, providerInUse, providerKeyEnv, removeFromRoute, removeModel, removeProvider, renameModel, renameProvider, secondsOf,
  sharedKeyWith, updateListItem, type Config, type Route,
} from './model.ts';
import { differs, errorFor, type SectionProps } from './types.ts';

const PROBE_KEY: Record<string, PlainKey> = {
  ok: 'probe.status.ok', too_small: 'probe.status.too_small', exceeds_model: 'probe.status.exceeds_model', unknown: 'probe.status.unknown',
  unreachable: 'probe.status.unreachable', no_api_key: 'probe.status.no_api_key', not_found: 'probe.status.not_found', error: 'probe.status.error',
};

const num = (n: number | undefined) => (typeof n === 'number' ? formatNumber(n) : '—');

interface ModelsProps extends SectionProps {
  probes: readonly ModelView[];
  probing: boolean;
  onProbe: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ModelsSection({ draft, saved, update, problems, probes, probing, onProbe, selectedId, onSelect }: ModelsProps) {
  const t = useT();
  const models = draft.models as Array<Record<string, any>>;
  const selected = models.find(m => m.id === selectedId) ?? models[0];
  const probeOf = (id: string) => probes.find(m => m.id === id)?.probe ?? null;
  const labelOf = (m: Record<string, any>) => m.label || m.id;
  const providerIds = (draft.providers as Array<{ id: string }>).map(p => p.id);

  const statusOf = (id: string): { text: string; icon: IconName; accent: boolean; ok: boolean } => {
    if (probing) return { text: t('settings.models.probing'), icon: 'loader', accent: true, ok: false };
    const p = probeOf(id);
    if (!p) return { text: t('probe.status.unchecked'), icon: 'help', accent: false, ok: false };
    const key = PROBE_KEY[p.status];
    return { text: key ? t(key) : p.status, icon: p.status === 'ok' ? 'circleCheck' : p.status === 'unknown' ? 'help' : 'alert', accent: p.status !== 'ok' && p.status !== 'unknown', ok: p.status === 'ok' };
  };

  const sel = selected ? statusOf(selected.id as string) : null;
  const selProbe = selected ? probeOf(selected.id as string) : null;
  const base = selected ? `models.${selected.id}.` : '';
  const edit = (patch: Record<string, unknown>) => { if (selected) update(c => updateListItem(c, 'models', selected.id as string, patch)); };
  const savedModel = (c: Config) => (c.models as Array<Record<string, any>>).find(m => m.id === selected?.id);
  const changed = (key: string) => differs(saved, draft, c => savedModel(c)?.[key]);

  const addNew = () => update(c => { const next = addModel(c); onSelect(next.id); return next.config; });

  const route = (key: Route, title: string, desc: string) => {
    const list = draft.routing[key] as string[];
    const free = models.filter(m => !list.includes(m.id as string));
    return (
      <div className="set-route" key={key}>
        <span className="set-route-title">{title}</span>
        <span className="set-route-desc">{desc}</span>
        {list.length === 0 && <span className="set-route-empty">{t('settings.models.routeEmpty')}</span>}
        {list.map((id, i) => (
          <div className="set-route-item" key={id}>
            <span className="set-route-n">{i + 1}</span>
            <span className="set-route-name">{models.find(m => m.id === id)?.label || id}</span>
            <button className="btn btn-ghost btn-icon" onClick={() => update(c => moveInRoute(c, key, i, -1))} disabled={i === 0} aria-label={t('settings.models.up')}><Icon name="arrowUp" size={13} /></button>
            <button className="btn btn-ghost btn-icon" onClick={() => update(c => moveInRoute(c, key, i, 1))} disabled={i === list.length - 1} aria-label={t('settings.models.down')}><span className="set-flip"><Icon name="arrowUp" size={13} /></span></button>
            <button className="btn btn-ghost btn-icon" onClick={() => update(c => removeFromRoute(c, key, id))} aria-label={t('settings.models.removeFromRoute')}><Icon name="x" size={13} /></button>
          </div>
        ))}
        {free.length > 0 && (
          <select className="input set-route-add" value="" aria-label={t('settings.models.addToRoute')} onChange={e => { if (e.target.value) update(c => addToRoute(c, key, e.target.value)); }}>
            <option value="">{t('settings.models.addToRoute')}</option>
            {free.map(m => <option key={m.id as string} value={m.id as string}>{labelOf(m)}</option>)}
          </select>
        )}
        {errorFor(problems, `routing.${key}`) && <span className="set-row-error" role="alert">{errorFor(problems, `routing.${key}`)}</span>}
      </div>
    );
  };

  return (
    <div className="set-stack">
      <div className="set-actions">
        <button className="btn btn-secondary" onClick={onProbe} disabled={probing}><span className={probing ? 'spin' : undefined}><Icon name="refresh" size={13} /></span>{probing ? t('settings.models.probing') : t('settings.models.probe')}</button>
        <button className="btn btn-ghost" onClick={addNew}><Icon name="plus" size={13} />{t('settings.models.add')}</button>
      </div>

      <div className="set-list">
        {models.map(m => {
          const status = statusOf(m.id as string);
          const p = probeOf(m.id as string);
          const provider = m.provider as string;
          return (
            <button key={m.id as string} className={`set-list-item${m.id === selected?.id ? ' active' : ''}`} onClick={() => onSelect(m.id as string)}>
              <span className={`set-list-icon${status.accent ? ' accent' : ''}${probing ? ' spin' : ''}`}><Icon name={status.icon} size={15} /></span>
              <span className="set-list-text">
                <span className="set-list-name">{labelOf(m)}</span>
                <span className="set-list-sub">{provider} · {t('settings.models.effective')} {num(p?.effective)}</span>
              </span>
              <span className={`tag ${status.ok ? 'tag-neutral' : 'tag-outline'} set-list-tag`}>{status.text}</span>
            </button>
          );
        })}
        {models.length === 0 && <span className="set-note">{t('settings.models.none')}</span>}
      </div>

      {selected && sel && (
        <div className="set-card">
          <div className="set-card-head"><span className="set-card-name">{labelOf(selected)}</span><span className={`tag ${sel.ok ? 'tag-neutral' : 'tag-outline'}`}>{sel.text}</span></div>
          <div className="set-nums">
            {([
              ['settings.models.effective', selProbe?.effective, selProbe?.status === 'too_small'],
              ['settings.models.required', selProbe?.required, false],
              ['settings.models.declared', selProbe?.declared, false],
              ['settings.models.measured', selProbe?.measured, false],
              ['settings.models.modelMax', selProbe?.modelMax, false],
            ] as const).map(([key, value, bad]) => (
              <div className="set-num-item" key={key}><span className="set-num-label">{t(key)}</span><span className={`set-num-value${bad ? ' bad' : ''}`}>{num(value)}</span></div>
            ))}
          </div>
          {selProbe?.message && <span className="set-card-message">{probeMessage(selProbe, getLanguage())}</span>}
          {selProbe?.hint && <div className="set-card-hint"><strong>{t('settings.models.hint')}</strong> {selProbe.hint}</div>}
        </div>
      )}

      <div className="set-routes">
        {route('chat', t('settings.models.routeChat'), t('settings.models.routeChatDesc'))}
        {route('background', t('settings.models.routeBackground'), t('settings.models.routeBackgroundDesc'))}
      </div>

      {selected && (
        <div className="set-rows">
          <SubTitle>{t('settings.models.detail', labelOf(selected))}</SubTitle>
          <FieldRow label={t('settings.models.fieldLabel')} desc={t('settings.models.fieldLabelDesc')} changed={changed('label')} path={`${base}label`} error={errorFor(problems, `${base}label`)}>
            <TextField value={(selected.label as string) ?? ''} label={t('settings.models.fieldLabel')} onChange={v => edit({ label: v || undefined })} />
          </FieldRow>
          <FieldRow label={t('settings.models.fieldId')} desc={t('settings.models.fieldIdDesc')} changed={changed('id')} path={`${base}id`} error={errorFor(problems, `${base}id`)}>
            <IdField value={selected.id as string} kind="model" taken={models.map(m => m.id as string)} label={t('settings.models.fieldId')} onRename={id => { update(c => renameModel(c, selected.id as string, id)); onSelect(id); }} />
          </FieldRow>
          <FieldRow label={t('settings.models.fieldProvider')} changed={changed('provider')} path={`${base}provider`} error={errorFor(problems, `${base}provider`) ?? undefined}>
            <SegField value={selected.provider as string} label={t('settings.models.fieldProvider')} options={providerIds.map(id => ({ value: id, label: id }))} onChange={v => edit({ provider: v })} />
          </FieldRow>
          <FieldRow label={t('settings.models.fieldModel')} desc={t('settings.models.fieldModelDesc')} changed={changed('model')} path={`${base}model`} error={errorFor(problems, `${base}model`)}>
            <TextField value={selected.model as string} mono label={t('settings.models.fieldModel')} onChange={v => edit({ model: v })} />
          </FieldRow>
          <FieldRow label={t('settings.models.fieldContext')} desc={t('settings.models.fieldContextDesc')} changed={changed('contextLength')} path={`${base}contextLength`} error={errorFor(problems, `${base}contextLength`)}>
            <NumberField value={selected.contextLength as number | undefined} optional label={t('settings.models.fieldContext')} unit={t('settings.unit.tokens')} width="130px" min={1024} onChange={v => edit({ contextLength: v })} />
          </FieldRow>
          <FieldRow label={t('settings.models.fieldMinContext')} desc={t('settings.models.fieldMinContextDesc')} changed={changed('minContext')} path={`${base}minContext`} error={errorFor(problems, `${base}minContext`)}>
            <NumberField value={selected.minContext as number} label={t('settings.models.fieldMinContext')} unit={t('settings.unit.tokens')} width="130px" min={1024} onChange={v => edit({ minContext: v })} />
          </FieldRow>
          <FieldRow label={t('settings.models.fieldMaxOutput')} changed={changed('maxOutputTokens')} path={`${base}maxOutputTokens`} error={errorFor(problems, `${base}maxOutputTokens`) ?? errorFor(problems, base.slice(0, -1))}>
            <NumberField value={selected.maxOutputTokens as number} label={t('settings.models.fieldMaxOutput')} unit={t('settings.unit.tokens')} width="130px" min={256} onChange={v => edit({ maxOutputTokens: v })} />
          </FieldRow>
          <FieldRow label={t('settings.models.fieldToolMode')} desc={t('settings.models.fieldToolModeDesc')} changed={changed('toolMode')} path={`${base}toolMode`}>
            <SegField value={selected.toolMode as string} label={t('settings.models.fieldToolMode')} options={[{ value: 'native', label: t('settings.models.toolNative') }, { value: 'json_fallback', label: t('settings.models.toolText') }]} onChange={v => edit({ toolMode: v })} />
          </FieldRow>
          <FieldRow label={t('settings.models.fieldMaxTools')} changed={changed('maxTools')} path={`${base}maxTools`}>
            <NumberField value={selected.maxTools as number | undefined} optional label={t('settings.models.fieldMaxTools')} unit={t('settings.unit.items')} min={0} max={128} onChange={v => edit({ maxTools: v })} />
          </FieldRow>
          <FieldRow label={t('settings.models.fieldVision')} changed={changed('vision')} path={`${base}vision`}>
            <SegField value={Boolean(selected.vision)} label={t('settings.models.fieldVision')} options={[{ value: true, label: t('settings.models.visionYes') }, { value: false, label: t('settings.models.visionNo') }]} onChange={v => edit({ vision: v })} />
          </FieldRow>
          <div className="set-danger">
            <button className="btn btn-ghost" onClick={() => update(c => removeModel(c, selected.id as string))}><Icon name="x" size={13} />{t('settings.models.remove')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

const PROVIDER_KINDS = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai_compatible', label: 'OpenAI' },
  { value: 'ollama', label: 'Ollama' },
] as const;
const SERVER_KINDS = ['lmstudio', 'llamacpp', 'vllm', 'tabbyapi', 'openrouter', 'openai', 'generic'] as const;
const SERVER_LABEL: Record<(typeof SERVER_KINDS)[number], string> = { lmstudio: 'LM Studio', llamacpp: 'llama.cpp', vllm: 'vLLM', tabbyapi: 'TabbyAPI', openrouter: 'OpenRouter', openai: 'OpenAI', generic: 'generic' };

interface ProvidersProps extends SectionProps { selectedId: string | null; onSelect: (id: string) => void; onKeyChanged: () => void }

export function ProvidersSection({ draft, saved, update, problems, selectedId, onSelect, onKeyChanged }: ProvidersProps) {
  const t = useT();
  const [advOpen, setAdvOpen] = useState(false);
  const providers = draft.providers as Array<Record<string, any>>;
  const selected = providers.find(p => p.id === selectedId) ?? providers[0];
  const base = selected ? `providers.${selected.id}.` : '';
  const edit = (patch: Record<string, unknown>) => { if (selected) update(c => updateListItem(c, 'providers', selected.id as string, patch)); };
  const changed = (key: string) => differs(saved, draft, c => (c.providers as Array<Record<string, any>>).find(p => p.id === selected?.id)?.[key]);
  const inUse = selected ? providerInUse(draft, selected.id as string) : false;
  const keyEnvError = selected ? errorFor(problems, `${base}apiKeyEnv`) : undefined;
  const keyEnv = selected ? providerKeyEnv(draft, selected.id as string) : undefined;
  const savedProvider = selected ? (saved.providers as Array<Record<string, any>>).find(p => p.id === selected.id) : undefined;
  return (
    <div className="set-stack">
      <div className="set-actions">
        <div className="seg set-seg" role="radiogroup" aria-label={t('settings.section.providers')}>
          {providers.map(p => (
            <label className="seg-opt" key={p.id as string}>
              <input type="radio" name="provider-pick" checked={p.id === selected?.id} onChange={() => onSelect(p.id as string)} />
              {p.id as string}
            </label>
          ))}
        </div>
        <button className="btn btn-ghost" onClick={() => update(c => { const next = addProvider(c); onSelect(next.id); return next.config; })}><Icon name="plus" size={13} />{t('settings.providers.add')}</button>
      </div>
      {providers.length === 0 && <span className="set-note">{t('settings.providers.none')}</span>}
      {selected && (
        <div className="set-rows">
          <FieldRow label={t('settings.providers.fieldId')} desc={t('settings.providers.fieldIdDesc')} changed={changed('id')} path={`${base}id`} error={errorFor(problems, `${base}id`)}>
            <IdField value={selected.id as string} kind="provider" taken={providers.map(p => p.id as string)} label={t('settings.providers.fieldId')} onRename={id => { update(c => renameProvider(c, selected.id as string, id)); onSelect(id); }} />
          </FieldRow>
          <FieldRow label={t('settings.providers.fieldKind')} changed={changed('kind')} path={`${base}kind`} error={errorFor(problems, `${base}kind`)}>
            <SegField value={selected.kind as string} label={t('settings.providers.fieldKind')} options={PROVIDER_KINDS.map(k => ({ value: k.value as string, label: k.label === 'OpenAI' ? t('settings.providers.kindOpenai') : k.label }))} onChange={v => edit({ kind: v })} />
          </FieldRow>
          <FieldRow label="URL" desc={t('settings.providers.fieldUrlDesc')} changed={changed('baseUrl')} path={`${base}baseUrl`} error={errorFor(problems, `${base}baseUrl`) ?? errorFor(problems, base.slice(0, -1))}>
            <TextField value={(selected.baseUrl as string) ?? ''} mono placeholder="https://…" label="URL" onChange={v => edit({ baseUrl: v || undefined })} />
          </FieldRow>
          <FieldRow label={t('settings.providers.fieldKey')} desc={keyEnv ? t('settings.providers.fieldKeyDesc', keyEnv) : undefined} path={`${base}key`}>
            <KeyField id={selected.id as string} saved={savedProvider} ready={keyReady(saved, draft, selected.id as string)} sharedWith={sharedKeyWith(draft, selected.id as string)} onChanged={onKeyChanged} />
          </FieldRow>
          <details className="set-adv" open={advOpen || Boolean(keyEnvError)} onToggle={e => setAdvOpen(e.currentTarget.open)}>
            <summary>{t('settings.providers.advanced')}</summary>
            <FieldRow label={t('settings.providers.fieldKeyEnv')} desc={t('settings.providers.fieldKeyEnvDesc')} changed={changed('apiKeyEnv')} path={`${base}apiKeyEnv`} error={keyEnvError}>
              <TextField value={(selected.apiKeyEnv as string) ?? ''} mono placeholder={t('settings.providers.none2')} label={t('settings.providers.fieldKeyEnv')} onChange={v => edit({ apiKeyEnv: v || undefined })} />
            </FieldRow>
          </details>
          {selected.kind === 'openai_compatible' && (
            <FieldRow label={t('settings.providers.fieldServer')} changed={changed('server')} path={`${base}server`}>
              <SegField value={(selected.server as string) ?? 'generic'} label={t('settings.providers.fieldServer')} options={SERVER_KINDS.map(k => ({ value: k as string, label: SERVER_LABEL[k] }))} onChange={v => edit({ server: v })} />
            </FieldRow>
          )}
          <FieldRow label={t('settings.providers.fieldParallel')} changed={changed('maxParallel')} path={`${base}maxParallel`} error={errorFor(problems, `${base}maxParallel`)}>
            <NumberField value={selected.maxParallel as number} label={t('settings.providers.fieldParallel')} unit={t('settings.unit.requests')} min={1} max={8} onChange={v => edit({ maxParallel: v })} />
          </FieldRow>
          <FieldRow label={t('settings.providers.fieldTimeout')} changed={changed('timeoutMs')} path={`${base}timeoutMs`} error={errorFor(problems, `${base}timeoutMs`)}>
            <NumberField value={secondsOf(selected.timeoutMs)} label={t('settings.providers.fieldTimeout')} unit={t('settings.unit.seconds')} min={1} max={3600} onChange={v => { if (v !== undefined) edit({ timeoutMs: v * 1000 }); }} />
          </FieldRow>
          <div className="set-danger">
            <button className="btn btn-ghost" onClick={() => update(c => removeProvider(c, selected.id as string))} disabled={inUse}><Icon name="x" size={13} />{t('settings.providers.remove')}</button>
            {inUse && <span className="set-note">{t('settings.providers.inUse')}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export function KeysSection({ draft, apiKeys }: { draft: Config; apiKeys: Record<string, boolean> }) {
  const t = useT();
  const usage = keyUsage(draft);
  const names = [...new Set([...usage.map(u => u.name), ...Object.keys(apiKeys)])];
  const example = names.map(name => `${name}=`).join('\n') || 'API_KEY=';
  const copy = () => {
    void copyText(example).then(ok => toast(ok
      ? { kind: 'done', icon: 'copy', title: t('settings.keys.copied'), body: t('settings.keys.copiedBody') }
      : { icon: 'alert', title: t('settings.keys.copyFailed'), body: t('settings.keys.copyFailedBody') }));
  };
  return (
    <div className="set-stack">
      <div className="set-keys">
        {names.length === 0 && <span className="set-note">{t('settings.keys.none')}</span>}
        {names.map(name => {
          const users = usage.find(u => u.name === name)?.providers ?? [];
          const set = apiKeys[name] === true;
          return (
            <div className="set-key" key={name}>
              <span className="set-key-name">{name}</span>
              <span className="set-key-used">{users.length ? users.join(', ') : t('settings.keys.unused')}</span>
              <span className={`tag ${set ? 'tag-neutral' : 'tag-outline'}`}>{set ? t('settings.keys.set') : t('settings.keys.unset')}</span>
            </div>
          );
        })}
      </div>
      <div className="set-card">
        <span className="set-card-name">{t('settings.keys.howTitle')}</span>
        <span className="set-card-message">{t('settings.keys.howBody')} {t('settings.key.howNow')}</span>
        <pre className="set-pre">{example}</pre>
        <div><button className="btn btn-secondary" onClick={copy}><Icon name="copy" size={13} />{t('settings.keys.copy')}</button></div>
      </div>
    </div>
  );
}

