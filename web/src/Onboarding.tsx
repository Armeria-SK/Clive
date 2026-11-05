import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, ApiError, type EnvReloadView, type ModelView, type Profile } from './api.ts';
import { Avatar, SHAPE_NAMES } from './Avatar.tsx';
import { newConversationId } from './chat-logic.ts';
import { useEscapeLayer } from './hooks.ts';
import { getLanguage, useT } from './i18n/index.ts';
import { Icon } from './icons.tsx';
import { saveLanguage } from './language.ts';
import {
  emptyModelForm, isOutsideUrl, modelFormProblem, MODEL_SOURCES, personaInputOf, SERVER_KINDS, setupModelConfig, STEPS, STYLE_CHOICES,
  type ModelForm, type ModelFormProblem, type ModelSource, type PersonaFields, type StepId,
} from './onboarding.ts';
import { probeMessage } from './server-text.ts';
import { toast } from './toast.tsx';
import './styles/onboarding.css';

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

interface Props {
  leaving: boolean;
  start: StepId;
  profile: Profile | null;
  onProfile: (profile: Profile) => void;
  onLater: () => void;
  onFinished: (conversationId: string | null) => void;
}

const STYLE_LABEL = { calm: 'onboarding.style.calm', friendly: 'onboarding.style.friendly', direct: 'onboarding.style.direct', none: 'onboarding.style.none' } as const;
const SOURCE_LABEL = { anthropic: 'onboarding.model.anthropic', ollama: 'onboarding.model.ollama', openai: 'onboarding.model.openai' } as const;

const errorText = (error: unknown, fallback: string): string => (error instanceof ApiError ? error.message : fallback);

export function Onboarding({ leaving, start, profile, onProfile, onLater, onFinished }: Props) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<StepId>(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<'ja' | 'en'>(getLanguage());
  const [fields, setFields] = useState<PersonaFields>({ userName: '', callMe: '', botName: profile?.name ?? 'Clive', style: null, styleNote: '' });
  const [look, setLook] = useState({ shape: profile?.shape ?? 'pebble', color: profile?.color ?? '#61B8A5' });
  const set = (patch: Partial<PersonaFields>) => setFields(current => ({ ...current, ...patch }));

  useEscapeLayer('dialog', !leaving && !busy, onLater);
  useEffect(() => {
    const before = document.activeElement;
    box.current?.focus();
    return () => { if (before instanceof HTMLElement && before.isConnected) before.focus(); };
  }, []);
  const trap = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) { e.preventDefault(); return; }
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const index = STEPS.indexOf(step);
  const goNext = () => setStep(STEPS[Math.min(STEPS.length - 1, index + 1)]!);
  const goBack = () => { setError(null); setStep(STEPS[Math.max(0, index - 1)]!); };

  // 「次へ」: その手順で決めたことを、サーバーに書かせてから進む（書くのはサーバーだけ。画面は値を送るだけ）
  async function advance(): Promise<void> {
    setBusy(true); setError(null);
    try {
      if (step === 'language') await saveLanguage(language);
      else if (step === 'you') { const input = personaInputOf(fields, 'you'); if (Object.keys(input).length) await api.onboardingPersona(input); }
      else if (step === 'identity') {
        const input = personaInputOf(fields, 'identity');
        if (Object.keys(input).length) onProfile((await api.onboardingPersona(input)).profile);
        if (profile && (look.shape !== profile.shape || look.color !== profile.color)) onProfile(await api.saveProfile({ shape: look.shape, color: look.color }));
      } else if (step === 'style') { const input = personaInputOf(fields, 'style'); if (Object.keys(input).length) await api.onboardingPersona(input); }
      goNext();
    } catch (failure) { setError(errorText(failure, t('onboarding.failed'))); }
    finally { setBusy(false); }
  }

  const finish = async (greetingTo: string | null): Promise<void> => {
    await api.onboardingDone();
    onFinished(greetingTo);
  };

  return (
    <>
      <div className={`ob-backdrop${leaving ? ' leaving' : ''}`} />
      <div className="ob-wrap">
        <div ref={box} className={`ob-modal${leaving ? ' leaving' : ''}`} role="dialog" aria-modal="true" aria-label={t('onboarding.title')} tabIndex={-1} onKeyDown={trap}>
          <header className="ob-head">
            <span className="ob-title">{t('onboarding.title')}</span>
            <span className="ob-progress" aria-label={t('onboarding.step', index + 1, STEPS.length)}>
              {STEPS.map((id, i) => <span key={id} className={`ob-dot${i === index ? ' on' : i < index ? ' done' : ''}`} />)}
            </span>
            <button type="button" className="btn btn-ghost ob-later" onClick={onLater} disabled={busy}>{t('onboarding.later')}</button>
          </header>
          <div className="ob-body">
            {step === 'language' && <LanguageStep value={language} onChange={setLanguage} />}
            {step === 'you' && <YouStep fields={fields} set={set} />}
            {step === 'identity' && <IdentityStep fields={fields} set={set} look={look} setLook={setLook} />}
            {step === 'style' && <StyleStep fields={fields} set={set} />}
            {step === 'model' && <ModelStep onNext={goNext} />}
            {step === 'greeting' && <GreetingStep busy={busy} setBusy={setBusy} setError={setError} onFinish={finish} />}
            {error && <p className="ob-error" role="alert">{error}</p>}
          </div>
          {step !== 'greeting' && step !== 'model' && (
            <footer className="ob-foot">
              {index > 0 && <button type="button" className="btn btn-ghost" onClick={goBack} disabled={busy}>{t('onboarding.back')}</button>}
              <span className="ob-fill" />
              <button type="button" className="btn btn-primary" onClick={() => void advance()} disabled={busy}>{busy ? t('onboarding.busy') : t('onboarding.next')}</button>
            </footer>
          )}
          {step === 'model' && <ModelFoot onBack={goBack} />}
        </div>
      </div>
    </>
  );
}

