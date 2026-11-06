import type { PlainKey } from '../i18n/index.ts';
import { getLanguage, type Lang } from '../i18n/state.ts';
import { serverText } from '../server-text.ts';
import { keyEnvName, takenKeyEnvs } from '../../../src/shared/provider-key.ts';

// 設定の画面の、画面を使わない部分。節の一覧・変更の数え方・保存に失敗したときの問題の読み取り・設定の書き換え。

export type Config = Record<string, any>;

export type SettingsSection = 'models' | 'providers' | 'keys' | 'tools' | 'worker' | 'memory' | 'about' | 'look' | 'server' | 'file';

export const SECTION_GROUPS: ReadonlyArray<{ label: PlainKey; items: ReadonlyArray<{ id: SettingsSection; label: PlainKey; desc: PlainKey }> }> = [
  { label: 'settings.group.model', items: [
    { id: 'models', label: 'settings.section.models', desc: 'settings.desc.models' },
    { id: 'providers', label: 'settings.section.providers', desc: 'settings.desc.providers' },
    { id: 'keys', label: 'settings.section.keys', desc: 'settings.desc.keys' },
  ] },
  { label: 'settings.group.behavior', items: [
    { id: 'tools', label: 'settings.section.tools', desc: 'settings.desc.tools' },
    { id: 'worker', label: 'settings.section.worker', desc: 'settings.desc.worker' },
    { id: 'memory', label: 'settings.section.memory', desc: 'settings.desc.memory' },
  ] },
  { label: 'settings.group.clive', items: [
    { id: 'about', label: 'settings.section.about', desc: 'settings.desc.about' },
    { id: 'look', label: 'settings.section.look', desc: 'settings.desc.look' },
  ] },
  { label: 'settings.group.system', items: [
    { id: 'server', label: 'settings.section.server', desc: 'settings.desc.server' },
    { id: 'file', label: 'settings.section.file', desc: 'settings.desc.file' },
  ] },
];

export const SECTION_IDS: readonly SettingsSection[] = SECTION_GROUPS.flatMap(g => g.items.map(i => i.id));

export function isSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && (SECTION_IDS as readonly string[]).includes(value);
}

// 開いている節の覚え（セッションの間だけ）。設定の小窓は、開くときにこれを読む
export const SECTION_KEY = 'clive.settingsSection';

// 設定の小窓を、指定の節で開く
export function openSettingsSection(section: SettingsSection): void {
  try { sessionStorage.setItem(SECTION_KEY, section); } catch { }
  location.hash = '#/settings';
}

// 節ごとの、設定のうちその節が持つ部分（変更の印と、元に戻すかどうかの判定に使う）。
export function sectionSlice(config: Config, section: SettingsSection): unknown {
  switch (section) {
    case 'models': return [config.models, config.routing];
    case 'providers': return config.providers;
    case 'tools': return config.tools;
    case 'worker': return config.worker;
    case 'memory': return config.memory;
    case 'look': return [config.profile, config.language ?? null];
    case 'server': return config.server;
    default: return undefined;
  }
}

export const sectionChanged = (saved: Config, draft: Config, section: SettingsSection): boolean =>
  JSON.stringify(sectionSlice(saved, section)) !== JSON.stringify(sectionSlice(draft, section));

export const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const hasIds = (list: unknown[]): list is Array<Record<string, unknown> & { id: string }> => list.every(item => isPlain(item) && typeof item.id === 'string');

// 保存していない変更の数。項目ごとに 1 件。id を持つ一覧（models / providers）は id で突き合わせ、追加・削除は 1 件。
export function countChanges(saved: unknown, draft: unknown): number {
  if (JSON.stringify(saved) === JSON.stringify(draft)) return 0;
  if (isPlain(saved) && isPlain(draft)) {
    let n = 0;
    for (const key of new Set([...Object.keys(saved), ...Object.keys(draft)])) n += countChanges(saved[key], draft[key]);
    return n;
  }
  if (Array.isArray(saved) && Array.isArray(draft) && hasIds(saved) && hasIds(draft)) {
    const before = new Map(saved.map(item => [item.id, item]));
    let n = 0;
    for (const item of draft) n += before.has(item.id) ? countChanges(before.get(item.id), item) : 1;
    for (const item of saved) if (!draft.some(d => d.id === item.id)) n += 1;
    return n;
  }
  return 1;
}

