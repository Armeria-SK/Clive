import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { en } from '../web/src/i18n/en.ts';
import { copyText } from '../web/src/clipboard.ts';
import { getLanguagePreference, setLanguagePreference } from '../web/src/i18n/index.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { adoptLanguageInDraft, configWithLanguage, loadPromptAnswer, savePromptAnswer, saveLanguage, shouldAskLanguage, withAdoptedLanguage } from '../web/src/language.ts';
import {
  addModel, addProvider, addTag, addToRoute, closeAction, countChanges, isEnvName, isSection, keyUsage, moveInRoute, parseNumber, parseProblem, providerInUse, pruned,
  removeFromRoute, removeModel, removeProvider, renameModel, renameProvider, SECTION_GROUPS, SECTION_IDS, sectionChanged, secondsOf, uniqueId,
  updateAt, updateIn, updateListItem, type Config,
} from '../web/src/settings/model.ts';
import { editsToKeep, restoreKept } from '../web/src/settings/keep.ts';
import { applyEdits, diffConfig } from '../web/src/settings/merge.ts';
import { differs, errorFor } from '../web/src/settings/types.ts';

function sample(): Config {
  return {
    language: undefined,
    timezone: 'Asia/Tokyo',
    server: { port: 4780, origins: ['http://a.ts.net'], tailscaleLogins: [] },
    providers: [
      { id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1234/v1', apiKeyEnv: 'LOCAL_KEY', maxParallel: 1, timeoutMs: 600000 },
      { id: 'claude', kind: 'anthropic', maxParallel: 2, timeoutMs: 120000 },
    ],
    models: [
      { id: 'big', provider: 'local', model: 'qwen', contextLength: 32768, minContext: 8192, maxOutputTokens: 4096, toolMode: 'native', vision: false },
      { id: 'sonnet', provider: 'claude', model: 'claude-sonnet', minContext: 8192, maxOutputTokens: 4096, toolMode: 'native', vision: true },
    ],
    routing: { chat: ['big', 'sonnet'], background: ['big'], retriesPerModel: 1 },
    tools: { deny: ['.env'], shell: { enabled: true, allow: ['git status'] } },
    worker: { enabled: false, autonomy: false },
    memory: { userMaxChars: 1500, notesMaxChars: 2500 },
    profile: { name: 'Clive', shape: 'orb', color: '#C9A227', motion: 'auto' },
  };
}

test('設定の節: 9 つ・4 グループで、名前と説明が ja にも en にもある', () => {
  assert.equal(SECTION_GROUPS.length, 4);
  assert.deepEqual([...SECTION_IDS], ['models', 'providers', 'keys', 'tools', 'worker', 'memory', 'look', 'server', 'file']);
  assert.equal(new Set(SECTION_IDS).size, SECTION_IDS.length);
  for (const group of SECTION_GROUPS) {
    for (const key of [group.label, ...group.items.flatMap(i => [i.label, i.desc])]) {
      assert.ok(ja[key].length > 0 && en[key].length > 0, key);
      if (key !== 'settings.group.clive') assert.notEqual(en[key], ja[key], `${key}: 訳し忘れ`);
    }
  }
  assert.equal(isSection('tools'), true);
  assert.equal(isSection('nope'), false);
  assert.equal(isSection(null), false);
});

const SAME_IN_BOTH = new Set(['settings.group.clive', 'settings.models.fieldId']);

test('辞書: 設定の画面の文字は ja と en の両方にあり、en は ja の写しではない', () => {
  const keys = Object.keys(ja).filter(k => /^(settings|probe|langPrompt)\./u.test(k));
  assert.ok(keys.length >= 200, `${keys.length} 件しか読めていない`);
  for (const key of keys) {
    const jaEntry = (ja as Record<string, unknown>)[key];
    const enEntry = (en as Record<string, unknown>)[key];
    assert.equal(typeof enEntry, typeof jaEntry, key);
    if (typeof jaEntry === 'string' && !SAME_IN_BOTH.has(key)) assert.notEqual(enEntry, jaEntry, `${key}: 訳し忘れ`);
  }
  for (const status of ['ok', 'too_small', 'exceeds_model', 'unknown', 'unreachable', 'no_api_key', 'not_found', 'error', 'unchecked']) {
    assert.ok(`probe.status.${status}` in ja, status);
  }
  assert.equal(Object.keys(ja).includes('settings.language.hint'), false, '仮の注意書きは外した');
});

test('変更の数: 何も変えていなければ 0、項目ごとに 1 件', () => {
  const saved = sample();
  assert.equal(countChanges(saved, structuredClone(saved)), 0);
  const one = structuredClone(saved);
  one.memory.userMaxChars = 2000;
  assert.equal(countChanges(saved, one), 1);
  const two = structuredClone(one);
  two.profile.color = '#112233';
  assert.equal(countChanges(saved, two), 2);
});

test('変更の数: 並び（文字列の一覧）は 1 件、models / providers は id で突き合わせる', () => {
  const saved = sample();
  const reordered = structuredClone(saved);
  reordered.routing.chat = ['sonnet', 'big'];
  assert.equal(countChanges(saved, reordered), 1, '順番を替えただけなら 1 件');

  const edited = structuredClone(saved);
  edited.models[0].contextLength = 65536;
  edited.models[0].vision = true;
  assert.equal(countChanges(saved, edited), 2);

  const added = addModel(saved).config;
  assert.equal(countChanges(saved, added), 1, '追加は 1 件');
  assert.equal(countChanges(saved, removeModel(saved, 'sonnet')), 2, '削除は 1 件 + 順番から外れた分（チャットの順番）で 1 件');

  const swapped = structuredClone(saved);
  swapped.models.reverse();
  assert.equal(countChanges(saved, swapped), 0, 'models の並びは id で見るので、並べ替えだけは変更に数えない');
});

test('変更の数: language を足す・消すも 1 件で、「見た目」の節の変更になる', () => {
  const saved = sample();
  const draft = configWithLanguage(saved, 'en');
  assert.equal(countChanges(saved, draft), 1);
  assert.equal(sectionChanged(saved, draft, 'look'), true);
  assert.equal(sectionChanged(saved, draft, 'models'), false);
  assert.equal(countChanges(draft, configWithLanguage(draft, 'auto')), 1);
});

test('節の変更の印: 触った節だけに付く', () => {
  const saved = sample();
  const draft = updateAt(saved, 'worker', { enabled: true });
  const marks = SECTION_IDS.filter(id => sectionChanged(saved, draft, id));
  assert.deepEqual(marks, ['worker']);
  const route = moveInRoute(saved, 'chat', 0, 1);
  assert.deepEqual(SECTION_IDS.filter(id => sectionChanged(saved, route, id)), ['models']);
  const key = updateListItem(saved, 'providers', 'local', { apiKeyEnv: 'OTHER' });
  assert.deepEqual(SECTION_IDS.filter(id => sectionChanged(saved, key, id)), ['providers'], '鍵の節は設定に持ち物を持たないので、変更の印は付かない');
});

test('問題の読み取り: 形の検査の /models/0/contextLength は、位置を id に置き換えて節と行を指す', () => {
  const config = sample();
  const problem = parseProblem('/models/0/contextLength: Expected number to be greater or equal to 1024', config);
  assert.equal(problem.path, 'models.big.contextLength');
  assert.equal(problem.section, 'models');
  assert.equal(problem.modelId, 'big');
  assert.equal(problem.message, 'Expected number to be greater or equal to 1024');
  const provider = parseProblem('/providers/1/timeoutMs: Expected integer', config);
  assert.equal(provider.path, 'providers.claude.timeoutMs');
  assert.equal(provider.section, 'providers');
  assert.equal(provider.providerId, 'claude');
});

test('問題の読み取り: 内容の検査（models.<id>: …・routing.chat: …）と、読めないもの', () => {
  const config = sample();
  assert.deepEqual(
    { ...parseProblem('models.big: contextLength is below minContext: it can never be used', config) },
    { text: 'models.big: contextLength is below minContext: it can never be used', path: 'models.big', message: 'contextLength is below minContext: it can never be used', section: 'models', modelId: 'big' },
  );
  const route = parseProblem('routing.chat: model "ghost" is not defined', config);
  assert.equal(route.section, 'models');
  assert.equal(route.modelId, undefined);
  const url = parseProblem('providers.local.baseUrl: must be http(s)', config);
  assert.equal(url.section, 'providers');
  assert.equal(url.providerId, 'local');
  assert.equal(parseProblem('server.origins: no trailing slash', config).section, 'server');
  assert.equal(parseProblem('/profile/color: Expected string to match pattern', config).section, 'look');
  assert.equal(parseProblem('/tools/shell/timeoutSec: Expected number', config).path, 'tools.shell.timeoutSec');
  assert.equal(parseProblem('/worker/maxRunsPerHour: x', config).section, 'worker');
  assert.equal(parseProblem('/memory/userMaxChars: x', config).section, 'memory');
  assert.equal(parseProblem('/language: Expected union value', config).section, 'look');
  const odd = parseProblem('the file could not be written', config);
  assert.equal(odd.section, null);
  assert.equal(odd.path, '');
  assert.equal(odd.message, 'the file could not be written');
  assert.equal(parseProblem('/models/9/id: x', config).path, 'models.9.id', '範囲外の位置は、そのまま残す');
});

test('設定の書き換え: 元の設定は変えず、空欄（undefined）のキーは外す', () => {
  const config = sample();
  const frozen = structuredClone(config);
  const next = updateListItem(config, 'models', 'big', { contextLength: undefined, label: 'Big' });
  assert.deepEqual(config, frozen);
  assert.equal('contextLength' in next.models[0], false);
  assert.equal(next.models[0].label, 'Big');
  assert.equal(next.models[1], config.models[1], '触っていない項目は同じもの');
  assert.deepEqual(pruned({ a: 1, b: undefined }), { a: 1 });
  assert.deepEqual(updateAt(config, 'worker', { enabled: true }).worker, { enabled: true, autonomy: false });
  assert.deepEqual(updateIn(config, 'tools', 'shell', { enabled: false }).tools.shell, { enabled: false, allow: ['git status'] });
  assert.deepEqual(updateIn({}, 'tools', 'shell', { enabled: true }).tools, { shell: { enabled: true } });
});

test('モデル・プロバイダの追加と削除', () => {
  const config = sample();
  assert.equal(uniqueId('x', []), 'x');
  assert.equal(uniqueId('x', ['x', 'x-2']), 'x-3');
  const first = addModel(config);
  const second = addModel(first.config);
  assert.deepEqual([first.id, second.id], ['new-model', 'new-model-2']);
  assert.equal(first.config.models.at(-1).provider, 'local', '最初のプロバイダを使う');
  const providerFirst = addProvider(config);
  assert.equal(providerFirst.id, 'new-provider');
  assert.equal(addProvider(providerFirst.config).id, 'new-provider-2');

  const without = removeModel(config, 'big');
  assert.deepEqual(without.models.map((m: { id: string }) => m.id), ['sonnet']);
  assert.deepEqual(without.routing, { chat: ['sonnet'], background: [], retriesPerModel: 1 });

  assert.equal(providerInUse(config, 'local'), true);
  assert.equal(providerInUse(providerFirst.config, 'new-provider'), false);
  assert.deepEqual(removeProvider(providerFirst.config, 'new-provider').providers.map((p: { id: string }) => p.id), ['local', 'claude']);
});

test('順番（チャット・裏方）: 入れ替え・足す・外す', () => {
  const config = sample();
  assert.deepEqual(moveInRoute(config, 'chat', 0, 1).routing.chat, ['sonnet', 'big']);
  assert.deepEqual(moveInRoute(config, 'chat', 1, -1).routing.chat, ['sonnet', 'big']);
  assert.equal(moveInRoute(config, 'chat', 0, -1), config, '先頭を上へは何も起きない');
  assert.equal(moveInRoute(config, 'chat', 1, 1), config, '末尾を下へは何も起きない');
  assert.equal(moveInRoute(config, 'chat', 5, -1), config);
  assert.deepEqual(addToRoute(config, 'background', 'sonnet').routing.background, ['big', 'sonnet']);
  assert.equal(addToRoute(config, 'background', 'big'), config, '重複は足さない');
  assert.deepEqual(removeFromRoute(config, 'chat', 'big').routing.chat, ['sonnet']);
  assert.deepEqual(config.routing.chat, ['big', 'sonnet'], '元は変わらない');
});

test('数の欄と、タグの欄', () => {
  assert.equal(parseNumber(''), undefined);
  assert.equal(parseNumber('   '), undefined);
  assert.equal(parseNumber(' 12 '), 12);
  assert.equal(parseNumber('-3.5'), -3.5);
  assert.equal(parseNumber('1e3'), 1000);
  assert.equal(parseNumber('abc'), null);
  assert.equal(parseNumber('Infinity'), null);
  assert.deepEqual(addTag(['a'], ' b '), ['a', 'b']);
  assert.deepEqual(addTag(['a'], 'a'), ['a']);
  assert.deepEqual(addTag(['a'], '   '), ['a']);
  assert.equal(secondsOf(600000), 600);
  assert.equal(secondsOf(1500), 2);
  assert.equal(secondsOf(undefined), undefined);
});

test('API キーの環境変数: プロバイダの apiKeyEnv と、Anthropic の既定、重複のまとめ', () => {
  assert.deepEqual(keyUsage(sample()), [
    { name: 'LOCAL_KEY', providers: ['local'] },
    { name: 'ANTHROPIC_API_KEY', providers: ['claude'] },
  ]);
  const shared = { providers: [
    { id: 'a', kind: 'openai_compatible', apiKeyEnv: 'K' }, { id: 'b', kind: 'openai_compatible', apiKeyEnv: 'K' }, { id: 'c', kind: 'ollama' },
    { id: 'd', kind: 'anthropic', apiKeyEnv: 'MINE' },
  ] };
  assert.deepEqual(keyUsage(shared), [{ name: 'K', providers: ['a', 'b'] }, { name: 'MINE', providers: ['d'] }]);
  assert.equal(isEnvName('OPENAI_API_KEY'), true);
  for (const bad of ['', 'lower', '1ABC', 'A-B', 'A B', 'A'.repeat(65)]) assert.equal(isEnvName(bad), false, bad);
});

test('ID の付け替え: 順番とモデルのプロバイダも合わせる', () => {
  const config = sample();
  const model = renameModel(config, 'big', 'large');
  assert.deepEqual(model.models.map((m: { id: string }) => m.id), ['large', 'sonnet']);
  assert.deepEqual(model.routing.chat, ['large', 'sonnet']);
  assert.deepEqual(model.routing.background, ['large']);
  assert.equal(renameModel(config, 'big', ''), config);
  assert.equal(renameModel(config, 'big', 'big'), config);
  const provider = renameProvider(config, 'local', 'lm');
  assert.deepEqual(provider.providers.map((p: { id: string }) => p.id), ['lm', 'claude']);
  assert.equal(provider.models[0].provider, 'lm');
  assert.equal(provider.models[1].provider, 'claude');
  assert.equal(renameProvider(config, 'local', ''), config);
});

test('行の印: 問題の文と、変更の有無', () => {
  const config = sample();
  const problems = [parseProblem('/models/0/contextLength: too small', config)];
  assert.equal(errorFor(problems, 'models.big.contextLength'), 'too small');
  assert.equal(errorFor(problems, 'models.big.label'), undefined);
  const draft = updateListItem(config, 'models', 'big', { contextLength: 100000 });
  assert.equal(differs(config, draft, c => c.models[0].contextLength), true);
  assert.equal(differs(config, draft, c => c.models[0].model), false);
  assert.equal(differs(config, draft, c => c.nothing.here), false, '読めない場所は変更なし');
  assert.equal(differs(config, config, c => undefined), false);
});

test('Clive も英語にするかの質問: 設定に language が無く、画面が日本語以外で、まだ答えていないときだけ', () => {
  const ask = (serverLanguage: 'auto' | 'ja' | 'en', screenLanguage: 'ja' | 'en', answered: boolean, loaded = true) => shouldAskLanguage({ serverLanguage, screenLanguage, answered, loaded });
  assert.equal(ask('auto', 'en', false), true);
  assert.equal(ask('auto', 'en', false, false), false, '設定をまだ読めていないあいだは聞かない（「いいえ」を誤って覚えさせない）');
  assert.equal(ask('auto', 'ja', false), false, '画面が日本語なら聞かない');
  assert.equal(ask('auto', 'en', true), false, '答えたら二度と聞かない');
  assert.equal(ask('en', 'en', false), false, '設定で決まっていれば聞かない');
  assert.equal(ask('ja', 'en', false), false);
});

test('質問の答えの保存: yes / no だけを覚え、保存できない環境でも落ちない', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assert.equal(loadPromptAnswer(storage), null);
  savePromptAnswer('no', storage);
  assert.equal(loadPromptAnswer(storage), 'no');
  savePromptAnswer('yes', storage);
  assert.equal(loadPromptAnswer(storage), 'yes');
  store.set('clive.languagePrompt', 'maybe');
  assert.equal(loadPromptAnswer(storage), null);
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(loadPromptAnswer(blocked), null);
  assert.doesNotThrow(() => savePromptAnswer('yes', blocked));
});

