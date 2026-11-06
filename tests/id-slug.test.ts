import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import { en } from '../web/src/i18n/en.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { idFromInput, ID_RULES, slugId, uniqueSlug } from '../web/src/settings/ids.ts';

// 段 9f（追加）: プロバイダの「名前（ID）」とモデルの ID の欄は、打った文字を受けて、ID の決まりに直す
// （持ち主が「Anthropic」と打って、providers.Anthropic.id の「Expected string to match '^[a-z0-9]…」で保存できなかった）

const providerPattern = new RegExp(ProviderConfig.properties.id.pattern!, 'u');
const modelPattern = new RegExp(ModelConfig.properties.id.pattern!, 'u');

test('ID の決まり（ID_RULES）は、設定の形（スキーマ）の ID の決まりと同じ長さ', () => {
  assert.equal(ID_RULES.provider.max, 40);
  assert.equal(ID_RULES.model.max, 64);
  assert.match(ProviderConfig.properties.id.pattern!, /\{0,39\}\$$/u);
  assert.match(ModelConfig.properties.id.pattern!, /\{0,63\}\$$/u);
});

test('slugId: 大文字は小文字に、空白は - に、使えない文字は外す（持ち主の「Anthropic」が通る）', () => {
  assert.equal(slugId('Anthropic', 'provider'), 'anthropic');
  assert.equal(slugId('My Server', 'provider'), 'my-server');
  assert.equal(slugId('  Open   AI  ', 'provider'), 'open-ai');
  assert.equal(slugId('a - b', 'provider'), 'a-b', '空白と - が続いても 1 つに');
  assert.equal(slugId('a\tb\nc', 'provider'), 'a-b-c');
  assert.equal(slugId('my_server-2', 'provider'), 'my_server-2', '使える文字はそのまま');
  assert.equal(slugId('a/b\\c:d*e', 'provider'), 'abcde');
});

test('slugId: 全角の英数字は半角にして使う。日本語や絵文字だけなら空（決められない）', () => {
  assert.equal(slugId('Ａｎｔｈｒｏｐｉｃ', 'provider'), 'anthropic');
  assert.equal(slugId('ＯｐｅｎＡＩ　互換', 'provider'), 'openai', '後ろに残った - は外す');
  assert.equal(slugId('エーアイ', 'provider'), '');
  assert.equal(slugId('😀', 'model'), '');
  assert.equal(slugId('   ', 'provider'), '');
  assert.equal(slugId('', 'model'), '');
});

test('slugId: 先頭は英小文字か数字（- _ . は先頭から外す）。後ろの区切りも外す', () => {
  assert.equal(slugId('-abc', 'provider'), 'abc');
  assert.equal(slugId('__x', 'provider'), 'x');
  assert.equal(slugId('.hidden', 'model'), 'hidden');
  assert.equal(slugId('abc-', 'provider'), 'abc');
  assert.equal(slugId('---', 'provider'), '');
  assert.equal(slugId('1st', 'provider'), '1st');
});

test('slugId: モデルの ID は . を使える（プロバイダは使えない）。長さの上限はプロバイダ 40・モデル 64', () => {
  assert.equal(slugId('GPT-4.1 mini', 'model'), 'gpt-4.1-mini');
  assert.equal(slugId('GPT-4.1 mini', 'provider'), 'gpt-41-mini');
  assert.equal(slugId('x'.repeat(100), 'provider').length, 40);
  assert.equal(slugId('x'.repeat(100), 'model').length, 64);
  assert.equal(slugId(`${'x'.repeat(39)}-yyy`, 'provider'), 'x'.repeat(39), '切ったあとに残った区切りは外す');
});

test('slugId: どんな入力でも、空でなければ、スキーマの ID の形に合う（ランダムな文字で試す）', () => {
  const pool = [...'AbZ09 _-./\\:;,*?"<>|~!@#$%^&()[]{}+=\'`\t\n', 'あ', 'ア', '漢', 'Ａ', '１', '　', '😀', 'é', 'ß', 'İ', '​', '‮'];
  let seed = 12345;
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let i = 0; i < 3000; i++) {
    const text = Array.from({ length: 1 + (next() % 70) }, () => pool[next() % pool.length]).join('');
    const p = slugId(text, 'provider');
    const m = slugId(text, 'model');
    if (p !== '') assert.match(p, providerPattern, JSON.stringify(text));
    if (m !== '') assert.match(m, modelPattern, JSON.stringify(text));
  }
});

test('uniqueSlug: 重なれば -2 -3 …。長さの上限を超えないよう、名前のほうを切る', () => {
  assert.equal(uniqueSlug('anthropic', [], 'provider'), 'anthropic');
  assert.equal(uniqueSlug('anthropic', ['anthropic'], 'provider'), 'anthropic-2');
  assert.equal(uniqueSlug('anthropic', ['anthropic', 'anthropic-2'], 'provider'), 'anthropic-3');
  const long = 'x'.repeat(40);
  const next = uniqueSlug(long, [long], 'provider');
  assert.equal(next.length, 40);
  assert.match(next, providerPattern);
  assert.ok(next.endsWith('-2'));
  assert.equal(uniqueSlug(long, [long, next], 'provider').endsWith('-3'), true);
});

test('idFromInput: 打った文字から決まる ID。今の ID と同じなら変えない。決められなければ null。ほかと重なれば番号つき', () => {
  const taken = ['anthropic', 'local'];
  assert.deepEqual(idFromInput('Anthropic', 'provider', taken, 'anthropic'), { id: 'anthropic', changed: false }, '自分自身とは重ならない（大文字にしただけなら変わらない）');
  assert.deepEqual(idFromInput('Local', 'provider', taken, 'anthropic'), { id: 'local-2', changed: true });
  assert.deepEqual(idFromInput('My Server', 'provider', taken, 'anthropic'), { id: 'my-server', changed: true });
  assert.deepEqual(idFromInput('サーバー', 'provider', taken, 'anthropic'), { id: null, changed: false });
  assert.deepEqual(idFromInput('  ', 'provider', taken, 'anthropic'), { id: null, changed: false });
  assert.deepEqual(idFromInput('new-provider', 'provider', taken, 'new-provider'), { id: 'new-provider', changed: false });
  assert.deepEqual(idFromInput('foo', 'provider', ['foo', 'foo-2'], 'foo-2'), { id: 'foo-2', changed: false }, '番号つきの自分の ID に戻る形も、自分自身とは重ならない');
});

test('辞書: 直した ID の見せ方と、決められないときの文は ja と en の両方にある', () => {
  assert.equal((ja['settings.id.preview'] as (id: string) => string)('anthropic'), 'ID: anthropic');
  assert.equal((en['settings.id.preview'] as (id: string) => string)('anthropic'), 'ID: anthropic');
  assert.notEqual(ja['settings.id.none'], en['settings.id.none']);
  assert.match(String(en['settings.id.none']), /letters|digits/u);
});
