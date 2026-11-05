import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { App } from '../src/app.ts';
import type { ModelConfig } from '../src/config/schema.ts';
import { resolvePaths } from '../src/paths.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { createWebServer } from '../src/web/server.ts';
import { FakeAdapter, tempDir, testConfig } from './helpers.ts';

export function fakeModel(id: string, over: Partial<ModelConfig> = {}): ModelConfig {
  return { id, provider: 'fake', model: `${id}-name`, contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false, ...over };
}

// 本物の App と Web サーバーを、偽のモデルの提供元で立ち上げる（ランダムなポート）。api() は Origin つきで呼ぶ
export async function startApp(t: { after: (fn: () => void | Promise<void>) => void }, options: { models?: ModelConfig[]; tools?: ToolDef[]; configure?: (config: ReturnType<typeof testConfig>) => void } = {}) {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FAKE_KEY', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = options.models ?? [fakeModel('m1'), fakeModel('m2')];
  config.routing = { chat: config.models.map(m => m.id), background: [], retriesPerModel: 0 };
  options.configure?.(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const adapters = new Map<string, FakeAdapter>();
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, workerTimers: false,
    adapterOverride: provider => { const made = new FakeAdapter(provider); adapters.set(provider.id, made); return made; },
    ...(options.tools ? { tools: options.tools } : {}),
  });
  await app.status.probeAll(app.config());
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const port = (web.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  web.setOrigins([origin]);
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); app.close(); });
  const api = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, {
    ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Origin: origin, ...init.headers },
  });
  const json = async (path: string, method: string, body?: unknown) => {
    const res = await api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };
  return { app, web, adapter: () => adapters.get('fake')!, adapters, origin, api, json, paths };
}

export const CONVERSATION = 'aaaaaaaa-0000-4000-8000-000000000001';
export const uuid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

// 実行が終わるまで待つ（wait() は終わったあとだと undefined を返すので、実行の記録で見る）
export async function settled(app: App, runId: string): Promise<void> {
  await waitFor(() => app.runs.get(runId)?.ended_at != null, `run ${runId} ended`);
}

export async function waitFor(check: () => boolean, label = 'condition', ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise(r => setTimeout(r, 5));
  }
}