test('言語の設定への書き込み: auto は language を消し、元の設定は変えない', () => {
  const config = { timezone: 'Asia/Tokyo', language: 'en' };
  assert.deepEqual(configWithLanguage(config, 'auto'), { timezone: 'Asia/Tokyo' });
  assert.deepEqual(configWithLanguage(config, 'ja'), { timezone: 'Asia/Tokyo', language: 'ja' });
  assert.deepEqual(configWithLanguage({ timezone: 'x' }, 'en'), { timezone: 'x', language: 'en' });
  assert.deepEqual(config, { timezone: 'Asia/Tokyo', language: 'en' });
});

test('設定を開いたまま言語が保存されたとき: 保存済みと、触っていない編集中の language を合わせ、自分の編集は残す', () => {
  const saved = { timezone: 'x' };
  assert.equal(withAdoptedLanguage(saved, 'auto'), saved, 'language が無い = auto なら同じもの');
  assert.equal(withAdoptedLanguage({ language: 'en' }, 'en').language, 'en');
  const same = { language: 'en' };
  assert.equal(withAdoptedLanguage(same, 'en'), same);
  assert.deepEqual(withAdoptedLanguage(saved, 'en'), { timezone: 'x', language: 'en' });
  assert.deepEqual(withAdoptedLanguage({ timezone: 'x', language: 'en' }, 'auto'), { timezone: 'x' });
  assert.deepEqual(saved, { timezone: 'x' }, '元は変わらない');
  const untouched = { timezone: 'x', memory: { userMaxChars: 1 } };
  assert.deepEqual(adoptLanguageInDraft(untouched, undefined, 'en'), { timezone: 'x', memory: { userMaxChars: 1 }, language: 'en' }, '触っていなければ合わせる（ほかの編集は残る）');
  const edited = { timezone: 'x', language: 'ja' };
  assert.equal(adoptLanguageInDraft(edited, undefined, 'en'), edited, '自分で language を変えていれば、その編集を残す');
  assert.deepEqual(adoptLanguageInDraft({ language: 'ja' }, 'ja', 'en'), { language: 'en' });
});

