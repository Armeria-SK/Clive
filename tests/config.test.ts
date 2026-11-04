import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, ConfigStore, defaultConfig, parseConfig } from '../src/config/store.ts';
import { tempDir } from './helpers.ts';

test('設定ファイルが無ければ既定値で作る', t => {
  const path = join(tempDir(t), 'config.json');
  const config = new ConfigStore(path).load();
  assert.equal(config.server.host, '127.0.0.1');
  assert.ok(existsSync(path));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), config);
});

test('保存した内容を読み直せる', t => {
  const store = new ConfigStore(join(tempDir(t), 'config.json'));
  const config = store.load();
  config.timezone = 'UTC';
  store.save(config);
  assert.equal(new ConfigStore(store.path).load().timezone, 'UTC');
});

test('JSON として壊れていたら .bak に退避し、上書きせずにエラーにする', t => {
  const path = join(tempDir(t), 'config.json');
  writeFileSync(path, '{ broken');
  assert.throws(() => new ConfigStore(path).load(), ConfigError);
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), '{ broken');
  assert.equal(readFileSync(path, 'utf8'), '{ broken');
});

test('省略した項目には既定値が入る', () => {
  const raw = { version: 1, server: {}, routing: {} };
  const config = parseConfig(raw);
  assert.equal(config.server.port, 4777);
  assert.deepEqual(config.routing.chat, []);
  assert.equal(config.timezone, 'Asia/Tokyo');
});

test('形式の誤りは場所つきで返す', () => {
  const raw = { ...defaultConfig(), server: { host: '127.0.0.1', port: 'x' } };
  assert.throws(() => parseConfig(raw), (e: unknown) => e instanceof ConfigError && e.problems.some(p => p.includes('/server/port')));
});

test('整合性の問題をまとめて返す', () => {
  const config = defaultConfig();
  config.models.push({ ...config.models[0]!, provider: 'nope' });
  config.models.push({ id: 'local2', provider: 'ollama', model: 'x', minContext: 65536, maxOutputTokens: 8192, toolMode: 'native', vision: false });
  config.routing.chat = ['missing'];
  config.providers.push({ id: 'remote', kind: 'openai_compatible', baseUrl: 'http://192.168.1.10:8000/v1', apiKeyEnv: 'REMOTE_KEY', maxParallel: 1, timeoutMs: 60_000 });
  assert.throws(() => parseConfig(config), (e: unknown) => {
    const problems = (e as ConfigError).problems.join('\n');
    return /重複/.test(problems) && /contextLength が必須/.test(problems) && /routing\.chat/.test(problems) && /https にしてください/.test(problems);
  });
});

test('キーを使わないローカルネットワークの http は許す', () => {
  const config = defaultConfig();
  config.providers.push({ id: 'lan', kind: 'openai_compatible', baseUrl: 'http://192.168.1.10:1234/v1', server: 'lmstudio', maxParallel: 1, timeoutMs: 60_000 });
  assert.doesNotThrow(() => parseConfig(config));
});

test('contextLength が minContext より小さくても保存は止めない（使う前の確認で知らせる）', () => {
  const config = defaultConfig();
  config.models[2]!.contextLength = 16384; // minContext（65536）より小さい
  assert.doesNotThrow(() => parseConfig(config));
});

test('動いている途中でファイルが不正になっても、直前の正しい設定で動き続ける', t => {
  const store = new ConfigStore(join(tempDir(t), 'config.json'));
  const good = store.current();
  writeFileSync(store.path, JSON.stringify({ ...good, server: { ...good.server, port: 'x' } }));
  const now = store.current();
  assert.equal(now.server.port, good.server.port);
  assert.ok(store.lastError);
  store.save(good);
  assert.equal(store.lastError, undefined);
});

test('保存のたびに前の版を .bak に残す', t => {
  const store = new ConfigStore(join(tempDir(t), 'config.json'));
  const config = store.load();
  config.timezone = 'UTC';
  store.save(config);
  assert.equal(JSON.parse(readFileSync(`${store.path}.bak`, 'utf8')).timezone, 'Asia/Tokyo');
});

test('$schema キーは受け付ける', () => {
  assert.doesNotThrow(() => parseConfig({ ...defaultConfig(), $schema: './config.schema.json' }));
});