function Step({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="ob-step">
      <h2 className="ob-step-title">{title}</h2>
      {desc && <p className="ob-step-desc">{desc}</p>}
      {children}
    </section>
  );
}

function LanguageStep({ value, onChange }: { value: 'ja' | 'en'; onChange: (language: 'ja' | 'en') => void }) {
  const t = useT();
  return (
    <Step title={t('onboarding.language.title')} desc={t('onboarding.language.desc')}>
      <div className="ob-choices" role="radiogroup" aria-label={t('onboarding.language.title')}>
        {(['ja', 'en'] as const).map(l => (
          <button key={l} type="button" role="radio" aria-checked={value === l} className={`ob-choice${value === l ? ' on' : ''}`} onClick={() => onChange(l)}>{t(`lang.${l}`)}</button>
        ))}
      </div>
    </Step>
  );
}

function YouStep({ fields, set }: { fields: PersonaFields; set: (patch: Partial<PersonaFields>) => void }) {
  const t = useT();
  return (
    <Step title={t('onboarding.you.title')} desc={t('onboarding.you.desc')}>
      <label className="ob-field"><span>{t('onboarding.you.name')}</span><input className="input" value={fields.userName} maxLength={80} placeholder={t('onboarding.you.namePh')} onChange={e => set({ userName: e.target.value })} autoFocus /></label>
      <label className="ob-field"><span>{t('onboarding.you.call')}</span><input className="input" value={fields.callMe} maxLength={80} placeholder={t('onboarding.you.callPh')} onChange={e => set({ callMe: e.target.value })} /></label>
    </Step>
  );
}