test('コピー: clipboard が使えればそれで、使えない・断られたときは選択してコピーに切り替え、できたかどうかを返す', async () => {
  const written: string[] = [];
  const fallback: string[] = [];
  const selectionCopy = (text: string) => { fallback.push(text); return true; };
  assert.equal(await copyText('a', { clipboard: { writeText: async (v: string) => { written.push(v); } }, selectionCopy }), true);
  assert.deepEqual([written, fallback], [['a'], []], 'clipboard が使えれば切り替えない');
  assert.equal(await copyText('b', { clipboard: { writeText: async () => { throw new Error('denied'); } }, selectionCopy }), true);
  assert.deepEqual(fallback, ['b'], '断られたら切り替える');
  assert.equal(await copyText('c', { clipboard: undefined, selectionCopy }), true);
  assert.deepEqual(fallback, ['b', 'c'], 'http の画面など clipboard が無いときも切り替える');
  assert.equal(await copyText('d', { clipboard: undefined, selectionCopy: () => false }), false, 'どちらもできなければ false（コピーしたと言わない）');
  assert.equal(await copyText('e', { clipboard: { writeText: async () => { throw new Error('denied'); } }, selectionCopy: () => false }), false);
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; setLanguagePreference('auto'); });

test('saveLanguage: 設定を読み直して language だけを変えて PUT し、画面に反映する', async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    const body = (init.method ?? 'GET') === 'GET' ? { config: { timezone: 'Asia/Tokyo', server: { port: 4780 } } } : { config: {} };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  await saveLanguage('en');
  assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), ['GET /api/settings', 'PUT /api/settings']);
  assert.deepEqual(calls[1]!.body, { config: { timezone: 'Asia/Tokyo', server: { port: 4780 }, language: 'en' } });
  assert.equal(getLanguagePreference(), 'en');

  calls.length = 0;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    const body = (init.method ?? 'GET') === 'GET' ? { config: { timezone: 'Asia/Tokyo', language: 'en' } } : { config: {} };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  await saveLanguage('auto');
  assert.deepEqual(calls[1]!.body, { config: { timezone: 'Asia/Tokyo' } }, 'auto は language を送らない');
  assert.equal(getLanguagePreference(), 'auto');
});

