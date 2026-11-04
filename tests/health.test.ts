import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import { defaultConfig } from '../src/config/store.ts';
import { COOLDOWN_MS, FAILURE_THRESHOLD } from '../src/engine/health.ts';
import { resolvePaths } from '../src/paths.ts';
import { ProviderError } from '../src/providers/types.ts';
import { fail, FakeAdapter, reply, tempDir } from './helpers.ts';

async function setup(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = defaultConfig();
  config.providers = [
    { id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 },
    { id: 'backup', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:2/v1', maxParallel: 1, timeoutMs: 10_000 },
  ];
  config.models = [
    { id: 'a', provider: 'local', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false },
    { id: 'b', provider: 'backup', model: 'y', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false },
  ];
  config.routing = { chat: ['a', 'b'], background: [], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-05T01:00:00Z') };
  const adapters = new Map<string, FakeAdapter>();
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false,
    adapterOverride: p => { const a = new FakeAdapter(p); adapters.set(p.id, a); return a; },
  });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  const send = async (cid: string) => {
    const outcome = app.engine.send(cid, 'こんにちは');
    assert.ok(outcome.ok);
    return app.engine.wait(outcome.runId);
  };
  return { app, local: () => adapters.get('local')!, backup: () => adapters.get('backup')!, clock, send };
}

const down = () => fail(new ProviderError('provider_error', 'サーバーが落ちています（HTTP 503）', { retryable: false, status: 503 }));

test('続けて失敗したモデルは後回しにして知らせ、成功したら戻す', async t => {
  const s = await setup(t);
  for (let i = 0; i < FAILURE_THRESHOLD; i++) {
    s.local().scripts.push(down());
    s.backup().scripts.push(reply(`予備です ${i}`));
    assert.ok((await s.send(`c${i}`))?.ok, '予備のモデルで返事ができる');
  }
  assert.equal(s.app.health.failures('a'), FAILURE_THRESHOLD);
  assert.ok(s.app.status.coolingDown('a', s.clock.now));
  const alert = s.app.notifications.list()[0]!;
  assert.equal(alert.kind, 'health_alert');
  assert.match(alert.title, /「a」が続けて失敗/u);

  // 後回しの間は、予備を先に使う（ローカルは呼ばない）
  const localCalls = s.local().calls.length;
  s.backup().scripts.push(reply('予備が先'));
  assert.ok((await s.send('c-next'))?.ok);
  assert.equal(s.local().calls.length, localCalls);

  // 予備も落ちたら、後回しにしたモデルも最後に試す（外してはいない）
  s.backup().scripts.push(down());
  s.local().scripts.push(reply('ローカルが復活'));
  const result = await s.send('c-last');
  assert.ok(result?.ok);
  assert.equal(s.app.status.coolingDown('a', s.clock.now), undefined, '成功したら後回しをやめる');
  assert.equal(s.app.health.failures('a'), 0);
});

test('後回しは時間が経てば終わる。API キーの誤りは 1 回目で知らせる', async t => {
  const s = await setup(t);
  for (let i = 0; i < FAILURE_THRESHOLD; i++) { s.local().scripts.push(down()); s.backup().scripts.push(reply('ok')); await s.send(`c${i}`); }
  assert.ok(s.app.status.coolingDown('a', s.clock.now));
  assert.equal(s.app.status.coolingDown('a', s.clock.now + COOLDOWN_MS + 1), undefined);

  s.backup().scripts.push(fail(new ProviderError('auth', 'API キーが違います（HTTP 401）', { retryable: false, status: 401 })));
  s.local().scripts.push(reply('ok'));
  s.clock.now += COOLDOWN_MS + 1;
  s.local().scripts.unshift(down());
  await s.send('c-auth');
  assert.ok(s.app.notifications.list().some(n => /「b」の認証/u.test(n.title)));
});