function IdentityStep({ fields, set, look, setLook }: { fields: PersonaFields; set: (patch: Partial<PersonaFields>) => void; look: { shape: string; color: string }; setLook: (look: { shape: string; color: string }) => void }) {
  const t = useT();
  return (
    <Step title={t('onboarding.identity.title')} desc={t('onboarding.identity.desc')}>
      <div className="ob-identity">
        <span className="ob-avatar"><Avatar shape={look.shape} color={look.color} motion="auto" size={72} seed={fields.botName || 'clive'} /></span>
        <label className="ob-field ob-grow"><span>{t('onboarding.identity.name')}</span><input className="input" value={fields.botName} maxLength={40} onChange={e => set({ botName: e.target.value })} autoFocus /></label>
      </div>
      <span className="ob-label">{t('onboarding.identity.look')}</span>
      <div className="set-shapes" role="radiogroup" aria-label={t('onboarding.identity.look')}>
        {SHAPE_NAMES.map(name => (
          <button key={name} type="button" role="radio" aria-checked={look.shape === name} aria-label={name} data-tip={name} className={`set-shape${look.shape === name ? ' on' : ''}`} onClick={() => setLook({ ...look, shape: name })}>
            <Avatar shape={name} color={look.color} motion="none" size={34} />
          </button>
        ))}
      </div>
      <label className="ob-field ob-inline"><span>{t('onboarding.identity.color')}</span><input type="color" className="ob-color" value={look.color} onChange={e => setLook({ ...look, color: e.target.value })} /></label>
    </Step>
  );
}

function StyleStep({ fields, set }: { fields: PersonaFields; set: (patch: Partial<PersonaFields>) => void }) {
  const t = useT();
  return (
    <Step title={t('onboarding.style.title')} desc={t('onboarding.style.desc')}>
      <div className="ob-choices" role="radiogroup" aria-label={t('onboarding.style.title')}>
        {STYLE_CHOICES.map(style => (
          <button key={style} type="button" role="radio" aria-checked={fields.style === style} className={`ob-choice${fields.style === style ? ' on' : ''}`} onClick={() => set({ style })}>{t(STYLE_LABEL[style])}</button>
        ))}
      </div>
      <label className="ob-field"><span>{t('onboarding.style.note')}</span><textarea className="input ob-note" rows={3} maxLength={1000} value={fields.styleNote} placeholder={t('onboarding.style.notePh')} onChange={e => set({ styleNote: e.target.value })} /></label>
      <p className="ob-hint">{t('onboarding.style.after')}</p>
    </Step>
  );
}

// ── モデル: 3 つから選び、入れたらその場で確かめる。鍵は画面で受け取らない（.env に書いて読み直す） ──