test('saveLanguage: 保存に失敗したら画面の言語は変えない', async () => {
  setLanguagePreference('ja');
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    if ((init.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ config: {} }), { status: 200 });
    return new Response(JSON.stringify({ error: 'invalid_config', problems: ['/language: bad'] }), { status: 400 });
  }) as typeof fetch;
  await assert.rejects(saveLanguage('en'));
  assert.equal(getLanguagePreference(), 'ja');
});

test('closeAction: 設定のモーダルを閉じるとき、保存していない変更があれば確かめ、保存している最中は待つ', () => {
  assert.equal(closeAction({ dirty: 0, busy: false }), 'close', '変更が無ければそのまま閉じる');
  assert.equal(closeAction({ dirty: 3, busy: false }), 'confirm', '変更があれば、捨てる前に確かめる');
  assert.equal(closeAction({ dirty: 0, busy: true }), 'wait', '保存している最中は閉じない');
  assert.equal(closeAction({ dirty: 2, busy: true }), 'wait');
});

test('設定のモーダルの辞書: 閉じる確かめの文は ja にも en にもあり、件数が入る', () => {
  assert.match(ja['settings.discard.body'](3), /3/u);
  assert.match(en['settings.discard.body'](1), /1 unsaved change /u);
  assert.match(en['settings.discard.body'](2), /2 unsaved changes /u);
  for (const key of ['settings.close', 'settings.discard.title', 'settings.discard.keep', 'settings.discard.do'] as const) {
    assert.ok(ja[key] && en[key], key);
    assert.notEqual(ja[key], en[key], `${key} は訳してある`);
  }
});

