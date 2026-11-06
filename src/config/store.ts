import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { parseAllowEntry } from '../tools/hooks/allow-entry.ts';
import { checkBaseUrl } from '../shared/url.ts';
import { TOOL_NAME_PATTERN } from '../tools/tool-policy.ts';
import { AppConfig, ToolsConfig as ToolsConfigSchema, type ModelConfig, type ProviderConfig, type ToolsConfig } from './schema.ts';

const ToolsSchema = ToolsConfigSchema();

export interface ConfigIssue { path: string; message: string }

// 文（場所: 内容）から場所と内容を取り出す。issues を渡されなかった ConfigError の代わり。場所が無い文は path が空になる
function issueOfText(text: string): ConfigIssue {
  const colon = text.indexOf(': ');
  return colon > 0 ? { path: text.slice(0, colon), message: text.slice(colon + 2) } : { path: '', message: text };
}

export class ConfigError extends Error {
  // problems は文（画面の古い読み取りと CLI 用）、issues は ID で書いた場所つきの同じ問題（同じ順・同じ数）
  readonly problems: readonly string[];
  readonly issues: readonly ConfigIssue[];
  constructor(message: string, problems: readonly string[] = [], issues: readonly ConfigIssue[] = problems.map(issueOfText)) {
    super(problems.length ? `${message}\n- ${problems.join('\n- ')}` : message);
    this.problems = problems;
    this.issues = issues;
  }
}

export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    timezone: 'Asia/Tokyo',
    server: { host: '127.0.0.1', port: 4777, origins: [], tailscaleLogins: [] },
    providers: [
      { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600_000 },
      { id: 'ollama', kind: 'ollama', baseUrl: OLLAMA_DEFAULT_URL, maxParallel: 1, timeoutMs: 600_000 },
    ],
    models: [],
    routing: { chat: [], background: [], retriesPerModel: 2 },
    tools: defaultTools(),
    profile: { name: 'Clive', shape: 'pebble', color: '#61B8A5', motion: 'auto' },
    worker: { enabled: true, autonomy: false, maxRunsPerHour: 6, idleMinutes: 5, quietStart: '', quietEnd: '', selfTasksNeedApproval: false, remindAfterHours: 12, curiosityPerDay: 2 },
    memory: { review: true, reviewIdleMinutes: 30, reviewAfterToolCalls: 8 },
  };
}

export function defaultTools(): ToolsConfig {
  return Value.Default(ToolsSchema, {}) as ToolsConfig;
}

interface Finding extends ConfigIssue { text: string }

// 内容の問題。path は ID で書いた場所（画面が行に結ぶ）、text は今までどおりの文（場所: 内容）
function findings(config: AppConfig): Finding[] {
  const found: Finding[] = [];
  const add = (path: string, message: string, label = path): void => { found.push({ path, message, text: `${label}: ${message}` }); };
  const providerIds = new Set<string>();
  for (const provider of config.providers) {
    if (providerIds.has(provider.id)) add(`providers.${provider.id}.id`, `ID「${provider.id}」が重複しています`, 'providers');
    providerIds.add(provider.id);
    if (provider.kind === 'openai_compatible' && !provider.baseUrl) add(`providers.${provider.id}.baseUrl`, 'OpenAI 互換には baseUrl が必要です', `providers.${provider.id}`);
    if (provider.baseUrl !== undefined) {
      const checked = checkBaseUrl(provider.baseUrl, Boolean(provider.apiKeyEnv));
      if ('problem' in checked) add(`providers.${provider.id}.baseUrl`, checked.problem);
    }
  }
  const modelIds = new Set<string>();
  for (const model of config.models) {
    if (modelIds.has(model.id)) add(`models.${model.id}.id`, `ID「${model.id}」が重複しています`, 'models');
    modelIds.add(model.id);
    const provider = config.providers.find(p => p.id === model.provider);
    if (!provider) { add(`models.${model.id}.provider`, `プロバイダ「${model.provider}」がありません`, `models.${model.id}`); continue; }
    if (provider.kind !== 'anthropic' && model.contextLength === undefined) {
      add(`models.${model.id}.contextLength`, 'ローカル LLM や OpenAI 互換では contextLength が必須です（README の「ローカル LLM のコンテキスト長」を参照）', `models.${model.id}`);
    }
    // contextLength < minContext は保存を止めない（使う前の確認で「使えない」と知らせる）。
    // 起動や保存を拒否すると、メタデータの誤りで全体が止まってしまう
    if (model.contextLength !== undefined && model.maxOutputTokens >= model.contextLength) {
      add(`models.${model.id}.maxOutputTokens`, 'maxOutputTokens がコンテキスト長以上です', `models.${model.id}`);
    }
  }
  for (const route of ['chat', 'background'] as const) {
    for (const id of config.routing[route]) if (!modelIds.has(id)) add(`routing.${route}`, `モデル「${id}」がありません`);
  }
  config.tools.shell.allow.forEach((entry, i) => {
    if (!parseAllowEntry(entry)) add('tools.shell.allow', `${i + 1} 番目の「${entry}」は書けない形です。決まったコマンドだけ（引用符・変数・ワイルドカード・置換・リダイレクト・区切りを含まない、1 つの文）を書いてください`);
  });
  for (const name of Object.keys(config.tools.policies)) {
    if (!TOOL_NAME_PATTERN.test(name)) add('tools.policies', `「${name}」は道具の名前として書けません（英小文字で始まり、英小文字・数字・_ だけ、64 文字まで）`);
  }
  for (const origin of config.server.origins) {
    try { if (new URL(origin).origin !== origin) add('server.origins', `「${origin}」は origin（末尾の / やパスなし）で書いてください`); }
    catch { add('server.origins', `「${origin}」が URL として読めません`); }
  }
  return found;
}