function ModelStep({ onNext }: { onNext: () => void }) {
  const t = useT();
  const [form, setForm] = useState<ModelForm>(emptyModelForm('openai'));
  const [modelId, setModelId] = useState<string | null>(null);
  const [have, setHave] = useState(0);
  const [apiKeys, setApiKeys] = useState<Record<string, boolean>>({});
  const [anthropicEnv, setAnthropicEnv] = useState('ANTHROPIC_API_KEY');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ModelView | null>(null);
  const [problem, setProblem] = useState<ModelFormProblem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [env, setEnv] = useState<EnvReloadView | null>(null);
  const patch = (next: Partial<ModelForm>) => { setForm(current => ({ ...current, ...next })); setProblem(null); setResult(null); };
  const pick = (source: ModelSource) => { setForm(emptyModelForm(source)); setModelId(null); setProblem(null); setResult(null); setEnv(null); };

  useEffect(() => {
    void api.settings().then(view => {
      setHave((view.config.models as unknown[]).length);
      setApiKeys(view.apiKeys);
      const anthropic = (view.config.providers as Array<{ kind: string; apiKeyEnv?: string }>).find(p => p.kind === 'anthropic');
      if (anthropic?.apiKeyEnv) setAnthropicEnv(anthropic.apiKeyEnv);
    }).catch(() => undefined);
  }, []);

  const keyEnv = form.source === 'anthropic' ? anthropicEnv : form.source === 'openai' ? form.apiKeyEnv.trim() : '';
  const keyPresent = keyEnv ? (env?.apiKeys[keyEnv] ?? apiKeys[keyEnv]) : undefined;

  async function check(): Promise<void> {
    const found = modelFormProblem(form);
    if (found) { setProblem(found); return; }
    setChecking(true); setFailure(null); setResult(null);
    try {
      const latest = (await api.settings()).config;
      const built = setupModelConfig(latest, form, modelId);
      const saved = await api.saveSettings(built.config);
      setModelId(built.modelId);
      setHave(saved.models.length);
      setResult(saved.models.find(m => m.id === built.modelId) ?? null);
    } catch (error) { setFailure(errorText(error, t('onboarding.model.saveFailed'))); }
    finally { setChecking(false); }
  }

  async function reload(): Promise<void> {
    try {
      setEnv(await api.reloadEnv(keyEnv ? [keyEnv] : []));
      if (modelId) await check();
    } catch (error) { toast({ icon: 'alert', title: errorText(error, t('onboarding.failed')) }); }
  }

  const ok = result?.probe?.status === 'ok';
  const sourceLabel = (source: ModelSource) => t(SOURCE_LABEL[source]);
  return (
    <Step title={t('onboarding.model.title')} desc={t('onboarding.model.desc')}>
      {have > 0 && <p className="ob-hint">{t('onboarding.model.have', have)}</p>}
      <div className="ob-choices" role="radiogroup" aria-label={t('onboarding.model.title')}>
        {MODEL_SOURCES.map(source => (
          <button key={source} type="button" role="radio" aria-checked={form.source === source} className={`ob-choice${form.source === source ? ' on' : ''}`} onClick={() => pick(source)}>{sourceLabel(source)}</button>
        ))}
      </div>
      <label className="ob-field"><span>{t('onboarding.model.modelName')}</span><input className="input ob-mono" value={form.model} onChange={e => patch({ model: e.target.value })} spellCheck={false} aria-invalid={problem === 'model'} /></label>
      {problem === 'model' && <p className="ob-error">{t('onboarding.model.problem.model')}</p>}
      {form.source === 'openai' && (
        <>
          <label className="ob-field"><span>{t('onboarding.model.baseUrl')}</span><input className="input ob-mono" value={form.baseUrl} onChange={e => patch({ baseUrl: e.target.value })} spellCheck={false} aria-invalid={problem === 'baseUrl'} /></label>
          {problem === 'baseUrl' && <p className="ob-error">{t('onboarding.model.problem.baseUrl')}</p>}
          {isOutsideUrl(form.baseUrl) && <p className="ob-warn">{t('onboarding.model.outside', form.baseUrl.trim())}</p>}
          <div className="ob-row">
            <label className="ob-field ob-grow"><span>{t('onboarding.model.server')}</span>
              <select className="input" value={form.server} onChange={e => patch({ server: e.target.value as ModelForm['server'] })}>{SERVER_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}</select>
            </label>
            <label className="ob-field ob-grow"><span>{t('onboarding.model.contextLength')}</span><input className="input" inputMode="numeric" value={form.contextLength} onChange={e => patch({ contextLength: e.target.value })} aria-invalid={problem === 'contextLength'} /></label>
          </div>
          {problem === 'contextLength' && <p className="ob-error">{t('onboarding.model.problem.contextLength')}</p>}
          <label className="ob-field"><span>{t('onboarding.model.keyEnv')}</span><input className="input ob-mono" value={form.apiKeyEnv} placeholder="MY_API_KEY" onChange={e => patch({ apiKeyEnv: e.target.value })} spellCheck={false} aria-invalid={problem === 'apiKeyEnv'} /></label>
          {problem === 'apiKeyEnv' && <p className="ob-error">{t('onboarding.model.problem.apiKeyEnv')}</p>}
        </>
      )}
      {form.source === 'ollama' && <p className="ob-hint">{t('onboarding.model.ollamaHint')}</p>}
      {keyEnv && (
        <div className="ob-key">
          <p className="ob-hint">{t('onboarding.model.keyHint', keyEnv)}</p>
          <div className="ob-row ob-center">
            <button type="button" className="btn btn-secondary" onClick={() => void reload()} disabled={checking}><Icon name="refresh" size={13} />{t('onboarding.model.reloadEnv')}</button>
            {keyPresent !== undefined && <span className={`ob-keystate${keyPresent ? ' ok' : ''}`}>{t(keyPresent ? 'onboarding.model.keyFound' : 'onboarding.model.keyMissing', keyEnv)}</span>}
          </div>
          {env && env.notApplied.length > 0 && <p className="ob-warn">{t('onboarding.model.notApplied', env.notApplied.join(', '))}</p>}
        </div>
      )}
      <div className="ob-row ob-center">
        <button type="button" className="btn btn-primary" onClick={() => void check()} disabled={checking}>{checking ? t('onboarding.model.checking') : t('onboarding.model.check')}</button>
      </div>
      {failure && <p className="ob-error" role="alert">{failure}</p>}
      {result && (
        <div className={`ob-result${ok ? ' ok' : ''}`} role="status">
          <span className="ob-result-head"><Icon name={ok ? 'circleCheck' : 'alert'} size={15} />{ok ? t('onboarding.model.ok') : result.probe?.status ?? ''}</span>
          {result.probe?.message && <span className="ob-result-msg">{probeMessage(result.probe, getLanguage())}</span>}
          {!ok && result.probe?.hint && <span className="ob-result-msg">{result.probe.hint}</span>}
        </div>
      )}
      <p className="ob-hint">{t('onboarding.model.laterNote')}</p>
      <ModelNext enabled={ok || (have > 0 && !result && !checking)} onNext={onNext} />
    </Step>
  );
}

