import assert from 'node:assert/strict';
import { test } from 'node:test';
import { en } from '../web/src/i18n/en.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { errorBodyText } from '../web/src/server-text.ts';
import { accessKey, keyEntryAccess } from '../web/src/settings/access.ts';
import { keyEnvUnsafe, keyReady, providerKeyEnv, sharedKeyWith, trimKey, type Config } from '../web/src/settings/model.ts';

// 段 9f: 設定の「プロバイダ」の節の API キーの欄の、画面を使わない部分

const config = (): Config => ({
  providers: [
    { id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8080/v1' },
    { id: 'remote', kind: 'openai_compatible', baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'EXAMPLE_API_KEY' },
    { id: 'claude', kind: 'anthropic' },
    { id: 'claude2', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    { id: 'my-llm', kind: 'ollama', baseUrl: 'http://localhost:11434' },
  ],
});

test('外のアドレスに鍵を送るときは、送り先を並べて確かめる（keyEntryAccess）: この PC の中・Anthropic の既定の宛先は確かめない', () => {
  const [local, remote, claude, , mine] = config().providers as Array<Record<string, unknown>>;
  assert.deepEqual(keyEntryAccess(local!), []);
  assert.deepEqual(keyEntryAccess(mine!), [], 'localhost もこの PC の中');
  assert.deepEqual(keyEntryAccess(claude!), [], 'Anthropic の既定の宛先（baseUrl なし）は、確かめ続けても意味がない');
  assert.deepEqual(keyEntryAccess(remote!), [{ kind: 'provider-key-send', id: 'remote', url: 'https://api.example.com/v1' }]);
  assert.deepEqual(keyEntryAccess({ id: 'lan', kind: 'openai_compatible', baseUrl: 'http://192.168.1.20:8000/v1' }), [{ kind: 'provider-key-send', id: 'lan', url: 'http://192.168.1.20:8000/v1' }], '同じ LAN の別の機械もこの PC の外');
  assert.deepEqual(keyEntryAccess({ id: 'a', kind: 'anthropic', baseUrl: 'https://proxy.example.net' }), [{ kind: 'provider-key-send', id: 'a', url: 'https://proxy.example.net' }], '送り先を変えた Anthropic は確かめる');
  assert.equal(keyEntryAccess({ id: 'odd', kind: 'openai_compatible', baseUrl: 'not a url' }).length, 1, '読めない宛先は外として扱う');
  assert.notEqual(accessKey(keyEntryAccess(remote!)), accessKey([]));
});

test('辞書: 鍵を送る確かめの文は ja と en の両方にあり、送り先が入る', () => {
  assert.match((ja['access.providerKeySend'] as (a: string, b: string) => string)('remote', 'https://api.example.com/v1'), /remote.*https:\/\/api\.example\.com\/v1/u);
  assert.match((en['access.providerKeySend'] as (a: string, b: string) => string)('remote', 'https://api.example.com/v1'), /remote.*https:\/\/api\.example\.com\/v1/u);
});

test('鍵の環境変数の名前（providerKeyEnv）: 書かれていればそれ。Anthropic は ANTHROPIC_API_KEY。ほかは ID から作り、重なれば番号を足す', () => {
  const c = config();
  assert.equal(providerKeyEnv(c, 'remote'), 'EXAMPLE_API_KEY');
  assert.equal(providerKeyEnv(c, 'claude'), 'ANTHROPIC_API_KEY');
  assert.equal(providerKeyEnv(c, 'local'), 'CLIVE_LOCAL_API_KEY');
  assert.equal(providerKeyEnv(c, 'my-llm'), 'CLIVE_MY_LLM_API_KEY');
  assert.equal(providerKeyEnv(c, 'nope'), undefined);
  (c.providers as Array<Record<string, unknown>>).push({ id: 'my_llm', kind: 'ollama', apiKeyEnv: 'CLIVE_MY_LLM_API_KEY' });
  assert.equal(providerKeyEnv(c, 'my-llm'), 'CLIVE_MY_LLM_API_KEY_2');
});

test('同じ環境変数を使うほかのプロバイダ（sharedKeyWith）: 入れ直す・消すと、そちらにも効くので知らせる', () => {
  const c = config();
  assert.deepEqual(sharedKeyWith(c, 'claude'), ['claude2'], 'apiKeyEnv を書いていない Anthropic と、書いている Anthropic');
  assert.deepEqual(sharedKeyWith(c, 'claude2'), ['claude']);
  assert.deepEqual(sharedKeyWith(c, 'remote'), []);
  assert.deepEqual(sharedKeyWith(c, 'local'), [], 'まだ名前を付けていないものは、ほかと重ならない');
});

test('鍵を入れられるのは、保存済みで、編集中の変更が無いプロバイダだけ（keyReady）', () => {
  const saved = config();
  assert.equal(keyReady(saved, structuredClone(saved), 'remote'), true);
  const edited = structuredClone(saved);
  (edited.providers as Array<Record<string, unknown>>)[1]!.baseUrl = 'https://evil.example/v1';
  assert.equal(keyReady(saved, edited, 'remote'), false, '送り先を変えたまま鍵を入れさせない（鍵は保存済みの送り先に送られる）');
  const added = structuredClone(saved);
  (added.providers as Array<Record<string, unknown>>).push({ id: 'fresh', kind: 'ollama' });
  assert.equal(keyReady(saved, added, 'fresh'), false, 'まだ保存していないプロバイダ');
  assert.equal(keyReady(saved, added, 'remote'), true, 'ほかのプロバイダの編集は関係ない');
});

test('貼り付けた鍵の前後の空白・改行は取り除いて送る（途中は触らない）', () => {
  assert.equal(trimKey('  sk-abc  '), 'sk-abc');
  assert.equal(trimKey('sk-abc\n'), 'sk-abc');
  assert.equal(trimKey('\r\nsk-abc\t'), 'sk-abc');
  assert.equal(trimKey('a b'), 'a b');
  assert.equal(trimKey('   '), '');
});

test('鍵の API の失敗は、コードから画面の言語の文になる（鍵そのものは入らない）', () => {
  for (const [code, params, ja_, en_] of [
    ['http.key_empty', {}, /API キーを入力/u, /Enter the API key/u],
    ['http.key_chars', {}, /使えない文字/u, /cannot be used/u],
    ['http.key_padded', {}, /前か後ろに空白/u, /space before or after/u],
    ['http.key_too_long', { max: 2048 }, /2048/u, /2048/u],
    ['http.key_unsupported', {}, /\.env に安全に書けません/u, /cannot be written to \.env safely/u],
    ['http.key_env_unsafe', { env: 'PATH' }, /PATH/u, /PATH/u],
    ['http.env_unwritable', { reason: 'x' }, /\.env に書けなかった/u, /Could not write to \.env/u],
    ['http.provider_missing', { id: 'x' }, /設定にありません/u, /not in the settings/u],
  ] as const) {
    assert.match(errorBodyText({ code, params }, 'ja')!, ja_, code);
    assert.match(errorBodyText({ code, params }, 'en')!, en_, code);
  }
});

test('鍵の名前として使えない環境変数名（KEY・TOKEN・SECRET・PASSWORD・CREDENTIAL のどれも含まない）のときは、鍵の欄を出さずに注意を出す（keyEnvUnsafe）', () => {
  const c = config();
  for (const id of ['remote', 'local', 'claude', 'my-llm']) assert.equal(keyEnvUnsafe(c, id), undefined, id);
  assert.equal(keyEnvUnsafe(c, 'nope'), undefined, '設定に無いプロバイダ');
  const providers = c.providers as Array<Record<string, unknown>>;
  providers[1]!.apiKeyEnv = 'PATH';
  assert.equal(keyEnvUnsafe(c, 'remote'), 'PATH');
  for (const ok of ['MY_CREDENTIALS', 'SVC_TOKEN', 'DB_PASSWORD', 'X_SECRET', 'FOO_KEY']) { providers[1]!.apiKeyEnv = ok; assert.equal(keyEnvUnsafe(c, 'remote'), undefined, ok); }
  providers[1]!.apiKeyEnv = 'NODE_OPTIONS';
  assert.equal(keyEnvUnsafe(c, 'remote'), 'NODE_OPTIONS');
  providers[0]!.apiKeyEnv = 'HOME';
  assert.equal(keyEnvUnsafe(c, 'local'), 'HOME', '名前を付けたあとのプロバイダ');
});

test('辞書: 鍵の名前として使えないときの注意は、使える言葉を 5 つ並べ、詳しい設定の欄を指す。サーバーの 409 の文にも CREDENTIAL が入る', () => {
  for (const [dict, name] of [[ja, 'ja'], [en, 'en']] as const) {
    const text = (dict['settings.key.unsafeEnv'] as (n: string) => string)('PATH');
    assert.match(text, /PATH/u, name);
    for (const word of ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL']) assert.match(text, new RegExp(word, 'u'), `${name}: ${word}`);
    assert.match(text, name === 'ja' ? /詳しい設定/u : /Advanced/u, `${name}: 詳しい設定を指す`);
    assert.equal(typeof dict['settings.key.openAdvanced'], 'string');
  }
  for (const [lang, pattern] of [['ja', /CREDENTIAL/u], ['en', /CREDENTIAL/u]] as const) {
    assert.match(errorBodyText({ code: 'http.key_env_unsafe', params: { env: 'PATH' } }, lang)!, pattern, lang);
  }
});

test('辞書: 末尾 4 文字が無いとき（短い鍵）は、「設定済み」だけを出す（空の「末尾 」を出さない）', () => {
  for (const [dict, withTail, without] of [[ja, /設定済み（末尾 abcd）/u, /^設定済み$/u], [en, /Set \(ends with abcd\)/u, /^Set$/u]] as const) {
    const set = dict['settings.key.set'] as (last4: string) => string;
    assert.match(set('abcd'), withTail);
    assert.match(set(''), without);
  }
});

test('辞書: キーが OS の環境変数にあるときの表示と、消せなかったときの知らせは、ja と en の両方にある', () => {
  for (const [dict, name] of [[ja, 'ja'], [en, 'en']] as const) {
    for (const key of ['settings.key.setOs', 'settings.key.osNote', 'settings.key.stillSetOs'] as const) assert.equal(typeof dict[key], 'string', `${name}: ${key}`);
    assert.match(dict['settings.key.osNote'] as string, name === 'ja' ? /OS の環境変数/u : /operating system/u, name);
    assert.match(dict['settings.key.osNote'] as string, /\.env/u, name);
  }
});