test('editsToKeep: 保存していない編集があるときだけ、残すものを返す', () => {
  const saved = sample();
  const draft = { ...sample(), timezone: 'UTC' };
  assert.equal(editsToKeep(saved, sample()), null, '変更が無ければ残さない');
  assert.equal(editsToKeep(null, draft), null, 'まだ読み込めていないときは残さない');
  assert.equal(editsToKeep(saved, null), null);
  assert.deepEqual(editsToKeep(saved, draft), { saved, draft });
});

test('restoreKept: 残していた編集を最新の設定へ当て直し、ほかの場所が先に変えた別の値は最新のまま見せる', () => {
  const saved = sample();
  const draft = { ...sample(), timezone: 'UTC' };
  const kept = { saved, draft };
  const latest = { ...sample(), worker: { enabled: true, autonomy: false } };
  const restored = restoreKept(kept, latest);
  assert.equal(restored.restored, true);
  assert.equal(restored.draft.timezone, 'UTC', '自分の編集は戻る');
  assert.equal((restored.draft.worker as { enabled: boolean }).enabled, true, 'ほかの場所が変えた値は最新のまま');
  assert.equal(restored.saved, latest, '比べる元は最新の設定');
  assert.equal(countChanges(restored.saved, restored.draft), 1, '保存していない変更は自分の 1 件だけ');
});

