import type { App } from '../app.ts';
import type { ProviderConfig } from '../config/schema.ts';
import { ConfigError, parseConfig } from '../config/store.ts';
import { EnvFileError, removeEnvValue, setEnvValue } from '../env-file.ts';
import { isSecretEnvName, keyEnvName, keyProblem, MAX_KEY_CHARS, takenKeyEnvs } from '../shared/provider-key.ts';
import { configProblem, problem, readJson, requireObject, type Router, sendJson } from './http.ts';

// API キーを画面から入れる（段 9f）。鍵は .env にだけ書き、応答・ログ・DB・SSE のどこにも出さない。GET が返すのは「入っているか」と末尾 4 文字だけ。
// ほかの書き込みと同じ Host・Origin・Sec-Fetch-Site の確かめを通った要求だけが届く。モデルの道具には足さない（会話の確かめを通らない、画面専用）。
// シェルからこの API を呼ぶ形は、この PC の中のサーバーへの接続（code.loopback）として、毎回、中身を見せて人の承認を求める

type KeyState = { set: boolean; last4: string | null };

const NOT_SET: KeyState = { set: false, last4: null };

function envProblem(error: unknown): never {
  if (error instanceof EnvFileError && error.reason === 'value') throw problem(400, 'invalid_field', 'key_unsupported', { field: 'key' });
  if (error instanceof EnvFileError) throw problem(409, 'env_unwritable', 'env_unwritable', { params: { reason: error.message } });
  throw error;
}

export function registerKeyRoutes(router: Router, app: App): void {
  const providerOf = (id: string): { config: ReturnType<App['config']>; provider: ProviderConfig } => {
    const config = app.config();
    const provider = config.providers.find(p => p.id === id);
    if (!provider) throw problem(404, 'not_found', 'provider_missing', { params: { id } });
    return { config, provider };
  };
  const stateOf = (name: string): KeyState => {
    const value = app.env[name]?.trim();
    return value ? { set: true, last4: value.slice(-4) } : NOT_SET;
  };
  // このプロバイダが読む環境変数の名前。まだ決めていない非 Anthropic のプロバイダは、鍵を入れるまで「入っていない」
  const readName = (provider: ProviderConfig): string | undefined => provider.apiKeyEnv ?? (provider.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : undefined);

  router.add('GET', '/api/providers/:id/key', ({ res, params }) => {
    const { provider } = providerOf(params[0]!);
    const name = readName(provider);
    sendJson(res, 200, name ? stateOf(name) : NOT_SET);
  });

  router.add('PUT', '/api/providers/:id/key', async ({ req, res, params }) => {
    const body = requireObject(await readJson(req));
    const key = body.key;
    const bad = typeof key === 'string' ? keyProblem(key) : 'empty';
    if (typeof key !== 'string' || bad) {
      const code = ({ empty: 'key_empty', chars: 'key_chars', padded: 'key_padded', too_long: 'key_too_long' } as const)[bad ?? 'empty'];
      throw problem(400, 'invalid_field', code, { field: 'key', ...(bad === 'too_long' ? { params: { max: MAX_KEY_CHARS } } : {}) });
    }
    // ここから書き終えるまで await を挟まない（二つの要求が、古い設定を読んだまま上書きし合わないように）
    const { config, provider } = providerOf(params[0]!);
    const name = keyEnvName(provider, takenKeyEnvs(config.providers, provider.id));
    if (!isSecretEnvName(name)) throw problem(409, 'conflict', 'key_env_unsafe', { params: { env: name } });
    const next = provider.apiKeyEnv === undefined && provider.kind !== 'anthropic'
      ? { ...config, providers: config.providers.map(p => (p.id === provider.id ? { ...p, apiKeyEnv: name } : p)) }
      : undefined;
    // 設定が通らない形になる（この PC の外への http に鍵を使う、など）なら、.env を書く前に断る
    if (next) {
      try { parseConfig(structuredClone(next)); }
      catch (error) { if (error instanceof ConfigError) throw configProblem(error); throw error; }
    }
    try { setEnvValue(app.paths.env, name, key); } catch (error) { envProblem(error); }
    app.env[name] = key;
    const applying = next ? app.applyConfig(next) : app.status.probeAll(config);
    try { await applying; }
    catch (error) { if (error instanceof ConfigError) throw configProblem(error); throw error; }
    sendJson(res, 200, stateOf(name));
  });

  router.add('DELETE', '/api/providers/:id/key', async ({ res, params }) => {
    const { config, provider } = providerOf(params[0]!);
    const name = readName(provider);
    if (name) {
      if (!isSecretEnvName(name)) throw problem(409, 'conflict', 'key_env_unsafe', { params: { env: name } });
      try { removeEnvValue(app.paths.env, name); } catch (error) { envProblem(error); }
      delete app.env[name];
      await app.status.probeAll(config);
    }
    sendJson(res, 200, NOT_SET);
  });
}