export interface Problem {
  text: string;
  path: string;
  message: string;
  section: SettingsSection | null;
  modelId?: string;
  providerId?: string;
}

const SECTION_OF_ROOT: Record<string, SettingsSection> = {
  models: 'models', routing: 'models', providers: 'providers', tools: 'tools', worker: 'worker', memory: 'memory', profile: 'look', language: 'look', server: 'server',
};

// サーバーの問題は文字列で返る。「/models/0/contextLength: Expected…」（形の検査。0 は一覧の位置）か
// 「models.local: …」「providers.x.baseUrl: …」「routing.chat: …」（内容の検査）。読み取れなければ section は null（一覧に出すだけ）。
export function parseProblem(text: string, config: Config): Problem {
  const colon = text.indexOf(': ');
  const rawPath = colon > 0 ? text.slice(0, colon) : '';
  const message = colon > 0 ? text.slice(colon + 2) : text;
  let segments: string[];
  if (rawPath.startsWith('/')) segments = rawPath.split('/').filter(Boolean);
  else segments = rawPath.split('.').filter(Boolean);
  if (rawPath.startsWith('/')) {
    const [root, index] = segments;
    const list = root === 'models' || root === 'providers' ? config[root] : undefined;
    if (Array.isArray(list) && index !== undefined && /^\d+$/u.test(index)) {
      const id = list[Number(index)]?.id;
      if (typeof id === 'string') segments = [root!, id, ...segments.slice(2)];
    }
  }
  const root = segments[0] ?? '';
  const section = SECTION_OF_ROOT[root] ?? null;
  const problem: Problem = { text, path: segments.join('.'), message, section };
  if (root === 'models' && segments[1]) problem.modelId = segments[1];
  if (root === 'providers' && segments[1]) problem.providerId = segments[1];
  return problem;
}

// code / params: 形の誤り（パターン・長さ・数の範囲など）の文のコード（config.<キー>）と差し込みの値。message はサーバーの日本語の文
export interface ServerIssue { path: string; message: string; code?: string; params?: Record<string, unknown> }
const isIssue = (value: unknown): value is ServerIssue =>
  isPlain(value) && typeof value.path === 'string' && typeof value.message === 'string';

// 画面の言語の文。コードが表に無い・差し込みの値が足りないときは、サーバーの文のまま
export const issueMessage = (issue: ServerIssue, language: Lang = getLanguage()): string => serverText(issue.code, issue.params, language) ?? issue.message;

// サーバーが ID で書いた場所つきで返した問題（issues）を、そのまま行と節に結ぶ。モデルの ID に点があっても取り違えないよう、設定の ID と突き合わせる
function problemOfIssue(issue: ServerIssue, config: Config, language: Lang): Problem {
  const segments = issue.path.split('.').filter(Boolean);
  const root = segments[0] ?? '';
  const message = issueMessage(issue, language);
  const problem: Problem = { text: issue.path ? `${issue.path}: ${message}` : message, path: issue.path, message, section: SECTION_OF_ROOT[root] ?? null };
  if (root === 'models' || root === 'providers') {
    const list = config[root];
    const ids = Array.isArray(list) ? list.map(item => item?.id).filter((id): id is string => typeof id === 'string').sort((a, b) => b.length - a.length) : [];
    const id = ids.find(candidate => issue.path === `${root}.${candidate}` || issue.path.startsWith(`${root}.${candidate}.`));
    if (id !== undefined) problem[root === 'models' ? 'modelId' : 'providerId'] = id;
  }
  return problem;
}

// 保存を断られたときの応答から、画面に出す問題の一覧を作る。issues があればそれを使い、無い・読めない古い応答は文（problems）を今までの読み取りで読む。
export function problemsOf(body: unknown, fallback: string, config: Config, language: Lang = getLanguage()): Problem[] {
  const record = isPlain(body) ? body : {};
  if (Array.isArray(record.issues) && record.issues.length > 0 && record.issues.every(isIssue)) return record.issues.map(issue => problemOfIssue(issue, config, language));
  const texts = Array.isArray(record.problems) ? record.problems.filter((text): text is string => typeof text === 'string') : [];
  return (texts.length ? texts : [fallback]).map(text => parseProblem(text, config));
}

