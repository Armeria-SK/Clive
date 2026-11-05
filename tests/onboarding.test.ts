import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { Language } from '../src/config/schema.ts';
import { isInitialPersona, personaTexts, PERSONA_MAX_CHARS, STYLES, styleText, writePersonaFile, PersonaError } from '../src/engine/persona.ts';
import { readTemplate } from '../src/engine/workspace.ts';
import { reloadEnvFile, resolvePaths } from '../src/paths.ts';
import { createWebServer } from '../src/web/server.ts';
import { FakeAdapter, tempDir, testConfig } from './helpers.ts';

const TEMPLATE_PATHS = resolvePaths('unused-data-dir');
// 作業フォルダの初期ファイルは、チェックアウトの設定によって改行が CRLF のことがある。比べる試験は LF にそろえて読む（改行を保つことは別の試験で確かめる）
const lf = (text: string): string => text.replace(/\r\n/gu, '\n');
const template = (name: 'SOUL.md' | 'USER.md', language: Language): string => lf(readTemplate(TEMPLATE_PATHS, name, language));

async function start(t: Parameters<typeof tempDir>[0], language?: Language, models = true) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  if (language) config.language = language;
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FAKE_KEY', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = models ? [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }] : [];
  config.routing = { chat: models ? ['m'] : [], background: [], retriesPerModel: 0 };
  writeFileSync(paths.config, JSON.stringify(config));
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined,
    adapterOverride: provider => new FakeAdapter(provider),
  });
  await app.status.probeAll(app.config());
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); app.close(); });
  const api = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, { ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Origin: origin, ...init.headers } });
  const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const file = (name: 'SOUL.md' | 'USER.md') => lf(readFileSync(join(paths.workspace, name), 'utf8'));
  return { app, paths, origin, api, post, file };
}

// ── 節の書き換え（画面を使わない部分） ──