// 次へは、確かめて通ったとき（または、すでに使えるモデルがあるとき）。通らなくても「あとで設定する」で先へ進める。
function ModelNext({ enabled, onNext }: { enabled: boolean; onNext: () => void }) {
  const t = useT();
  return (
    <div className="ob-row ob-end">
      {!enabled && <button type="button" className="btn btn-ghost" onClick={onNext}>{t('onboarding.skip')}</button>}
      <button type="button" className="btn btn-primary" onClick={onNext} disabled={!enabled}>{t('onboarding.next')}</button>
    </div>
  );
}

function ModelFoot({ onBack }: { onBack: () => void }) {
  const t = useT();
  return <footer className="ob-foot"><button type="button" className="btn btn-ghost" onClick={onBack}>{t('onboarding.back')}</button></footer>;
}

// ── 最後: 最初の会話を開いて、Clive があいさつする（画面からの決まった依頼を 1 通送る） ──

function GreetingStep({ busy, setBusy, setError, onFinish }: { busy: boolean; setBusy: (busy: boolean) => void; setError: (text: string | null) => void; onFinish: (conversationId: string | null) => Promise<void> }) {
  const t = useT();
  const [models, setModels] = useState<number | null>(null);
  useEffect(() => { void api.models().then(r => setModels(r.models.length)).catch(() => setModels(null)); }, []);

  async function greet(): Promise<void> {
    setBusy(true); setError(null);
    try {
      const id = newConversationId();
      await api.send(id, t('onboarding.greeting.request'));
      await onFinish(id);
    } catch (error) { setError(`${t('onboarding.greeting.failed')}: ${errorText(error, '')}`.replace(/: $/u, '')); }
    finally { setBusy(false); }
  }
  async function finish(): Promise<void> {
    setBusy(true); setError(null);
    try { await onFinish(null); } catch (error) { setError(errorText(error, t('onboarding.failed'))); } finally { setBusy(false); }
  }

  return (
    <Step title={t('onboarding.greeting.title')} desc={t('onboarding.greeting.desc')}>
      {models === 0 && <p className="ob-warn">{t('onboarding.greeting.noModel')}</p>}
      <div className="ob-row ob-end">
        {models === 0
          ? <button type="button" className="btn btn-primary" onClick={() => void finish()} disabled={busy}>{t('onboarding.greeting.finish')}</button>
          : (
            <>
              <button type="button" className="btn btn-ghost" onClick={() => void finish()} disabled={busy}>{t('onboarding.greeting.finish')}</button>
              <button type="button" className="btn btn-primary" onClick={() => void greet()} disabled={busy || models === null}>{busy ? t('onboarding.busy') : t('onboarding.greeting.start')}</button>
            </>
          )}
      </div>
    </Step>
  );
}