export function semanticProblems(config: AppConfig): string[] {
  return findings(config).map(f => f.text);
}

// 形式の検査の場所（JSON Pointer。/models/0/contextLength）を、ID で書いた場所（models.<id>.contextLength）に直す。
// 番号が指す項目に id が無いとき、models と providers 以外の一覧は、番号のまま点で結ぶ
function issuePath(pointer: string, raw: unknown): string {
  const segments = pointer.split('/').filter(Boolean).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  const [root, index] = segments;
  if ((root === 'models' || root === 'providers') && index !== undefined && /^\d+$/u.test(index) && typeof raw === 'object' && raw !== null) {
    const list = (raw as Record<string, unknown>)[root];
    const id = Array.isArray(list) ? (list[Number(index)] as { id?: unknown } | null | undefined)?.id : undefined;
    if (typeof id === 'string' && id) segments[1] = id;
  }
  return segments.join('.');
}

export function parseConfig(raw: unknown): AppConfig {
  const withDefaults = Value.Default(AppConfig, Value.Clone(raw));
  if (!Value.Check(AppConfig, withDefaults)) {
    const errors = [...Value.Errors(AppConfig, withDefaults)].slice(0, 20);
    throw new ConfigError('設定ファイルの形式が正しくありません',
      errors.map(e => `${e.path || '/'}: ${e.message}`),
      errors.map(e => ({ path: issuePath(e.path, withDefaults), message: e.message })));
  }
  const config = withDefaults as AppConfig;
  const found = findings(config);
  if (found.length) throw new ConfigError('設定の内容に問題があります', found.map(f => f.text), found.map(({ path, message }) => ({ path, message })));
  return config;
}

export function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, path); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
        continue;
      }
      try { unlinkSync(tmp); } catch { }
      throw error;
    }
  }
}

function fileStamp(path: string): string {
  const s = statSync(path);
  return `${s.mtimeMs}:${s.size}`;
}

export class ConfigStore {
  #cache: AppConfig | undefined;
  #stamp = '';
  #lastError: ConfigError | undefined;
  readonly path: string;
  constructor(path: string) { this.path = path; }

  get lastError(): ConfigError | undefined { return this.#lastError; }

  current(): AppConfig {
    try {
      const config = this.load();
      this.#lastError = undefined;
      return config;
    } catch (error) {
      if (!(error instanceof ConfigError) || !this.#cache) throw error;
      this.#lastError = error;
      try { this.#stamp = fileStamp(this.path); } catch { }
      return structuredClone(this.#cache);
    }
  }

  load(): AppConfig {
    if (!existsSync(this.path)) {
      const config = defaultConfig();
      this.save(config);
      return structuredClone(config);
    }
    const stamp = fileStamp(this.path);
    if (this.#cache && stamp === this.#stamp) return structuredClone(this.#cache);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.path, 'utf8')); }
    catch {
      try { copyFileSync(this.path, `${this.path}.bak`); } catch { }
      throw new ConfigError(`設定ファイル ${this.path} が JSON として壊れています。${this.path}.bak に退避しました。直してから起動し直してください`);
    }
    const config = parseConfig(raw);
    this.#cache = config;
    this.#stamp = stamp;
    return structuredClone(config);
  }

  save(config: AppConfig): AppConfig {
    const parsed = parseConfig(config);
    if (existsSync(this.path)) {
      try { copyFileSync(this.path, `${this.path}.bak`); } catch { }
    }
    atomicWriteFile(this.path, `${JSON.stringify(parsed, null, 2)}\n`);
    this.#cache = parsed;
    this.#stamp = fileStamp(this.path);
    this.#lastError = undefined;
    return structuredClone(parsed);
  }
}

export function findModel(config: AppConfig, id: string): { model: ModelConfig; provider: ProviderConfig } | undefined {
  const model = config.models.find(m => m.id === id);
  const provider = model && config.providers.find(p => p.id === model.provider);
  return model && provider ? { model, provider } : undefined;
}