test('personaTexts（日本語）: 名前・呼び方・話し方の節だけを書き換え、ほかの節と持ち主の行は残す', () => {
  const soul = template('SOUL.md', 'ja');
  const user = `${template('USER.md', 'ja')}\n`.replace('- 主な使用言語: 日本語', '- 主な使用言語: 日本語\n- 勤務先: 自宅');
  const next = personaTexts(soul, user, 'ja', { userName: 'やまだ', callMe: 'やまださん', botName: 'ミナト', style: 'friendly', styleNote: '絵文字は使わない' });
  assert.match(next.soul, /## 名前\n\nミナト\n\n## ユーザーとの関係/u);
  assert.match(next.soul, /## 話し方\n\n親しみやすく丁寧に話す。[^\n]+\n\n絵文字は使わない\n\n## 大事にしていること/u);
  assert.match(next.user, /## 基本情報\n\n- 名前: やまだ\n- 呼び方: やまださん\n- 主な使用言語: 日本語\n- 勤務先: 自宅\n\n## 関心/u);
  assert.equal(next.soul.split('## ').length, soul.split('## ').length, '節の数は変わらない');
  const restored = next.soul.replace('## 名前\n\nミナト\n', '## 名前\n\nClive\n').replace(/## 話し方\n\n[\s\S]*?\n\n## 大事にしていること/u, '## 話し方\n\n\n## 大事にしていること');
  assert.equal(restored, soul, '名前と話し方の節のほかは 1 文字も変わらない');
  const again = personaTexts(next.soul, next.user, 'ja', { userName: 'やまだ', callMe: 'やまださん', botName: 'ミナト', style: 'friendly', styleNote: '絵文字は使わない' });
  assert.deepEqual(again, next, '同じ値でもう一度書いても同じ（重ならない）');
});

test('personaTexts（見出しは日本語・英語の両方を探す）: 今の言語の見出しを先に探し、なければもう一方の言語の見出しの節を直し、どちらも無いときだけ最後に足す', () => {
  const englishFiles = { soul: template('SOUL.md', 'en'), user: template('USER.md', 'en') };
  const fromJa = personaTexts(englishFiles.soul, englishFiles.user, 'ja', { botName: 'Mina', userName: 'Taro', style: 'direct' });
  assert.match(fromJa.soul, /## Name\n\nMina\n\n## Relationship/u, '言語を ja に切り替えたあとでも、英語の見出しの節を直す');
  assert.doesNotMatch(fromJa.soul, /## 名前/u, '日本語の見出しを足さない');
  assert.match(fromJa.soul, /## Way of speaking\n\n率直に、短く話す。/u, '本文は今の言語（ja）で書く');
  assert.match(fromJa.user, /## Basic information\n\n- 名前: Taro\n- Main language: English/u, '英語の見出しの節の「- Name:」の行を、今の言語の書き方で直す');
  assert.equal(fromJa.user.split('## Basic information').length, 2, '基本情報の節は 1 つのまま');

  const neither = personaTexts('# SOUL\n\n## 自由な見出し\n\n中身\n', '# USER\n', 'en', { botName: 'Mina', style: 'calm', userName: 'Taro' });
  assert.match(neither.soul, /## 自由な見出し\n\n中身\n\n## Name\n\nMina\n\n## Way of speaking\n\nSpeak calmly and concisely\./u, 'どちらの言語の見出しも無ければ、最後に今の言語の見出しで足し、ほかの節は触らない');
  assert.match(neither.user, /## Basic information\n\n- Name: Taro\n- Main language: English\n$/u);
  const ja = personaTexts('', '', 'ja', { userName: 'やまだ' });
  assert.match(ja.user, /## 基本情報\n\n- 名前: やまだ\n- 主な使用言語: 日本語\n$/u, '空のファイルにも基本情報を作る');
});

test('personaTexts: 改行（CRLF）をそろえて保ち、自由な文の # で始まる行は見出しにならない', () => {
  const crlf = template('SOUL.md', 'ja').replace(/\n/gu, '\r\n');
  const next = personaTexts(crlf, '', 'ja', { botName: 'ミナト', style: 'calm', styleNote: '## 名前\nここは見出しではない' });
  assert.equal(next.soul.includes('\r\n'), true);
  assert.equal(next.soul.replace(/\r\n/gu, '').includes('\n'), false, '改行はすべて CRLF のまま');
  assert.equal((next.soul.match(/^## 名前/gmu) ?? []).length, 1, '自由な文の「## 名前」は見出しとして数えない');
  assert.match(next.soul, /\\## 名前/u);
  const second = personaTexts(next.soul, '', 'ja', { botName: 'ナギ' });
  assert.match(second.soul, /## 名前\r\n\r\nナギ\r\n/u, 'あとから名前を変えても、自由な文の行に当たらない');
});

test('見出しの決まり: コードが探す見出しは、初期のファイル（日本語・英語）の同じ位置の見出しと同じ。話し方の型は 3 つ + なし', () => {
  const headings = (text: string) => [...text.matchAll(/^## (.+)$/gmu)].map(m => m[1]!.trim());
  assert.deepEqual([headings(template('SOUL.md', 'ja'))[0], headings(template('SOUL.md', 'ja'))[2], headings(template('USER.md', 'ja'))[0]], ['名前', '話し方', '基本情報']);
  assert.deepEqual([headings(template('SOUL.md', 'en'))[0], headings(template('SOUL.md', 'en'))[2], headings(template('USER.md', 'en'))[0]], ['Name', 'Way of speaking', 'Basic information']);
  assert.deepEqual([...STYLES], ['calm', 'friendly', 'direct', 'none']);
  for (const language of ['ja', 'en'] as const) {
    assert.equal(styleText('none', language), '');
    for (const style of ['calm', 'friendly', 'direct'] as const) assert.ok(styleText(style, language).length > 20);
  }
  assert.doesNotMatch(styleText('calm', 'en') + styleText('friendly', 'en') + styleText('direct', 'en'), /[　-鿿]/u, '英語の文に日本語が混ざらない');
});

// ── 書き込みの守り ──

test('writePersonaFile: 書く前の控えは data/backups/persona/ に置き（作業フォルダの中ではなく）、同じ中身なら何も書かない', t => {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(join(paths.workspace, 'SOUL.md'), '古い中身', 'utf8');
  writePersonaFile(paths, 'SOUL.md', '新しい中身', 1_700_000_000_000);
  assert.equal(readFileSync(join(paths.workspace, 'SOUL.md'), 'utf8'), '新しい中身');
  const backups = readdirSync(join(paths.backups, 'persona'));
  assert.equal(backups.length, 1);
  assert.match(backups[0]!, /^SOUL\.md\.2023-11-14T22-13-20-000Z\.bak$/u);
  assert.equal(readFileSync(join(paths.backups, 'persona', backups[0]!), 'utf8'), '古い中身');
  assert.deepEqual(readdirSync(paths.workspace), ['SOUL.md'], '作業フォルダの中に控えを置かない');
  writePersonaFile(paths, 'SOUL.md', '新しい中身', 1_700_000_001_000);
  assert.equal(readdirSync(join(paths.backups, 'persona')).length, 1, '同じ中身なら控えも増やさない');
  writePersonaFile(paths, 'USER.md', '最初の USER');
  assert.equal(readdirSync(join(paths.backups, 'persona')).length, 1, 'まだ無いファイルは控えが要らない');
});

test('writePersonaFile: リンク（シンボリックリンク・ジャンクション）や普通のファイルでないものには書かない（作業フォルダも同じ）', t => {
  const outside = tempDir(t);
  writeFileSync(join(outside, 'secret.md'), '外のファイル');
  // ファイルのリンク（権限が無い環境では作れないので、ディレクトリのジャンクションで、リンクとして見える同じ判定を確かめる）
  const linked = resolvePaths(tempDir(t));
  mkdirSync(linked.workspace, { recursive: true });
  const elsewhere = join(outside, 'dir');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(linked.workspace, 'SOUL.md'), 'junction');
  assert.throws(() => writePersonaFile(linked, 'SOUL.md', '書き換え'), (error: unknown) => error instanceof PersonaError && error.code === 'persona_unsafe' && error.file === 'SOUL.md');
  assert.deepEqual(readdirSync(elsewhere), [], 'リンクの先には何も書かれない');

  const directory = resolvePaths(tempDir(t));
  mkdirSync(join(directory.workspace, 'SOUL.md'), { recursive: true });
  assert.throws(() => writePersonaFile(directory, 'SOUL.md', 'x'), PersonaError, '同じ名前のフォルダにも書かない');

  const workspaceLink = resolvePaths(tempDir(t));
  mkdirSync(workspaceLink.data, { recursive: true });
  const realWorkspace = join(outside, 'real-workspace');
  mkdirSync(realWorkspace);
  symlinkSync(realWorkspace, workspaceLink.workspace, 'junction');
  assert.throws(() => writePersonaFile(workspaceLink, 'USER.md', 'x'), PersonaError, '作業フォルダ自体がリンクのときも書かない');
  assert.deepEqual(readdirSync(realWorkspace), []);
});

test('reloadEnvFile: 起動したあとに足した鍵を読み込み、すでにある変数は上書きせず、違う値が書かれている変数の名前だけを返す（値は返さない）', t => {
  const dir = tempDir(t);
  const path = join(dir, '.env');
  writeFileSync(path, 'CLIVE_TEST_NEW_KEY=sk-new-secret\nCLIVE_TEST_SAME=same\nCLIVE_TEST_CHANGED=changed-in-file\n');
  delete process.env.CLIVE_TEST_NEW_KEY;
  process.env.CLIVE_TEST_SAME = 'same';
  process.env.CLIVE_TEST_CHANGED = 'running-value';
  t.after(() => { delete process.env.CLIVE_TEST_NEW_KEY; delete process.env.CLIVE_TEST_SAME; delete process.env.CLIVE_TEST_CHANGED; });
  const result = reloadEnvFile(path);
  assert.deepEqual(result, { loaded: true, notApplied: ['CLIVE_TEST_CHANGED'] });
  assert.equal(process.env.CLIVE_TEST_NEW_KEY, 'sk-new-secret', '新しい鍵は読み込まれる');
  assert.equal(process.env.CLIVE_TEST_CHANGED, 'running-value', '動いている値は上書きしない（起動し直すまで）');
  assert.deepEqual(reloadEnvFile(join(dir, 'missing.env')), { loaded: false, notApplied: [] });
  rmSync(path);
});

// ── API ──

test('GET /api/onboarding: 新しいデータでは未完了。すでに使っているデータ（会話・記憶・書き換えた SOUL / USER）には出さない', async t => {
  const fresh = await start(t);
  const state = await (await fresh.api('/api/onboarding')).json() as any;
  assert.deepEqual(state, { done: false, steps: { language: false, user: false, identity: false, persona: false, model: true } });

  const withConversation = await start(t);
  withConversation.app.conversations.create({ title: '前からある会話' });
  assert.equal(((await (await withConversation.api('/api/onboarding')).json()) as any).done, true, '会話がある = 設定済みとみなす');

  const withMemory = await start(t);
  withMemory.app.memory.save({ book: 'user', content: '前からある記憶', actor: 'user' });
  assert.equal(((await (await withMemory.api('/api/onboarding')).json()) as any).done, true);

  const edited = await start(t);
  writeFileSync(join(edited.paths.workspace, 'SOUL.md'), `${edited.file('SOUL.md')}\n自分で足した一行\n`);
  assert.equal(((await (await edited.api('/api/onboarding')).json()) as any).done, true, '書き換えた SOUL.md = 設定済みとみなす');

  const english = await start(t, 'en');
  assert.equal(((await (await english.api('/api/onboarding')).json()) as any).done, false, '英語の初期ファイルも「初期のまま」と見分ける');
  assert.equal(isInitialPersona(english.paths, 'SOUL.md', english.file('SOUL.md')), true);

  const noModel = await start(t, undefined, false);
  assert.equal(((await (await noModel.api('/api/onboarding')).json()) as any).steps.model, false);
});

test('POST /api/onboarding/persona: 名前・呼び方・話し方をサーバーが決まった節に書き、画面の名前（profile）も一緒に変える。途中で閉じても「続き」が残り、done で終わる', async t => {
  const s = await start(t);
  const res = await s.post('/api/onboarding/persona', { userName: 'やまだ', callMe: 'やまださん', botName: 'ミナト', style: 'calm', styleNote: '短めに' });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.profile.name, 'ミナト');
  assert.equal(s.app.config().profile.name, 'ミナト', '画面の名前と SOUL.md の名前を一緒に書く');
  assert.match(s.file('SOUL.md'), /## 名前\n\nミナト\n/u);
  assert.match(s.file('SOUL.md'), /## 話し方\n\n落ち着いて簡潔に話す。[^\n]+\n\n短めに\n/u);
  assert.match(s.file('USER.md'), /- 名前: やまだ\n- 呼び方: やまださん/u);
  assert.equal(readdirSync(join(s.paths.backups, 'persona')).filter(f => f.startsWith('SOUL.md.')).length, 1, '書き換えの前の SOUL.md は backups/persona に控える');
  assert.deepEqual(body.steps, { language: false, user: true, identity: true, persona: true, model: true });
  assert.equal(body.done, false, 'はじめの設定の途中で書き換えても、「使っているデータ」とは見なさず、続きの案内が残る');
  assert.equal(((await (await s.post('/api/onboarding/done', {})).json()) as any).done, true);
  assert.equal(((await (await s.api('/api/onboarding')).json()) as any).done, true);

  const partial = await start(t);
  await partial.post('/api/onboarding/persona', { botName: 'ナギ' });
  assert.equal(((await (await partial.api('/api/onboarding')).json()) as any).steps.identity, true);
  assert.equal(((await (await partial.api('/api/onboarding')).json()) as any).steps.user, false, '送った項目だけが済みになる');
  assert.doesNotMatch(partial.file('USER.md'), /呼び方/u, '送っていない項目は書かない');
});

test('POST /api/onboarding/persona: 検査（話し方の型・空・長さ・名前の空白）と、Origin が無い書き込みの拒否', async t => {
  const s = await start(t);
  const before = s.file('SOUL.md');
  const bad = async (body: unknown) => (await s.post('/api/onboarding/persona', body));
  assert.equal((await bad({ style: 'angry' })).status, 400);
  assert.equal(((await (await bad({ style: 'angry' })).json()) as any).code, 'http.bad_enum');
  assert.equal(((await (await bad({})).json()) as any).code, 'http.persona_empty');
  assert.equal(((await (await bad({ botName: 'x'.repeat(41) })).json()) as any).code, 'http.too_long');
  assert.equal(((await (await bad({ userName: 'x'.repeat(81) })).json()) as any).code, 'http.too_long');
  assert.equal(((await (await bad({ styleNote: 'x'.repeat(1001) })).json()) as any).code, 'http.too_long');
  assert.equal(((await (await bad({ botName: '   ' })).json()) as any).code, 'http.required');
  assert.equal(s.file('SOUL.md'), before, '断られたときは何も書かない');

  const noOrigin = await fetch(`${s.origin}/api/onboarding/persona`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botName: 'ミナト' }) });
  assert.equal(noOrigin.status, 403, 'Origin が無い書き込みは断る');
  assert.equal(s.file('SOUL.md'), before);
  const noOriginEnv = await fetch(`${s.origin}/api/onboarding/reload-env`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noOriginEnv.status, 403);
  const noOriginPut = await fetch(`${s.origin}/api/workspace/persona`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ soul: 'x' }) });
  assert.equal(noOriginPut.status, 403);
});

test('POST /api/onboarding/persona（日本語・英語）: 英語に切り替えたあとは英語の見出しの文で書き、日本語の見出しのファイルがあってもその節を直す', async t => {
  const en = await start(t, 'en');
  await en.post('/api/onboarding/persona', { userName: 'Taro', botName: 'Mina', style: 'friendly' });
  assert.match(en.file('SOUL.md'), /## Name\n\nMina\n/u);
  assert.match(en.file('SOUL.md'), /## Way of speaking\n\nSpeak in a friendly, polite way\./u);
  assert.match(en.file('USER.md'), /- Name: Taro/u);

  const mixed = await start(t, 'en');
  writeFileSync(join(mixed.paths.workspace, 'SOUL.md'), template('SOUL.md', 'ja'));
  await mixed.post('/api/onboarding/persona', { botName: 'Mina' });
  assert.match(mixed.file('SOUL.md'), /## 名前\n\nMina\n/u, '日本語の見出しのファイルの「名前」の節を直す');
  assert.equal((mixed.file('SOUL.md').match(/^## (名前|Name)$/gmu) ?? []).length, 1, '英語の見出しを足さない');
});

test('POST /api/onboarding/persona: SOUL.md がリンクなどのときは 409（http.persona_unsafe）で断り、リンクの先を書き換えない', async t => {
  const s = await start(t);
  rmSync(join(s.paths.workspace, 'SOUL.md'));
  const outside = tempDir(t);
  mkdirSync(join(outside, 'target'));
  symlinkSync(join(outside, 'target'), join(s.paths.workspace, 'SOUL.md'), 'junction');
  const res = await s.post('/api/onboarding/persona', { botName: 'ミナト', userName: 'やまだ' });
  assert.equal(res.status, 409);
  const body = await res.json() as any;
  assert.deepEqual([body.code, body.params], ['http.persona_unsafe', { file: 'SOUL.md' }]);
  assert.equal(existsSync(join(outside, 'target', 'x')), false);
  assert.deepEqual(readdirSync(join(outside, 'target')), []);
  assert.equal(s.app.config().profile.name, 'Clive', '書けなかったときは画面の名前も変えない');
  assert.doesNotMatch(s.file('USER.md'), /やまだ/u, '同じ要求の USER.md も書かない（先に SOUL.md で断る）');
});

test('GET/PUT /api/workspace/persona: 全文の読み書き（各 20,000 文字まで）。大きさの見積もりと、モデルの予算（いちばん小さいモデルの available の 10%）を返す', async t => {
  const s = await start(t);
  const view = await (await s.api('/api/workspace/persona')).json() as any;
  assert.equal(lf(view.soul), s.file('SOUL.md'));
  assert.equal(view.max, PERSONA_MAX_CHARS);
  assert.ok(view.tokens.soul > 0 && view.tokens.user > 0);
  assert.equal(view.budget, Math.floor((Math.floor(65536 * 0.95) - 1024) * 0.1), 'モデルの available の 10%');
  const put = await s.api('/api/workspace/persona', { method: 'PUT', body: JSON.stringify({ soul: '# SOUL\n\n## 名前\n\nナギ\n' }) });
  assert.equal(put.status, 200);
  assert.equal(s.file('SOUL.md'), '# SOUL\n\n## 名前\n\nナギ\n');
  assert.match(s.file('USER.md'), /# USER/u, '送らなかった方は変えない');
  assert.equal(readdirSync(join(s.paths.backups, 'persona')).length, 1);
  assert.equal(((await (await s.api('/api/workspace/persona', { method: 'PUT', body: JSON.stringify({ soul: 'x'.repeat(PERSONA_MAX_CHARS + 1) }) })).json()) as any).code, 'http.too_long');
  assert.equal((await s.api('/api/workspace/persona', { method: 'PUT', body: JSON.stringify({}) })).status, 400);
  assert.equal(s.file('SOUL.md'), '# SOUL\n\n## 名前\n\nナギ\n', '断られたときは変えない');

  const noModel = await start(t, undefined, false);
  assert.equal(((await (await noModel.api('/api/workspace/persona')).json()) as any).budget, null, 'モデルが 0 個なら予算なし');
});

test('POST /api/onboarding/reload-env: パスを受け取らず、鍵があるかどうかと変数の名前だけを返す（値は返さない）', async t => {
  const s = await start(t);
  process.env.FAKE_KEY = 'sk-secret-value-should-not-be-echoed';
  t.after(() => { delete process.env.FAKE_KEY; });
  const res = await s.post('/api/onboarding/reload-env', { path: '/etc/passwd', file: '../../secret.env' });
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text) as any;
  assert.deepEqual(Object.keys(body).sort(), ['apiKeys', 'loaded', 'notApplied']);
  assert.deepEqual(body.apiKeys, { FAKE_KEY: true });
  assert.equal(text.includes('sk-secret-value'), false, '鍵の値は返さない');
  assert.equal(typeof body.loaded, 'boolean');
  delete process.env.FAKE_KEY;
  assert.deepEqual(((await (await s.post('/api/onboarding/reload-env', {})).json()) as any).apiKeys, { FAKE_KEY: false }, '鍵が無ければ false');
  process.env.CLIVE_TEST_ASKED = 'also-secret';
  t.after(() => { delete process.env.CLIVE_TEST_ASKED; });
  const asked = await s.post('/api/onboarding/reload-env', { env: ['CLIVE_TEST_ASKED', 'lower_case', 'X'.repeat(70), 5, 'CLIVE_TEST_MISSING'] });
  const askedText = await asked.text();
  assert.deepEqual((JSON.parse(askedText) as any).apiKeys, { FAKE_KEY: false, CLIVE_TEST_ASKED: true, CLIVE_TEST_MISSING: false }, 'これから使う名前（形の合うものだけ）の有無も返す');
  assert.equal(askedText.includes('also-secret'), false);
});
