import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateTextTokens } from '../src/engine/tokens.ts';
import { en } from '../web/src/i18n/en.ts';
import { ja } from '../web/src/i18n/ja.ts';
import {
  emptyModelForm, isOutsideUrl, markSetupShown, modelFormProblem, personaInputOf, resumeStep, setupModelConfig, STEPS, STYLE_CHOICES, wasSetupShown,
  type ModelForm, type PersonaFields,
} from '../web/src/onboarding.ts';
import { estimateTokens, overPersonaBudget } from '../web/src/tokens.ts';
import { sectionChanged } from '../web/src/settings/model.ts';

const steps = (patch: Partial<Record<'language' | 'user' | 'identity' | 'persona' | 'model', boolean>> = {}) => ({ language: false, user: false, identity: false, persona: false, model: false, ...patch });

test('resumeStep: 左の一覧の「続ける」は、済んでいない最初の手順から始める。全部済んでいればあいさつ', () => {
  assert.deepEqual(STEPS, ['language', 'you', 'identity', 'style', 'model', 'greeting']);
  assert.equal(resumeStep(steps()), 'language');
  assert.equal(resumeStep(steps({ language: true })), 'you');
  assert.equal(resumeStep(steps({ language: true, user: true })), 'identity');
  assert.equal(resumeStep(steps({ language: true, user: true, identity: true })), 'style');
  assert.equal(resumeStep(steps({ language: true, user: true, identity: true, persona: true })), 'model');
  assert.equal(resumeStep(steps({ language: true, user: true, identity: true, persona: true, model: true })), 'greeting');
  assert.equal(resumeStep(steps({ model: true })), 'language', '飛ばした手順があれば、そこへ戻る');
});

test('personaInputOf: サーバーへ送るのは、入力のあった項目だけ（送った項目だけが書かれ、済みになる）。話し方は「決めない」でも書き足しがあれば送る', () => {
  const fields: PersonaFields = { userName: ' やまだ ', callMe: '', botName: ' ミナト ', style: 'friendly', styleNote: '  ' };
  assert.deepEqual(personaInputOf(fields, 'you'), { userName: 'やまだ' });
  assert.deepEqual(personaInputOf({ ...fields, userName: '', callMe: '' }, 'you'), {}, '空なら何も送らない');
  assert.deepEqual(personaInputOf(fields, 'identity'), { botName: 'ミナト' });
  assert.deepEqual(personaInputOf({ ...fields, botName: '  ' }, 'identity'), {});
  assert.deepEqual(personaInputOf(fields, 'style'), { style: 'friendly' });
  assert.deepEqual(personaInputOf({ ...fields, style: 'none', styleNote: '' }, 'style'), {}, '決めないで、書き足しも無ければ送らない');
  assert.deepEqual(personaInputOf({ ...fields, style: 'none', styleNote: '絵文字なし' }, 'style'), { style: 'none', styleNote: '絵文字なし' });
  assert.deepEqual(personaInputOf({ ...fields, style: null, styleNote: '短く' }, 'style'), { styleNote: '短く' });
  assert.deepEqual([...STYLE_CHOICES], ['calm', 'friendly', 'direct', 'none']);
});

const form = (patch: Partial<ModelForm> = {}): ModelForm => ({ ...emptyModelForm('openai'), model: 'qwen3-27b', baseUrl: 'http://127.0.0.1:1234/v1', ...patch });

test('modelFormProblem / isOutsideUrl: 入力の誤りを入れる前に見つけ、この PC の外の送り先には知らせる', () => {
  assert.equal(modelFormProblem(form()), null);
  assert.equal(modelFormProblem(form({ model: '  ' })), 'model');
  assert.equal(modelFormProblem(form({ baseUrl: 'localhost:1234' })), 'baseUrl');
  assert.equal(modelFormProblem(form({ contextLength: '100' })), 'contextLength');
  assert.equal(modelFormProblem(form({ contextLength: '' })), null, 'コンテキスト長は空でもよい（サーバーから確かめる）');
  assert.equal(modelFormProblem(form({ apiKeyEnv: 'my key' })), 'apiKeyEnv');
  assert.equal(modelFormProblem(form({ apiKeyEnv: 'MY_API_KEY' })), null);
  assert.equal(modelFormProblem({ ...emptyModelForm('anthropic'), model: 'claude-x' }), null, 'Anthropic はモデル名だけ');
  assert.equal(modelFormProblem({ ...emptyModelForm('ollama'), model: '' }), 'model');
  assert.equal(isOutsideUrl('http://127.0.0.1:8000/v1'), false);
  assert.equal(isOutsideUrl('http://localhost:8000'), false);
  assert.equal(isOutsideUrl('http://[::1]:8000'), false);
  assert.equal(isOutsideUrl('https://api.example.com/v1'), true);
  assert.equal(isOutsideUrl('http://192.168.1.5:8000/v1'), true);
  assert.equal(isOutsideUrl('not a url'), false);
});

