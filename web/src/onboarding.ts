import type { Config } from './settings/model.ts';
import { uniqueId } from './settings/model.ts';

// はじめの設定の、画面を使わない部分: 手順・続きの位置・モデルの入力から設定への書き換え。

export type StepId = 'language' | 'you' | 'identity' | 'style' | 'model' | 'greeting';
export const STEPS: readonly StepId[] = ['language', 'you', 'identity', 'style', 'model', 'greeting'];

export interface OnboardingSteps { language: boolean; user: boolean; identity: boolean; persona: boolean; model: boolean }
export interface OnboardingState { done: boolean; steps: OnboardingSteps }

// 左の一覧の「はじめの設定を続ける」から開いたとき、済んでいない最初の手順から始める。
export function resumeStep(steps: OnboardingSteps): StepId {
  if (!steps.language) return 'language';
  if (!steps.user) return 'you';
  if (!steps.identity) return 'identity';
  if (!steps.persona) return 'style';
  if (!steps.model) return 'model';
  return 'greeting';
}

export const STYLE_CHOICES = ['calm', 'friendly', 'direct', 'none'] as const;
export type StyleChoice = (typeof STYLE_CHOICES)[number];

export interface PersonaFields { userName: string; callMe: string; botName: string; style: StyleChoice | null; styleNote: string }

// サーバーへ送る値。空の項目は送らない（送った項目だけが書かれ、済みになる）。
export function personaInputOf(fields: PersonaFields, part: 'you' | 'identity' | 'style'): Record<string, string> {
  const trimmed = (text: string) => text.trim();
  if (part === 'you') return { ...(trimmed(fields.userName) ? { userName: trimmed(fields.userName) } : {}), ...(trimmed(fields.callMe) ? { callMe: trimmed(fields.callMe) } : {}) };
  if (part === 'identity') return trimmed(fields.botName) ? { botName: trimmed(fields.botName) } : {};
  return {
    ...(fields.style && (fields.style !== 'none' || trimmed(fields.styleNote)) ? { style: fields.style } : {}),
    ...(trimmed(fields.styleNote) ? { styleNote: trimmed(fields.styleNote) } : {}),
  };
}

export const SERVER_KINDS = ['generic', 'lmstudio', 'llamacpp', 'tabbyapi', 'vllm', 'openrouter', 'openai'] as const;
export type ServerKind = (typeof SERVER_KINDS)[number];
export type ModelSource = 'anthropic' | 'ollama' | 'openai';
export const MODEL_SOURCES: readonly ModelSource[] = ['anthropic', 'ollama', 'openai'];

export interface ModelForm { source: ModelSource; model: string; baseUrl: string; server: ServerKind; contextLength: string; apiKeyEnv: string }

export const emptyModelForm = (source: ModelSource = 'openai'): ModelForm => ({
  source, model: '', baseUrl: source === 'openai' ? 'http://127.0.0.1:8000/v1' : '', server: 'generic', contextLength: source === 'openai' ? '32768' : '', apiKeyEnv: '',
});

export type ModelFormProblem = 'model' | 'baseUrl' | 'contextLength' | 'apiKeyEnv';

export function modelFormProblem(form: ModelForm): ModelFormProblem | null {
  if (!form.model.trim()) return 'model';
  if (form.source === 'openai') {
    if (!/^https?:\/\/\S+$/iu.test(form.baseUrl.trim())) return 'baseUrl';
    const length = Number(form.contextLength);
    if (form.contextLength.trim() !== '' && !(Number.isInteger(length) && length >= 1024 && length <= 10_000_000)) return 'contextLength';
    if (form.apiKeyEnv.trim() && !/^[A-Z][A-Z0-9_]{0,63}$/u.test(form.apiKeyEnv.trim())) return 'apiKeyEnv';
  }
  return null;
}

// 送り先がこの PC の外のアドレスか（会話の内容がそこへ送られることを、確かめる前に知らせる）
export function isOutsideUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl.trim()).hostname.replace(/^\[|\]$/gu, '');
    return !(host === 'localhost' || host === '::1' || /^127\./u.test(host) || host.endsWith('.localhost'));
  } catch { return false; }
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^[^a-z0-9]+/u, '').replace(/-+$/u, '').slice(0, 40) || 'model';

const DEFAULTS = {
  anthropic: { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600_000 },
  ollama: { id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', maxParallel: 1, timeoutMs: 600_000 },
} as const;

type Entry = Record<string, unknown> & { id: string };

// 入力を設定に反映する。同じモデルをもう一度確かめるとき（modelId）は、その項目を直す。
// 順番（チャット・裏方）が両方空なら、設定のモデル全部と足したモデルを入れる。すでに順番があれば、足したモデルを最後に足す。
export function setupModelConfig(config: Config, form: ModelForm, modelId: string | null): { config: Config; modelId: string } {
  const providers = [...(config.providers as Entry[])];
  const models = [...(config.models as Entry[])];
  const existing = modelId ? models.find(m => m.id === modelId) : undefined;

  let providerId: string;
  if (form.source === 'openai') {
    const fields = {
      kind: 'openai_compatible', baseUrl: form.baseUrl.trim(), server: form.server, maxParallel: 1, timeoutMs: 600_000,
      ...(form.apiKeyEnv.trim() ? { apiKeyEnv: form.apiKeyEnv.trim() } : {}),
    };
    const own = existing ? providers.findIndex(p => p.id === existing.provider && p.kind === 'openai_compatible') : -1;
    if (own >= 0) { providerId = providers[own]!.id; providers[own] = { id: providerId, ...fields }; }
    else { providerId = uniqueId('local', providers.map(p => p.id)); providers.push({ id: providerId, ...fields }); }
  } else {
    const kind = form.source;
    const found = providers.find(p => p.kind === kind);
    if (found) providerId = found.id;
    else { providerId = DEFAULTS[kind].id; providers.push({ ...DEFAULTS[kind] }); }
  }

  const length = Number(form.contextLength);
  const model = {
    id: existing?.id ?? uniqueId(slug(form.model), models.map(m => m.id)),
    label: '', provider: providerId, model: form.model.trim(),
    ...(form.source === 'openai' && form.contextLength.trim() !== '' ? { contextLength: length } : {}),
    minContext: 8192, maxOutputTokens: 4096, toolMode: 'native', vision: false,
  };
  const at = existing ? models.findIndex(m => m.id === existing.id) : -1;
  if (at >= 0) models[at] = { ...existing, ...model }; else models.push(model);

  const routing = config.routing as { chat: string[]; background: string[] };
  const ids = models.map(m => m.id);
  const next = routing.chat.length === 0 && routing.background.length === 0
    ? { ...routing, chat: ids, background: ids }
    : { ...routing, chat: routing.chat.includes(model.id) ? routing.chat : [...routing.chat, model.id], background: routing.background.includes(model.id) ? routing.background : [...routing.background, model.id] };
  return { config: { ...config, providers, models, routing: next }, modelId: model.id };
}

// 設定のモーダルを開く前に、開く節を覚えさせる（Settings.tsx の SECTION_KEY と同じ）。
export const OPEN_SETUP_EVENT = 'clive:open-setup';
export function openSetup(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_SETUP_EVENT));
}

const SEEN_KEY = 'clive.onboardingSeen';
export function wasSetupShown(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): boolean {
  try { return storage?.getItem(SEEN_KEY) === '1'; } catch { return false; }
}
export function markSetupShown(storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try { storage?.setItem(SEEN_KEY, '1'); } catch { }
}
function safeStorage(): Storage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}
