import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { checkBaseUrl } from '../shared/url.ts';
import { AppConfig, ToolsConfig as ToolsConfigSchema, type ModelConfig, type ProviderConfig, type ToolsConfig } from './schema.ts';

const ToolsSchema = ToolsConfigSchema();

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(message: string, problems: readonly string[] = []) {
    super(problems.length ? `${message}\n- ${problems.join('\n- ')}` : message);
    this.problems = problems;
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
    models: [
      { id: 'claude-sonnet', label: 'Claude Sonnet 5.5', provider: 'anthropic', model: 'claude-sonnet-5-5', minContext: 65536, maxOutputTokens: 8192, toolMode: 'native', vision: true },
      { id: 'claude-haiku', label: 'Claude Haiku 5.5', provider: 'anthropic', model: 'claude-haiku-5-5', minContext: 65536, maxOutputTokens: 8192, toolMode: 'native', vision: true },
      { id: 'local', label: 'ローカル（Ollama）', provider: 'ollama', model: 'qwen3:32b', contextLength: 65536, minContext: 65536, maxOutputTokens: 8192, toolMode: 'native', vision: false },
    ],
    routing: { chat: ['claude-sonnet'], background: ['claude-haiku'], retriesPerModel: 2 },
    tools: defaultTools(),
    profile: { name: 'Clive', shape: 'pebble', color: '#61B8A5', motion: 'auto' },
    worker: { enabled: true, autonomy: false, maxRunsPerHour: 6, idleMinutes: 5, quietStart: '', quietEnd: '', selfTasksNeedApproval: false, remindAfterHours: 12, curiosityPerDay: 2 },
    memory: { userMaxChars: 2000, notesMaxChars: 3000, review: true, reviewIdleMinutes: 30, reviewAfterToolCalls: 8 },
  };
}

export function defaultTools(): ToolsConfig {
  return Value.Default(ToolsSchema, {}) as ToolsConfig;
}

export function semanticProblems(config: AppConfig): string[] {
  const problems: string[] = [];
  const providerIds = new Set<string>();
  for (const provider of config.providers) {
    if (providerIds.has(provider.id)) problems.push(`providers: ID「${provider.id}」が重複しています`);
    providerIds.add(provider.id);
    if (provider.kind === 'openai_compatible' && !provider.baseUrl) problems.push(`providers.${provider.id}: OpenAI 互換には baseUrl が必要です`);
    if (provider.baseUrl !== undefined) {
      const checked = checkBaseUrl(provider.baseUrl, Boolean(provider.apiKeyEnv));
      if ('problem' in checked) problems.push(`providers.${provider.id}.baseUrl: ${checked.problem}`);
    }
  }
  const modelIds = new Set<string>();
  for (const model of config.models) {
    if (modelIds.has(model.id)) problems.push(`models: ID「${model.id}」が重複しています`);
    modelIds.add(model.id);
    const provider = config.providers.find(p => p.id === model.provider);
    if (!provider) { problems.push(`models.${model.id}: プロバイダ「${model.provider}」がありません`); continue; }
    if (provider.kind !== 'anthropic' && model.contextLength === undefined) {
      problems.push(`models.${model.id}: ローカル LLM や OpenAI 互換では contextLength が必須です（docs/config.md を参照）`);
    }
    // contextLength < minContext は保存を止めない（使う前の確認で「使えない」と知らせる）。
    // 起動や保存を拒否すると、メタデータの誤りで全体が止まってしまう
    if (model.contextLength !== undefined && model.maxOutputTokens >= model.contextLength) {
      problems.push(`models.${model.id}: maxOutputTokens がコンテキスト長以上です`);
    }
  }
  for (const route of ['chat', 'background'] as const) {
    for (const id of config.routing[route]) if (!modelIds.has(id)) problems.push(`routing.${route}: モデル「${id}」がありません`);
  }
  for (const origin of config.server.origins) {
    try { if (new URL(origin).origin !== origin) problems.push(`server.origins: 「${origin}」は origin（末尾の / やパスなし）で書いてください`); }
    catch { problems.push(`server.origins: 「${origin}」が URL として読めません`); }
  }
  return problems;
}

export function parseConfig(raw: unknown): AppConfig {
  const withDefaults = Value.Default(AppConfig, Value.Clone(raw));
  if (!Value.Check(AppConfig, withDefaults)) {
    const problems = [...Value.Errors(AppConfig, withDefaults)].slice(0, 20).map(e => `${e.path || '/'}: ${e.message}`);
    throw new ConfigError('設定ファイルの形式が正しくありません', problems);
  }
  const config = withDefaults as AppConfig;
  const problems = semanticProblems(config);
  if (problems.length) throw new ConfigError('設定の内容に問題があります', problems);
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
