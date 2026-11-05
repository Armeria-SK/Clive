import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, ConfigStore, defaultConfig, parseConfig } from '../src/config/store.ts';
import { tempDir, testConfig } from './helpers.ts';

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
  const config = testConfig();
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
  const config = testConfig();
  config.providers.push({ id: 'lan', kind: 'openai_compatible', baseUrl: 'http://192.168.1.10:1234/v1', server: 'lmstudio', maxParallel: 1, timeoutMs: 60_000 });
  assert.doesNotThrow(() => parseConfig(config));
});

test('contextLength が minContext より小さくても保存は止めない（使う前の確認で知らせる）', () => {
  const config = testConfig();
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

test('初期値にはモデルが無く、チャットも裏方の順番も空。プロバイダの接続先は残す', t => {
  const path = join(tempDir(t), 'config.json');
  const config = new ConfigStore(path).load();
  assert.deepEqual(config.models, []);
  assert.deepEqual(config.routing, { chat: [], background: [], retriesPerModel: 2 });
  assert.deepEqual(config.providers.map(p => p.id), ['anthropic', 'ollama']);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).models, [], '書き出した設定ファイルにも見本のモデルは入らない');
  assert.doesNotThrow(() => parseConfig(defaultConfig()), 'モデルが 0 個の設定は、そのまま検証を通る');
});

test('doctor: モデルが 0 個なら、そのことを案内して終了コード 1', t => {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });
  const run = spawnSync(process.execPath, ['src/main.ts', 'doctor', '--data-dir', dir], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /設定ファイル: .*（OK）/u);
  assert.match(run.stdout, /NG {2}モデルがまだ設定されていません/u);
  assert.doesNotMatch(run.stdout, /チャットで使えるモデルがありません/u, '「使えない」ではなく「まだ無い」と案内する');
});

test('記憶の古い上限の項目（userMaxChars / notesMaxChars）は、書いてあっても読めて、初期値にはもう書かない', () => {
  assert.deepEqual(Object.keys(defaultConfig().memory).sort(), ['review', 'reviewAfterToolCalls', 'reviewIdleMinutes']);
  const old = parseConfig({ version: 1, server: {}, routing: {}, memory: { userMaxChars: 2000, notesMaxChars: 3000, review: false } });
  assert.equal(old.memory.review, false);
  assert.equal(old.memory.userMaxChars, 2000, '読めるが、使わない');
  assert.equal(old.memory.notesMaxChars, 3000);
  const fresh = parseConfig({ version: 1, server: {}, routing: {} });
  assert.equal(fresh.memory.userMaxChars, undefined, '書かなければ補わない');
  assert.equal(fresh.memory.reviewIdleMinutes, 30);
});
