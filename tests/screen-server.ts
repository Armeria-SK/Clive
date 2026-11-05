import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { App } from '../src/app.ts';
import { resolvePaths } from '../src/paths.ts';
import { createWebServer } from '../src/web/server.ts';
import { tempDir, testConfig } from './helpers.ts';

// 画面が読む API を、本物のサーバーで確かめるための起動。モデルは使わない（確認は常に ok を返す）。
export async function startScreenServer(t: Parameters<typeof tempDir>[0]) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FAKE_KEY', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  writeFileSync(paths.config, JSON.stringify(config));
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined,
    adapterOverride: provider => ({ provider, stream: async function* () { }, probe: async () => ({ status: 'ok', server: 'fake', effective: 65536, required: 0, message: '' }) as never }),
  });
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); app.close(); });
  const api = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, { ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Origin: origin, ...init.headers } });
  return { app, api };
}
