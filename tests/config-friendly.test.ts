import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { friendlyIssue, PATTERN_MESSAGES } from '../src/config/friendly.ts';
import { AppConfig } from '../src/config/schema.ts';
import { ConfigError, parseConfig } from '../src/config/store.ts';
import { configText } from '../src/shared/messages/config.ts';
import { en } from '../web/src/i18n/en.ts';
import { issueMessage, problemsOf, type Config } from '../web/src/settings/model.ts';
import { startApp } from './app-setup.ts';
import { testConfig } from './helpers.ts';

// 段 9f（追加）: 設定の画面のエラーは、正規表現をそのまま見せない。パターン・長さ・数の範囲に合わないものは、項目ごとの日本語・英語の文にする
// （持ち主が API キーの環境変数名にキーを貼って、「Expected string to match '^[A-Z][A-Z0-9_]{0,63}$'」が出た）

const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;
// 正規表現や、形の検査の英語の文が、そのまま出ていないか
const RAW = /Expected|\^\[|\$$|\{\d|\\d|\[A-Z|\[a-z|\(\?:/u;

function configWith(change: (c: any) => void): any {
  const c = structuredClone(testConfig()) as any;
  change(c);
  return c;
}

function issuesOf(raw: unknown): ConfigError {
  try { parseConfig(raw); } catch (error) { if (error instanceof ConfigError) return error; throw error; }
  throw new Error('通ってしまった');
}

test('持ち主の 2 つの例: ID に「Anthropic」・環境変数名に貼ったキーは、場所と、友好的な文とコードを返す（正規表現は出ない・キーも文に入らない）', () => {
  const pasted = 'sk-ant-api03-AbCdEfGhIjKlMnOp';
  const error = issuesOf(configWith(c => { c.providers[0].id = 'Anthropic'; c.providers[1].apiKeyEnv = pasted; }));
  const id = error.issues.find(i => i.path === 'providers.Anthropic.id')!;
  assert.equal(id.code, 'config.pattern.provider_id');
  assert.match(id.message, /小文字・数字・_・-.*40 文字まで/u);
  const env = error.issues.find(i => i.path.endsWith('.apiKeyEnv'))!;
  assert.equal(env.code, 'config.pattern.key_env');
  assert.match(env.message, /キーそのものではなく、環境変数の「名前」/u);
  assert.match(env.message, /「API キー」の欄/u);
  for (const text of [...error.problems, ...error.issues.map(i => i.message), error.message]) {
    assert.doesNotMatch(text, RAW, text);
    assert.equal(text.includes(pasted), false, '貼られたキーを文に入れない');
  }
  assert.equal(JSON.stringify(error.issues).includes(pasted), false);
  assert.ok(error.problems.some(p => p.startsWith('/providers/0/id: ')), '文（problems）も同じ友好的な文');
  assert.equal(error.issues.length, error.problems.length);
});

test('長さ・数の範囲・形・必須・知らない項目も、友好的な文とコード（params つき）になる', () => {
  const error = issuesOf(configWith(c => {
    c.server.port = 70000;
    c.worker.maxRunsPerHour = 0;
    c.profile.name = '';
    c.models[0].label = 'x'.repeat(81);
    c.worker.quietStart = '25:99';
    c.profile.color = 'red';
    c.models[0].efforts = ['ok', '!bad'];
    c.tools.maxIterations = 1.5;
    c.worker.enabled = 'yes';
    c.profile.shape = 'square-ish';
    c.profile.extra = 1;
  }));
  const at = (path: string) => error.issues.find(i => i.path === path)!;
  assert.deepEqual([at('server.port').code, at('server.port').params], ['config.number.range', { min: 1, max: 65535 }]);
  assert.equal(at('server.port').message, '1 から 65535 までの数にしてください');
  assert.equal(at('worker.maxRunsPerHour').message, '1 から 120 までの数にしてください');
  assert.deepEqual([at('profile.name').code, at('profile.name').message], ['config.string.required', '入力してください']);
  assert.deepEqual([at(`models.${testConfig().models[0]!.id}.label`).code, at(`models.${testConfig().models[0]!.id}.label`).params], ['config.string.max_length', { max: 80 }]);
  assert.equal(at('worker.quietStart').code, 'config.pattern.time');
  assert.equal(at('profile.color').code, 'config.pattern.color');
  assert.ok(error.issues.some(i => i.path.endsWith('.efforts.1') && i.code === 'config.pattern.effort'), String(error.issues.map(i => i.path)));
  assert.equal(at('tools.maxIterations').code, 'config.type.integer');
  assert.equal(at('worker.enabled').code, 'config.type.boolean');
  assert.equal(at('profile.shape').code, 'config.type.choice');
  assert.match(at('profile.shape').message, /次のどれかにしてください: .*pebble/u);
  assert.equal(at('profile.extra').code, 'config.unexpected');
  for (const text of [...error.problems, ...error.issues.map(i => i.message)]) assert.doesNotMatch(text, RAW, text);
});

test('スキーマの形の決まり（pattern・長さ・数の範囲・個数）を持つ項目はすべて、友好的な文がある（足し忘れたら、ここで落ちる）', () => {
  const found: string[] = [];
  const walk = (node: any, path: string, visit: (node: any, path: string) => void) => {
    if (node === null || typeof node !== 'object') return;
    visit(node, path);
    for (const [key, child] of Object.entries<any>(node.properties ?? {})) walk(child, `${path}.${key}`, visit);
    if (node.items) walk(node.items, `${path}[]`, visit);
    for (const child of node.anyOf ?? []) walk(child, path, visit);
    for (const [key, child] of Object.entries<any>(node.patternProperties ?? {})) walk(child, `${path}{${key}}`, visit);
  };
  const constrained: Array<{ node: any; path: string }> = [];
  walk(AppConfig, 'config', (node, path) => {
    if (['pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'].some(k => node[k] !== undefined)) constrained.push({ node, path });
  });
  assert.ok(constrained.length >= 40, `${constrained.length} 件しか見つからない（読み取りの失敗）`);
  const patterns = constrained.filter(c => c.node.pattern !== undefined);
  assert.ok(patterns.length >= 6, 'pattern を持つ項目');
  for (const { node, path } of patterns) assert.ok(PATTERN_MESSAGES.has(node.pattern), `${path}: pattern ${node.pattern} の文が無い`);
  // 項目ごとに、決まりを破る値を入れて、出てくる誤りがすべて友好的な文になること
  const bad = (node: any): unknown[] => {
    const out: unknown[] = [];
    if (node.pattern !== undefined) out.push('!!!');
    if (node.minLength !== undefined) out.push('');
    if (node.maxLength !== undefined) out.push('x'.repeat(node.maxLength + 1));
    if (node.minimum !== undefined) out.push(node.minimum - 1);
    if (node.maximum !== undefined) out.push(node.maximum + 1);
    if (node.minItems !== undefined) out.push([]);
    if (node.maxItems !== undefined) out.push(Array.from({ length: node.maxItems + 1 }, () => 'a'));
    return out;
  };
  let checked = 0;
  for (const { node, path } of constrained) {
    const wrapper = Type.Object({ x: node });
    for (const value of bad(node)) {
      const errors = [...Value.Errors(wrapper, { x: value })];
      assert.ok(errors.length > 0, `${path}: ${JSON.stringify(value).slice(0, 30)} が通ってしまう`);
      for (const e of errors) {
        const friendly = friendlyIssue(e);
        assert.ok(friendly, `${path}: ${e.message} の友好的な文が無い`);
        const ja = configText('ja', friendly.code, friendly.params);
        const enText = configText('en', friendly.code, friendly.params);
        for (const text of [ja, enText]) { assert.doesNotMatch(text, RAW, `${path}: ${text}`); assert.doesNotMatch(text, /\{\w+\}/u, `${path}: 差し込みが残っている ${text}`); }
        assert.doesNotMatch(enText, CJK, `${path}: 英語に日本語が混ざる`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 60, `${checked} 件しか確かめていない`);
});

test('形の誤り（型）: 文字・整数・数・オンオフ・一覧・まとまり・選択肢・必須・知らない項目、すべて友好的な文になる', () => {
  const schema = Type.Object({
    s: Type.String(), i: Type.Integer(), n: Type.Number(), b: Type.Boolean(), a: Type.Array(Type.String()),
    o: Type.Object({ r: Type.String() }, { additionalProperties: false }), u: Type.Union([Type.Literal('a'), Type.Literal('b')]), v: Type.Literal(1),
  }, { additionalProperties: false });
  const errors = [...Value.Errors(schema, { s: 1, i: 'x', n: 'x', b: 'x', a: 'x', o: { extra: 1 }, u: 'c', v: 2, more: 1 })];
  assert.ok(errors.length >= 9, `${errors.length}`);
  for (const e of errors) {
    const friendly = friendlyIssue(e);
    assert.ok(friendly, `${e.path}: ${e.message}`);
    for (const language of ['ja', 'en'] as const) assert.doesNotMatch(configText(language, friendly.code, friendly.params), RAW, `${e.path}`);
  }
});

test('API: 設定の保存の 400 は、issues に場所・友好的な文・コード・params を持つ。画面の言語で書き直せる', async t => {
  const s = await startApp(t);
  const config = configWith(c => { c.providers[0].id = 'Anthropic'; c.server.port = 70000; });
  const res = await s.json('/api/settings', 'PUT', { config });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_config');
  const id = res.body.issues.find((i: any) => i.path === 'providers.Anthropic.id');
  assert.equal(id.code, 'config.pattern.provider_id');
  assert.match(id.message, /小文字・数字/u);
  const port = res.body.issues.find((i: any) => i.path === 'server.port');
  assert.deepEqual(port.params, { min: 1, max: 65535 });
  for (const text of [...res.body.problems, res.body.message]) assert.doesNotMatch(text, RAW, text);
  // 画面の読み取り: 英語なら英語の文、日本語なら日本語の文。コードの無い古い応答はサーバーの文のまま
  const draft: Config = { providers: [{ id: 'Anthropic' }], models: [] };
  const english = problemsOf(res.body, 'failed', draft, 'en');
  assert.match(english.find(p => p.path === 'providers.Anthropic.id')!.message, /^An ID uses lowercase letters/u);
  assert.equal(english.find(p => p.path === 'server.port')!.message, 'Use a number from 1 to 65535');
  const japanese = problemsOf(res.body, 'failed', draft, 'ja');
  assert.match(japanese.find(p => p.path === 'providers.Anthropic.id')!.message, /小文字・数字/u);
  assert.equal(issueMessage({ path: 'a', message: 'サーバーの文' }, 'en'), 'サーバーの文');
  assert.equal(issueMessage({ path: 'a', message: 'x', code: 'config.nope.nope' }, 'en'), 'x', '表に無いコードも、サーバーの文のまま');
  assert.equal(issueMessage({ path: 'a', message: 'x', code: 'config.number.range', params: { min: 1 } }, 'en'), 'x', '差し込みの値が足りなければ、サーバーの文のまま');
});

test('辞書: 画面の「プロバイダ」の名前の欄などの説明で、正規表現を書いていない', () => {
  for (const key of Object.keys(en)) {
    const entry = (en as Record<string, unknown>)[key];
    if (typeof entry === 'string') assert.doesNotMatch(entry, /\^\[|Expected string/u, key);
  }
});