// ---- 設定の書き換え（元の設定は書き換えず、新しい設定を返す）----

export function updateAt(config: Config, root: string, patch: Record<string, unknown>): Config {
  return { ...config, [root]: { ...(config[root] ?? {}), ...patch } };
}

export function updateIn(config: Config, root: string, key: string, patch: Record<string, unknown>): Config {
  return { ...config, [root]: { ...(config[root] ?? {}), [key]: { ...((config[root] ?? {})[key] ?? {}), ...patch } } };
}

// 値が undefined（空欄）のキーは、設定から外す。
export function pruned<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function updateListItem(config: Config, root: 'models' | 'providers', id: string, patch: Record<string, unknown>): Config {
  return { ...config, [root]: (config[root] as Array<Record<string, unknown>>).map(item => (item.id === id ? pruned({ ...item, ...patch }) : item)) };
}

export function uniqueId(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

export function addModel(config: Config): { config: Config; id: string } {
  const providers = config.providers as Array<{ id: string }>;
  const id = uniqueId('new-model', (config.models as Array<{ id: string }>).map(m => m.id));
  const model = { id, label: '', provider: providers[0]?.id ?? '', model: '', contextLength: 32768, minContext: 8192, maxOutputTokens: 4096, toolMode: 'native', vision: false };
  const ids = (config.models as Array<{ id: string }>).map(m => m.id);
  const routing = config.routing as { chat: string[]; background: string[] };
  // チャットも裏方も順番が空のときは、サーバーが設定のモデル全部を候補にする。足したモデルが他のモデルを押しのけないよう、今の候補に足した順番にする
  const filled = routing.chat.length === 0 && routing.background.length === 0 ? { ...routing, chat: [...ids, id], background: [...ids, id] } : routing;
  return { config: { ...config, models: [...config.models, model], routing: filled }, id };
}

export function removeModel(config: Config, id: string): Config {
  const routing = config.routing as { chat: string[]; background: string[] };
  return {
    ...config,
    models: (config.models as Array<{ id: string }>).filter(m => m.id !== id),
    routing: { ...routing, chat: routing.chat.filter(m => m !== id), background: routing.background.filter(m => m !== id) },
  };
}

export function addProvider(config: Config): { config: Config; id: string } {
  const id = uniqueId('new-provider', (config.providers as Array<{ id: string }>).map(p => p.id));
  const provider = { id, kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8000/v1', server: 'generic', maxParallel: 1, timeoutMs: 600_000 };
  return { config: { ...config, providers: [...config.providers, provider] }, id };
}

export const providerInUse = (config: Config, id: string): boolean => (config.models as Array<{ provider: string }>).some(m => m.provider === id);

export function removeProvider(config: Config, id: string): Config {
  return { ...config, providers: (config.providers as Array<{ id: string }>).filter(p => p.id !== id) };
}

export type Route = 'chat' | 'background';

export function moveInRoute(config: Config, route: Route, index: number, delta: -1 | 1): Config {
  const list = [...(config.routing[route] as string[])];
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return config;
  [list[index], list[to]] = [list[to]!, list[index]!];
  return { ...config, routing: { ...config.routing, [route]: list } };
}

export function addToRoute(config: Config, route: Route, id: string): Config {
  const list = config.routing[route] as string[];
  return list.includes(id) ? config : { ...config, routing: { ...config.routing, [route]: [...list, id] } };
}

export function removeFromRoute(config: Config, route: Route, id: string): Config {
  return { ...config, routing: { ...config.routing, [route]: (config.routing[route] as string[]).filter(m => m !== id) } };
}

// 設定のモーダルを閉じようとしたとき（× ・Esc・背景）にどうするか。保存している最中は待つ。保存していない変更があれば、捨てる前に確かめる。
export function closeAction(state: { dirty: number; busy: boolean }): 'close' | 'confirm' | 'wait' {
  if (state.busy) return 'wait';
  return state.dirty > 0 ? 'confirm' : 'close';
}

// 保存していない編集があるまま、ページを閉じる・読み直すときに、ブラウザの確認を出させる（beforeunload）。
export function blockUnload(event: { preventDefault: () => void; returnValue?: unknown }): void {
  event.preventDefault();
  event.returnValue = '';
}

// 数の欄: 空欄は「未設定」、数でないものは null（直前の値を保つ呼び出し側の判断に使う）。
export function parseNumber(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// タグの欄（触れないパス・コマンドなど）への追加。空・重複は足さない。
export function addTag(list: readonly string[], draft: string): string[] {
  const value = draft.trim();
  return !value || list.includes(value) ? [...list] : [...list, value];
}

export const secondsOf = (ms: unknown): number | undefined => (typeof ms === 'number' ? Math.round(ms / 1000) : undefined);

const KEY_ENV = /^[A-Z][A-Z0-9_]{0,63}$/u;
export const isEnvName = (value: string): boolean => KEY_ENV.test(value);

// API キーの環境変数の名前。プロバイダに書かれたもの（Anthropic で書いていなければ ANTHROPIC_API_KEY）。
export function keyUsage(config: Config): Array<{ name: string; providers: string[] }> {
  const names = new Map<string, string[]>();
  for (const p of config.providers as Array<{ id: string; kind: string; apiKeyEnv?: string }>) {
    const name = p.apiKeyEnv ?? (p.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : undefined);
    if (name) names.set(name, [...(names.get(name) ?? []), p.id]);
  }
  return [...names].map(([name, providers]) => ({ name, providers }));
}

type ProviderRow = { id: string; kind: string; apiKeyEnv?: string };
const providerRows = (config: Config): ProviderRow[] => (Array.isArray(config.providers) ? config.providers as ProviderRow[] : []);

// プロバイダに鍵を入れる環境変数の名前。書かれていればそれ、Anthropic は ANTHROPIC_API_KEY、ほかはサーバーが付ける名前（CLIVE_<ID>_API_KEY）
export function providerKeyEnv(config: Config, id: string): string | undefined {
  const providers = providerRows(config);
  const provider = providers.find(p => p.id === id);
  return provider ? keyEnvName(provider, takenKeyEnvs(providers, id)) : undefined;
}

// 同じ環境変数を使うほかのプロバイダ（鍵を入れ直す・消すと、そちらにも効く）。まだ名前を付けていない非 Anthropic は、ほかと重ならない
export function sharedKeyWith(config: Config, id: string): string[] {
  const providers = providerRows(config);
  const provider = providers.find(p => p.id === id);
  const name = provider?.apiKeyEnv ?? (provider?.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : undefined);
  if (!name) return [];
  return providers.filter(p => p.id !== id && (p.apiKeyEnv ?? (p.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : undefined)) === name).map(p => p.id);
}

// 鍵を入れられるのは、保存済みで、編集中の変更が無いプロバイダだけ（鍵は、サーバーが覚えている保存済みの設定の送り先に送られるため）
export function keyReady(saved: Config, draft: Config, id: string): boolean {
  const before = providerRows(saved).find(p => p.id === id);
  const after = providerRows(draft).find(p => p.id === id);
  return before !== undefined && after !== undefined && JSON.stringify(before) === JSON.stringify(after);
}

// 貼り付けた鍵の前後の空白・改行を取り除く（途中は触らない）
export const trimKey = (raw: string): string => raw.trim();

// ID を付け替える。参照している所（チャット・裏方の順番、モデルのプロバイダ）も合わせる。
export function renameModel(config: Config, from: string, to: string): Config {
  if (!to || from === to) return config;
  const swap = (id: string) => (id === from ? to : id);
  const routing = config.routing as { chat: string[]; background: string[] };
  return {
    ...config,
    models: (config.models as Array<{ id: string }>).map(m => (m.id === from ? { ...m, id: to } : m)),
    routing: { ...routing, chat: routing.chat.map(swap), background: routing.background.map(swap) },
  };
}

export function renameProvider(config: Config, from: string, to: string): Config {
  if (!to || from === to) return config;
  return {
    ...config,
    providers: (config.providers as Array<{ id: string }>).map(p => (p.id === from ? { ...p, id: to } : p)),
    models: (config.models as Array<{ provider: string }>).map(m => (m.provider === from ? { ...m, provider: to } : m)),
  };
}