const base = () => ({
  providers: [{ id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600000 }, { id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', maxParallel: 1, timeoutMs: 600000 }],
  models: [] as Array<Record<string, unknown>>,
  routing: { chat: [] as string[], background: [] as string[], retriesPerModel: 2 },
});

test('setupModelConfig（OpenAI 互換）: 送り先・サーバーの種類・鍵の環境変数名・コンテキスト長で、プロバイダとモデルを足し、順番が空ならチャットにも裏方にも入れる', () => {
  const { config, modelId } = setupModelConfig(base(), form({ server: 'tabbyapi', apiKeyEnv: 'LOCAL_KEY', contextLength: '65536' }), null);
  assert.equal(modelId, 'qwen3-27b');
  assert.deepEqual(config.providers.at(-1), { id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1234/v1', server: 'tabbyapi', maxParallel: 1, timeoutMs: 600000, apiKeyEnv: 'LOCAL_KEY' });
  assert.deepEqual(config.models, [{ id: 'qwen3-27b', label: '', provider: 'local', model: 'qwen3-27b', contextLength: 65536, minContext: 8192, maxOutputTokens: 4096, toolMode: 'native', vision: false }]);
  assert.deepEqual(config.routing, { chat: ['qwen3-27b'], background: ['qwen3-27b'], retriesPerModel: 2 });
  assert.equal(config.providers.length, 3, '最初から入っているプロバイダは残す');
  const noKey = setupModelConfig(base(), form(), null).config;
  assert.equal('apiKeyEnv' in noKey.providers.at(-1), false, '鍵を使わないときは apiKeyEnv を書かない');
});

test('setupModelConfig: Anthropic と Ollama は、すでにあるプロバイダを使い（無ければ決まった形で足し）、同じモデルをもう一度確かめるときは項目を直す', () => {
  const anthropic = setupModelConfig(base(), { ...emptyModelForm('anthropic'), model: 'claude-sonnet-x' }, null);
  assert.equal(anthropic.config.models[0].provider, 'anthropic');
  assert.equal('contextLength' in anthropic.config.models[0], false, 'Anthropic は長さを書かない');
  assert.equal(anthropic.config.providers.length, 2, '足さずに、あるものを使う');
  const ollama = setupModelConfig({ ...base(), providers: [] }, { ...emptyModelForm('ollama'), model: 'llama3' }, null);
  assert.deepEqual(ollama.config.providers, [{ id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', maxParallel: 1, timeoutMs: 600000 }]);

  const first = setupModelConfig(base(), form({ contextLength: '32768' }), null);
  const again = setupModelConfig(first.config, form({ baseUrl: 'http://127.0.0.1:5000/v1', model: 'qwen3-27b', contextLength: '16384' }), first.modelId);
  assert.equal(again.config.models.length, 1, '同じモデルは重ねない');
  assert.equal(again.config.providers.filter((p: { id: string }) => p.id === 'local').length, 1, '自分の足したプロバイダも重ねない');
  assert.equal(again.config.providers.find((p: { id: string }) => p.id === 'local').baseUrl, 'http://127.0.0.1:5000/v1');
  assert.equal(again.config.models[0].contextLength, 16384);
  assert.deepEqual(again.config.routing.chat, ['qwen3-27b'], '順番にも重ねない');

  const second = setupModelConfig(first.config, form({ model: 'Another Model!' }), null);
  assert.equal(second.modelId, 'another-model', 'モデル名から、使える文字の id を作る');
  assert.deepEqual(second.config.routing, { chat: ['qwen3-27b', 'another-model'], background: ['qwen3-27b', 'another-model'], retriesPerModel: 2 }, '順番がすでにあるときは、足したモデルを最後に足す');
  assert.equal(setupModelConfig(first.config, form(), null).modelId, 'qwen3-27b-2', '同じ id があれば番号を付ける');
  assert.equal(base().models.length, 0, '元の設定は書き換えない');
});

test('estimateTokens: 画面の見積もりは、サーバーの estimateTextTokens と同じ式。予算を超えたときだけ注意する（予算なしなら出さない）', () => {
  for (const text of ['', 'hello world', '落ち着いて簡潔に話す。', 'Mixed 日本語 and English, 한국어 too, ＡＢＣ', 'x'.repeat(1000), '名'.repeat(500)]) {
    assert.equal(estimateTokens(text), estimateTextTokens(text), JSON.stringify(text.slice(0, 20)));
  }
  assert.equal(overPersonaBudget(1000, 500), true);
  assert.equal(overPersonaBudget(500, 500), false, '予算ちょうどは超えていない');
  assert.equal(overPersonaBudget(100000, null), false, 'モデルが無い（予算なし）なら注意しない');
});

test('はじめの設定の記録: 自動で開くのは 1 回だけ。保存できない環境でも落ちない', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assert.equal(wasSetupShown(storage), false);
  markSetupShown(storage);
  assert.equal(wasSetupShown(storage), true);
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(wasSetupShown(blocked), false);
  markSetupShown(blocked);
});

test('設定の「Clive について」: 節にあり、ja にも en にも文がある。画面の設定の変更としては数えない（名前と全文は別に保存する）', () => {
  for (const key of ['settings.section.about', 'settings.desc.about', 'settings.about.name', 'settings.about.rerun', 'onboarding.title', 'onboarding.band', 'onboarding.greeting.request', 'chat.send.setupModel'] as const) {
    assert.ok(ja[key].length > 0 && en[key].length > 0, key);
    assert.notEqual(ja[key], en[key], `${key}: 訳し忘れ`);
  }
  assert.equal(sectionChanged({ profile: { name: 'a' } }, { profile: { name: 'b' } }, 'about'), false);
  assert.match(ja['settings.about.warn'](5000, 4000), /5000/u);
  assert.match(en['onboarding.model.have'](1), /1 model/u);
  assert.match(en['onboarding.model.have'](3), /3 models/u);
});
