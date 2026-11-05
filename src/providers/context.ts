import { DEFAULT_LANGUAGE, type Language } from '../config/schema.ts';
import type { MessageParams } from '../shared/messages/define.ts';
import { providerText, type ProviderMessageKey } from '../shared/messages/providers.ts';
import type { ProbeResult, ProviderError } from './types.ts';

export interface ContextFacts {
  modelId: string;
  server: string;
  required: number;
  declared?: number | undefined;
  measured?: number | undefined;
  modelMax?: number | undefined;
  hint?: string | undefined;
  unmeasuredNote?: ProviderMessageKey | undefined;
  capabilities?: string[] | undefined;
  language?: Language | undefined;
  now?: number;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function probeText(language: Language, key: ProviderMessageKey, params: MessageParams = {}): Pick<ProbeResult, 'message' | 'messageCode' | 'messageParams'> {
  return { message: providerText(language, key, params), messageCode: `provider.${key}`, messageParams: params };
}

export function evaluateContext(f: ContextFacts): ProbeResult {
  const language = f.language ?? DEFAULT_LANGUAGE;
  const base = {
    modelId: f.modelId, server: f.server, required: f.required, checkedAt: f.now ?? Date.now(),
    ...(f.declared === undefined ? {} : { declared: f.declared }),
    ...(f.measured === undefined ? {} : { measured: f.measured }),
    ...(f.modelMax === undefined ? {} : { modelMax: f.modelMax }),
    ...(f.capabilities === undefined ? {} : { capabilities: f.capabilities }),
  };
  if (f.declared !== undefined && f.modelMax !== undefined && f.declared > f.modelMax) {
    return {
      ...base, status: 'exceeds_model', effective: f.modelMax,
      ...probeText(language, 'probe.exceeds_model', { declared: fmt(f.declared), modelMax: fmt(f.modelMax) }),
      hint: providerText(language, 'hint.exceeds_model', { modelMax: fmt(f.modelMax) }),
    };
  }
  const candidates = [f.declared, f.measured, f.modelMax].filter((n): n is number => typeof n === 'number' && n > 0);
  if (!candidates.length) {
    return {
      ...base, status: 'unknown',
      ...probeText(language, 'probe.unknown'),
      hint: providerText(language, 'hint.unknown'),
    };
  }
  const effective = Math.min(...candidates);
  if (effective < f.required) {
    const source = f.measured !== undefined ? providerText(language, 'probe.source.measured', { n: fmt(f.measured) })
      : f.declared !== undefined ? providerText(language, 'probe.source.declared', { n: fmt(f.declared) })
        : providerText(language, 'probe.source.limit', { n: fmt(effective) });
    return {
      ...base, status: 'too_small', effective,
      ...probeText(language, 'probe.too_small', { effective: fmt(effective), required: fmt(f.required), source }),
      ...(f.hint === undefined ? {} : { hint: f.hint }),
    };
  }
  const note = f.measured === undefined && f.unmeasuredNote ? providerText(language, 'probe.note', { note: providerText(language, f.unmeasuredNote) }) : '';
  return { ...base, status: 'ok', effective, ...probeText(language, 'probe.ok', { effective: fmt(effective), note }) };
}

type HintKind = 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'tabbyapi' | 'generic' | 'hosted';

export function contextHint(language: Language, kind: HintKind, required: number): string {
  return providerText(language, `hint.${kind}`, { required: fmt(required) });
}

export const CONTEXT_HINTS = {
  ollama: (required: number) => contextHint(DEFAULT_LANGUAGE, 'ollama', required),
  lmstudio: (required: number) => contextHint(DEFAULT_LANGUAGE, 'lmstudio', required),
  llamacpp: (required: number) => contextHint(DEFAULT_LANGUAGE, 'llamacpp', required),
  vllm: (required: number) => contextHint(DEFAULT_LANGUAGE, 'vllm', required),
  tabbyapi: (required: number) => contextHint(DEFAULT_LANGUAGE, 'tabbyapi', required),
  generic: (required: number) => contextHint(DEFAULT_LANGUAGE, 'generic', required),
  hosted: (required: number) => contextHint(DEFAULT_LANGUAGE, 'hosted', required),
} as const;

export function errorProbeText(error: ProviderError, language: Language): Pick<ProbeResult, 'message' | 'messageCode' | 'messageParams'> {
  return { message: error.text(language), ...(error.code ? { messageCode: `provider.${error.code}`, messageParams: error.params } : {}) };
}