test('restoreKept: 同じ値をほかの場所も先に変えていたら編集は残さず、ぶつかるときは残していた画面のまま返して保存の合流に衝突を知らせさせる', () => {
  const saved = sample();
  const kept = { saved, draft: { ...sample(), timezone: 'UTC' } };
  const same = restoreKept(kept, { ...sample(), timezone: 'UTC' });
  assert.equal(same.restored, false, '最新がすでに同じ値なら、残す編集は無い');
  assert.equal(countChanges(same.saved, same.draft), 0);
  const conflicting = restoreKept(kept, { ...sample(), timezone: 'Europe/London' });
  assert.equal(conflicting.restored, true);
  assert.equal(conflicting.saved, saved, '衝突のときは元の比べる元を残す');
  assert.equal(conflicting.draft, kept.draft);
  assert.equal(diffConfig(conflicting.saved, conflicting.draft).length, 1);
  assert.equal(applyEdits({ ...sample(), timezone: 'Europe/London' }, diffConfig(conflicting.saved, conflicting.draft)).conflicts.length, 1, '保存すれば衝突として知らされる');
  const latest = sample();
  const none = restoreKept(null, latest);
  assert.deepEqual({ restored: none.restored, same: none.draft === latest && none.saved === latest }, { restored: false, same: true });
  assert.equal(restoreKept({ saved, draft: sample() }, latest).restored, false, '変更の無い残りは使わない');
});

test('設定を残した旨の辞書: ja にも en にもある', () => {
  assert.ok(ja['settings.kept'].length > 0 && en['settings.kept'].length > 0);
  assert.notEqual(ja['settings.kept'], en['settings.kept']);
});
