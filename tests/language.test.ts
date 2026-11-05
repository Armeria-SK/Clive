import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig, Language } from '../src/config/schema.ts';
import { ConfigError, ConfigStore, defaultConfig, parseConfig } from '../src/config/store.ts';
import { CuriosityStore } from '../src/curiosity/store.ts';
import { curiosityText } from '../src/curiosity/text.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { compactPrompt, compactSpeaker, compactSystem, replyLanguageKey, snapshotLanguageKey, summarySection, withReplyReminder } from '../src/engine/prompts.ts';
import { estimateTextTokens, estimateToolTokens } from '../src/engine/tokens.ts';
import type { ChatMessage } from '../src/engine/types.ts';
import { jsonFallbackInstructions, toJsonFallbackHistory } from '../src/engine/toolcall-parse.ts';
import { buildDynamic, buildSnapshot, defaultTexts, ensureWorkspace, readTemplate, WORKSPACE_FILES } from '../src/engine/workspace.ts';
import { bookPressureText, reviewPrompt, transcriptOf, type ReviewTrigger } from '../src/memory/review.ts';
import { renderBooks, type Memory } from '../src/memory/store.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { ProviderError, type ModelRequest } from '../src/providers/types.ts';
import { languageOf } from '../src/shared/language.ts';
import { taskPrompt } from '../src/tasks/worker.ts';
import { SkillStore } from '../src/tools/skills/store.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { createWebServer } from '../src/web/server.ts';
import { fail, fakeServer, FakeAdapter, reply, sse, tempDir, type Script } from './helpers.ts';

const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;
const JA_DIRECTIVE = '返事は日本語で書く';
const EN_DIRECTIVE = 'Write your replies in English';

function paths(t: { after: (fn: () => void) => void }, templates?: Record<string, string>): AppPaths {
  const dir = tempDir(t);
  const base = resolvePaths(dir);
  if (!templates) return base;
  const root = join(dir, 'templates');
  for (const [name, content] of Object.entries(templates)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return { ...base, templates: root };
}

async function startApp(t: { after: (fn: () => void | Promise<void>) => void }, options: { language?: Language; contextLength?: number; before?: (workspace: string) => void } = {}) {
  const p = resolvePaths(tempDir(t));
  mkdirSync(p.workspace, { recursive: true });
  options.before?.(p.workspace);
  const config = defaultConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: options.contextLength ?? 65536, minContext: 1024, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  if (options.language) config.language = options.language;
  writeFileSync(p.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
  let adapter!: FakeAdapter;
  const app = new App({
    paths: p, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false,
    adapterOverride: provider => (adapter = new FakeAdapter(provider)),
  });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  const setLanguage = (language: Language | undefined) => {
    const next = { ...app.config() };
    if (language) next.language = language; else delete next.language;
    return app.applyConfig(next);
  };
  return { app, paths: p, adapter: () => adapter, clock, setLanguage };
}

async function say(s: Awaited<ReturnType<typeof startApp>>, conversationId: string, text: string) {
  s.adapter().scripts.push(reply('ok'));
  const outcome = s.app.engine.send(conversationId, text);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.ok((await s.app.engine.wait(outcome.runId))?.ok);
  return s.adapter().calls.at(-1)!;
}

// ── 設定 ──

test('設定: language を書かなければ未選択のまま（返事は日本語）で、ja / en 以外は場所つきで断る', () => {
  assert.equal(defaultConfig().language, undefined);
  const parsed = parseConfig({ version: 1, server: {}, routing: {} });
  assert.equal(parsed.language, undefined);
  assert.equal(languageOf(parsed), 'ja');
  assert.equal(languageOf(parseConfig({ version: 1, server: {}, routing: {}, language: 'en' })), 'en');
  assert.equal(languageOf(parseConfig({ version: 1, server: {}, routing: {}, language: 'ja' })), 'ja');
  assert.throws(() => parseConfig({ version: 1, server: {}, routing: {}, language: 'fr' }), (e: unknown) => e instanceof ConfigError && e.problems.some(p => p.startsWith('/language')));
});

test('設定: language は保存して読み直せ、未選択のときは設定ファイルに書かれない', t => {
  const store = new ConfigStore(join(tempDir(t), 'config.json'));
  const config = store.load();
  assert.ok(!('language' in JSON.parse(readFileSync(store.path, 'utf8'))), '初期の設定ファイルに language は無い');
  store.save({ ...config, language: 'en' });
  assert.equal(new ConfigStore(store.path).load().language, 'en');
  const { language: _dropped, ...withoutLanguage } = config;
  store.save(withoutLanguage);
  assert.equal(new ConfigStore(store.path).load().language, undefined);
});

// ── テンプレート ──

test('テンプレート: 言語ごとに読み分け、英語のファイルが無ければ日本語に戻る', t => {
  const real = paths(t);
  assert.match(readTemplate(real, 'rules', 'ja'), /^# Clive の基本ルール/u);
  assert.match(readTemplate(real, 'rules', 'en'), /^# Clive's basic rules/u);
  for (const name of WORKSPACE_FILES) {
    assert.notEqual(readTemplate(real, name, 'en'), readTemplate(real, name, 'ja'), `${name} の英語版がある`);
  }

  const onlyJapanese = paths(t, { 'rules.ja.md': '日本語のルール', 'SOUL.md': '日本語の SOUL' });
  assert.equal(readTemplate(onlyJapanese, 'rules', 'en'), '日本語のルール', 'en/ が無ければ日本語');
  assert.equal(readTemplate(onlyJapanese, 'SOUL.md', 'en'), '日本語の SOUL');
  assert.equal(readTemplate(onlyJapanese, 'USER.md', 'en'), '', 'どちらにも無ければ空');

  const partial = paths(t, { 'rules.ja.md': '日本語のルール', 'SOUL.md': '日本語の SOUL', 'en/rules.md': 'English rules' });
  assert.equal(readTemplate(partial, 'rules', 'en'), 'English rules');
  assert.equal(readTemplate(partial, 'SOUL.md', 'en'), '日本語の SOUL', '英語版が無いファイルだけ日本語に戻る');
  assert.equal(readTemplate(partial, 'rules', 'ja'), '日本語のルール', 'ja は en/ を見ない');
});

test('テンプレート: 英語版は日本語版と同じ見出しの並びで、日本語が混ざらず、好奇心リストに項目を足さない', t => {
  const real = paths(t);
  const headings = (text: string) => text.split(/\r?\n/u).filter(line => /^#{1,3} /u.test(line)).map(line => line.match(/^#+/u)![0]);
  const names = ['rules', ...WORKSPACE_FILES] as const;
  for (const name of names) {
    const ja = readTemplate(real, name, 'ja');
    const en = readTemplate(real, name, 'en');
    assert.deepEqual(headings(en), headings(ja), `${name}: 見出しの階層と数が日本語版と同じ`);
    assert.equal(en.split(/\r?\n/u).filter(line => /^- /u.test(line)).length, ja.split(/\r?\n/u).filter(line => /^- /u.test(line)).length, `${name}: 箇条書きの数が同じ`);
    assert.doesNotMatch(en, CJK, `${name}: 英語版に日本語が混ざっていない`);
  }
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  assert.equal(new CuriosityStore(db).importMarkdown(readTemplate(real, 'CURIOSITY.md', 'en')), 0, '英語の CURIOSITY.md を取り込んでも項目は増えない');
});

test('初期値の写し: 言語に合う版を、無いファイルにだけ写す（既存のファイルは上書きしない）', t => {
  const p = paths(t);
  ensureWorkspace(p, 'en');
  for (const name of WORKSPACE_FILES) assert.equal(readFileSync(join(p.workspace, name), 'utf8'), readFileSync(join(p.templates, 'en', name), 'utf8'));

  const ja = paths(t);
  ensureWorkspace(ja);
  assert.equal(readFileSync(join(ja.workspace, 'SOUL.md'), 'utf8'), readFileSync(join(ja.templates, 'SOUL.md'), 'utf8'), '言語を決めていなければ日本語');

  const existing = paths(t);
  mkdirSync(existing.workspace, { recursive: true });
  writeFileSync(join(existing.workspace, 'SOUL.md'), '# 私の SOUL\n皮肉屋');
  writeFileSync(join(existing.workspace, 'USER.md'), '# 私の USER\n猫が好き');
  ensureWorkspace(existing, 'en');
  assert.equal(readFileSync(join(existing.workspace, 'SOUL.md'), 'utf8'), '# 私の SOUL\n皮肉屋', '書かれた SOUL.md はそのまま');
  assert.equal(readFileSync(join(existing.workspace, 'USER.md'), 'utf8'), '# 私の USER\n猫が好き', '書かれた USER.md はそのまま');
  assert.match(readFileSync(join(existing.workspace, 'CURIOSITY.md'), 'utf8'), /^# CURIOSITY\r?\n\r?\nThings that sparked curiosity/u, '無かったファイルだけ英語の初期値が入る');
});

test('起動: language が en の新しい作業フォルダには英語の初期値が入り、すでにある SOUL.md / USER.md は変わらない', async t => {
  const fresh = await startApp(t, { language: 'en' });
  assert.match(readFileSync(join(fresh.paths.workspace, 'SOUL.md'), 'utf8'), /Your own personality/u);
  assert.match(readFileSync(join(fresh.paths.workspace, 'USER.md'), 'utf8'), /Main language: English/u);

  const kept = await startApp(t, { language: 'en', before: ws => { writeFileSync(join(ws, 'SOUL.md'), '日本語の SOUL のまま'); } });
  assert.equal(readFileSync(join(kept.paths.workspace, 'SOUL.md'), 'utf8'), '日本語の SOUL のまま');
  assert.match(readFileSync(join(kept.paths.workspace, 'USER.md'), 'utf8'), /Main language: English/u, '無かった USER.md だけ英語');

  const unset = await startApp(t);
  assert.match(readFileSync(join(unset.paths.workspace, 'SOUL.md'), 'utf8'), /あなた自身の人格/u, 'language が無ければ日本語');
});

test('API: 英語の初期値を読める（読むだけ。作業フォルダは変わらない）', async t => {
  const s = await startApp(t);
  const web = createWebServer(s.app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); });
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  const get = (path: string) => fetch(`${origin}${path}`, { headers: { Origin: origin } });

  const before = readFileSync(join(s.paths.workspace, 'SOUL.md'), 'utf8');
  const en = await (await get('/api/templates/en')).json() as any;
  assert.equal(en.language, 'en');
  assert.match(en.rules, /^# Clive's basic rules/u);
  assert.deepEqual(en.files.map((f: any) => f.name), ['SOUL.md', 'USER.md', 'CURIOSITY.md']);
  assert.match(en.files[0].content, /Your own personality/u);
  const ja = await (await get('/api/templates/ja')).json() as any;
  assert.match(ja.files[0].content, /あなた自身の人格/u);
  assert.equal((await get('/api/templates/fr')).status, 404);
  assert.equal(readFileSync(join(s.paths.workspace, 'SOUL.md'), 'utf8'), before, '読んでも作業フォルダの SOUL.md は変わらない');

  const view = await (await get('/api/settings')).json() as any;
  assert.equal(view.config.language, undefined, '未選択');
  const saved = await fetch(`${origin}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ config: { ...view.config, language: 'en' } }) });
  assert.equal(saved.status, 200);
  assert.equal(((await saved.json()) as any).config.language, 'en');
  assert.equal(s.app.restartRequired(), false, '言語の変更に再起動は要らない');
  const bad = await fetch(`${origin}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ config: { ...view.config, language: 'fr' } }) });
  assert.equal(bad.status, 400);
});

// ── 返事の言語 ──

test('buildDynamic: 言語ごとに現在時刻の行と返事の言語の指示を返す', () => {
  const now = new Date('2026-11-04T20:00:00Z');
  const ja = buildDynamic('Asia/Tokyo', 'ja', now);
  assert.match(ja, /^現在時刻: .*05:00.*（Asia\/Tokyo）\n返事は日本語で書く（ユーザーが別の言語で話しかけたら、その言語で返す）$/u);
  const en = buildDynamic('Asia/Tokyo', 'en', now);
  assert.match(en, /^Current time: Thu, Nov 5, 2026, 05:00 \(Asia\/Tokyo\)\nWrite your replies in English \(if the user speaks to you in another language, reply in that language\)\.$/u);
  assert.doesNotMatch(en, CJK);
  assert.equal(buildDynamic('Asia/Tokyo', undefined, now), ja, '言語を渡さなければ日本語');
  assert.match(buildDynamic('America/New_York', 'en', now), /Wed, Nov 4, 2026, 15:00 \(America\/New_York\)/u, 'タイムゾーンに合わせる');
});

test('buildSnapshot: 言語に合うルールと見出しで組み立てる（日本語は今までのまま）', t => {
  const p = paths(t);
  mkdirSync(p.workspace, { recursive: true });
  writeFileSync(join(p.workspace, 'SOUL.md'), 'Dry wit');
  writeFileSync(join(p.workspace, 'USER.md'), 'Likes tea');
  const ja = buildSnapshot(p, {});
  assert.equal(buildSnapshot(p, {}, 'ja').text, ja.text);
  assert.match(ja.text, /^# Clive の基本ルール[\s\S]*# あなた自身（SOUL\.md）\n\nDry wit[\s\S]*# ユーザーについて（USER\.md）\n\nLikes tea$/u);
  const en = buildSnapshot(p, {}, 'en');
  assert.match(en.text, /^# Clive's basic rules[\s\S]*# Who you are \(SOUL\.md\)\n\nDry wit[\s\S]*# About the user \(USER\.md\)\n\nLikes tea$/u);
  assert.doesNotMatch(en.text, CJK);
  assert.notEqual(en.hash, ja.hash);
});

test('baseTokens: 言語に合うルールの長さで見積もる', async t => {
  const s = await startApp(t);
  const rest = () => {
    const config = s.app.config();
    return estimateToolTokens(ToolRegistry.specs(s.app.tools.forRun('chat'))) + 64;
  };
  const expected = (language: Language) => estimateTextTokens(buildSnapshot(s.paths, { skills: '' }, language).text)
    + estimateTextTokens(buildDynamic(s.app.config().timezone, language)) + rest();

  const ja = s.app.baseTokens();
  assert.equal(ja, expected('ja'), '未選択は日本語の見積もり');
  await s.setLanguage('en');
  const en = s.app.baseTokens();
  assert.equal(en, expected('en'), 'en はルールも指示も英語で数える');
  assert.notEqual(en, ja);
  await s.setLanguage('ja');
  assert.equal(s.app.baseTokens(), ja, 'ja に戻せば元の値');
});

test('すでにある日本語の会話で言語を en にすると、次のリクエストの動的な部分が英語の指示になる（固定の system はそのまま）', async t => {
  const s = await startApp(t);
  const first = await say(s, 'c1', 'こんにちは');
  assert.match(first.system.frozen, /^# Clive の基本ルール/u, '最初の会話は日本語のルールで始まる');
  assert.ok(first.system.dynamic.includes(JA_DIRECTIVE));
  assert.ok(!first.system.dynamic.includes(EN_DIRECTIVE));

  await s.setLanguage('en');
  const second = await say(s, 'c1', 'Hello again');
  assert.ok(second.system.dynamic.includes(EN_DIRECTIVE), '同じ会話の次の返事から英語の指示');
  assert.match(second.system.dynamic, /^Current time: /u);
  assert.ok(!second.system.dynamic.includes(JA_DIRECTIVE));
  assert.equal(second.system.frozen, first.system.frozen, '固定の system は会話の途中で変えない');

  const fresh = await say(s, 'c2', 'Hello');
  assert.match(fresh.system.frozen, /^# Clive's basic rules[\s\S]*Reply in English/u, '新しい会話は英語のルールで始まる');
  assert.ok(fresh.system.dynamic.includes(EN_DIRECTIVE));

  await s.setLanguage('ja');
  const back = await say(s, 'c1', 'また日本語で');
  assert.ok(back.system.dynamic.includes(JA_DIRECTIVE), 'ja に戻せば次の返事から日本語の指示');
  assert.ok(!back.system.dynamic.includes(EN_DIRECTIVE));
});

test('入りきらない古いやり取りの要約も、英語の指示で頼み、要約は英語の見出しで次のリクエストに入る', async t => {
  const s = await startApp(t, { language: 'en', contextLength: 20_000 });
  for (let i = 0; i < 6; i++) {
    s.app.conversations.append('c1', { role: 'user', content: `Question${i} ` + 'x'.repeat(14_000) });
    s.app.conversations.append('c1', { role: 'assistant', content: `Answer${i}` });
  }
  s.adapter().scripts.push(reply('- The user asked about x'));
  const answer = await say(s, 'c1', 'The latest question');
  const [summaryCall] = s.adapter().calls;
  assert.equal(s.adapter().calls.length, 2, '要約の呼び出しと本番の呼び出し');
  assert.equal(summaryCall!.system.frozen, compactSystem('en'));
  const asked = (summaryCall!.messages[0] as { content: string }).content;
  assert.match(asked, /^This is the older part of a conversation\. Summarize, concisely as bullet points in English/u);
  assert.match(asked, /\nUser: Question0 /u);
  assert.match(asked, /\nClive: Answer0/u);
  assert.doesNotMatch(asked, CJK);
  assert.match(answer.system.dynamic, /# Summary of the conversation so far[\s\S]*The user asked about x/u);
  assert.doesNotMatch(answer.system.dynamic, CJK);
});

// ── 決まり文 ──

test('決まり文: 日本語は今までの文のまま', () => {
  assert.equal(summarySection('A', 'ja'), '# これまでの会話の要約（古い部分。原文は history_read で読めます）\nA');
  assert.equal(summarySection('', 'ja'), '');
  assert.equal(compactSystem('ja'), 'あなたは会話の要約係です。指示されたとおりに要約だけを書きます。');
  assert.equal(compactPrompt({ previous: '前の要約', transcript: 'ユーザー: こんにちは' }, 'ja'), [
    'これは会話の古い部分です。これからの会話を続けるのに必要なことを、日本語の箇条書きで簡潔にまとめてください。',
    '残すもの: ユーザーの目的・頼まれていること・決まったこと・分かった事実・まだ終わっていないこと・大事な固有名詞や数値。',
    '残さないもの: あいさつ・言い回し・試行錯誤の細部。',
    '\n# これまでの要約（これに足して、まとめ直してください）\n前の要約',
    '\n# 会話の古い部分\nユーザー: こんにちは',
  ].join('\n'));
  assert.equal(compactPrompt({ previous: null, transcript: 'x' }, 'ja').includes('これまでの要約'), false);
  assert.deepEqual(['user', 'assistant', 'tool'].map(role => compactSpeaker({ role, name: 'file_list' }, 'ja')), ['ユーザー', 'Clive', '道具（file_list）の結果']);
});

test('決まり文: 英語にすると、モデルに渡す文に日本語が混ざらない', t => {
  const p = paths(t);
  mkdirSync(p.workspace, { recursive: true });
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const skills = new SkillStore(db, join(p.workspace, 'skills'));
  skills.write({ name: 'weekly-report', description: 'Write the weekly report', body: 'Steps' });
  const memories: Memory[] = [
    { id: 1, book: 'user', content: 'Likes tea', status: 'active', origin: 'chat', source_conversation_id: null, source_message_id: null, created_at: 0, updated_at: 0 },
    { id: 2, book: 'notes', content: 'Lesson', status: 'active', origin: 'chat', source_conversation_id: null, source_message_id: null, created_at: 0, updated_at: 0 },
  ];
  const task = { id: 'abcdef12-0000', title: 'Write the invoice', origin: 'curiosity', body: 'Details', next_action: 'Sum it up', done_criteria: 'Sent' } as any;
  const events = [{ kind: 'note', content: 'Started', created_at: Date.parse('2026-11-04T20:00:00Z') }];
  const stored = [
    { id: 1, role: 'user', text: 'Hello', message: { role: 'user' } },
    { id: 2, role: 'assistant', text: 'Hi', message: { role: 'assistant' } },
    { id: 3, role: 'tool', text: 'out', message: { role: 'tool', name: 'file_list' } },
  ] as any;
  const triggers: ReviewTrigger[] = ['task', 'idle', 'heavy_run', 'book_full', 'manual'];
  const pressure = { tokens: 900, budget: 500, outside: [{ id: 1, book: 'user' as const, content: 'Old fact' }, { id: 2, book: 'notes' as const, content: 'Old lesson' }] };
  const texts: Record<string, string> = {
    books: renderBooks(memories, 'en'),
    skills: skills.index('en'),
    summary: summarySection('A summary', 'en'),
    compactSystem: compactSystem('en'),
    compact: compactPrompt({ previous: 'Before', transcript: 'User: hi' }, 'en'),
    speakers: ['user', 'assistant', 'tool'].map(role => compactSpeaker({ role, name: 'file_list' }, 'en')).join(' '),
    task: taskPrompt(task, events, 'Asia/Tokyo', 'en'),
    fallback: jsonFallbackInstructions([{ name: 'file_list', description: 'List files', inputSchema: { type: 'object' } }], 'en'),
    fallbackHistory: JSON.stringify(toJsonFallbackHistory([{ role: 'tool', name: 'file_list', content: 'x', isError: true, toolCallId: '1' }], 'en')),
    transcript: transcriptOf(stored, 15_000, 'en'),
    pressure: bookPressureText(pressure, 'en'),
    curiosity: Object.values(curiosityText('en')).map(v => (typeof v === 'function' ? v('Topic') : v)).join('\n'),
    ...Object.fromEntries(triggers.map(trigger => [`review:${trigger}`, reviewPrompt({
      trigger, language: 'en', forgotten: ['Forgotten fact'], bookPressure: bookPressureText(pressure, 'en'),
      task: { title: 'T', status: 'done', result_summary: 'Result', body: 'Body' }, taskEvents: [{ kind: 'note', content: 'Event' }], transcript: transcriptOf(stored, 15_000, 'en'),
    })])),
  };
  for (const [name, text] of Object.entries(texts)) {
    assert.ok(text.length > 0, `${name}: 空ではない`);
    assert.doesNotMatch(text, CJK, `${name}: 日本語が混ざっている`);
  }
  assert.match(texts.task!, /^\[Task run\]/u);
  assert.match(texts.task!, /Where it came from: From your curiosity/u);
  assert.match(texts['review:book_full']!, /Memory usage\nMemory totals about 900 tokens, over the guideline for what goes into a conversation \(about 500 tokens\)\. 2 memories do not fit in a conversation\. Prioritize merging overlapping memories and trimming old ones\nMemories that do not fit \(oldest first\):\n- \[u1\] Old fact\n- \[n2\] Old lesson/u);
  assert.match(texts.fallbackHistory!, /\[Result of tool \\"file_list\\" \(error\)\]/u);
});

test('決まり文: 言語を渡さない呼び出しは日本語のまま', () => {
  const memories: Memory[] = [{ id: 1, book: 'user', content: '紅茶', status: 'active', origin: 'chat', source_conversation_id: null, source_message_id: null, created_at: 0, updated_at: 0 }];
  assert.equal(renderBooks(memories), renderBooks(memories, 'ja'));
  assert.match(renderBooks(memories), /^# 覚えていること（記憶）\n\n## ユーザーについての記憶\n- \[u1\] 紅茶$/u);
  assert.match(reviewPrompt({ trigger: 'idle', forgotten: [] }), /^\[振り返り\] きっかけ: 会話が途切れた。/u);
  assert.match(jsonFallbackInstructions([{ name: 'a', description: 'b', inputSchema: {} }]), /^# 使える道具/u);
});

// ── 日本語の決まり文は、段階 12a の前（0250344）の出力と一字も変えない ──

const JA_TASK_HEAD = [
  '[タスクの実行] あなたは今、自分のメモ帳のタスクを進めています（ユーザーとの会話ではありません。返事は記録に残ります）。',
  '',
  '# タスク',
];
const JA_TASK_HOW = [
  '',
  '# 進め方',
  '- 道具を使って進める。1回の実行でやりすぎない',
  '- 終わったら task_complete（結果の要約）。ユーザーに知らせることが無ければ notify=false で静かに終える',
  '- 続きを後でやる・何かを待つなら task_checkpoint（試したこと・結果・次の一手・何分後に再開するか）',
  '- ユーザーに確かめないと進められないことだけ ask_user で尋ねる',
];
const JA_REVIEW_POLICY = [
  '',
  '# 方針',
  '- 残すのは「次に役立つ教訓と事実」。出来事のログは残さない',
  '- 既に記憶にあることは足さない。重なっている記憶は memory_update で1つにまとめ、要らなくなった方は memory_forget',
  '- 矛盾したら新しい方を残す',
  '- 拾い漏れたユーザーについての事実（好み・予定・関係・環境）は memory_save（book=user）。自分の教訓は book=notes',
  '- 1つの記録から足すのは多くても3件',
  '- 繰り返し使えそうな手順が見つかったら skill_draft（ユーザーが承認するまで使われない）。新しく作るより、既存のスキルを直すほうを優先する',
  '- 気になったが調べていないことがあれば curiosity_add',
  '- することがなければ、道具を使わずに「変更なし」とだけ返す',
  '- 最後に、何をしたかを1〜2文で返す',
];
const jaReviewIntro = (trigger: string) => `[振り返り] きっかけ: ${trigger}。下の記録を読んで、記憶を整える（ユーザーとの会話ではありません。返事は記録に残るだけです）。`;

test('日本語の固定文: タスクの実行の指示は 0250344 の出力と一字も違わない', () => {
  const task = { id: 'abcdef12-0000', title: '請求書をまとめる', origin: 'user', body: '詳細です', next_action: '集計する', done_criteria: '送った' } as any;
  const events = [
    { kind: 'note', content: 'メモ', created_at: Date.parse('2026-11-04T20:00:00Z') },
    { kind: 'run', content: null, created_at: Date.parse('2026-11-04T20:01:00Z') },
  ];
  const expectedFull = [
    ...JA_TASK_HEAD,
    'ID: abcdef12',
    'タイトル: 請求書をまとめる',
    '出どころ: ユーザーの依頼',
    '詳細:',
    '詳細です',
    '次の一手: 集計する',
    '完了の条件: 送った',
    '',
    '# これまでの経過（新しい順）',
    '- 2026/11/5 5:00:00 note: メモ',
    ...JA_TASK_HOW,
  ].join('\n');
  assert.equal(taskPrompt(task, events, 'Asia/Tokyo'), expectedFull);
  assert.equal(taskPrompt(task, events, 'Asia/Tokyo', 'ja'), expectedFull);

  const bare = { id: 'abcdef12-0000', title: 'T', origin: 'schedule', body: '', next_action: null, done_criteria: null } as any;
  assert.equal(taskPrompt(bare, [], 'UTC'), [...JA_TASK_HEAD, 'ID: abcdef12', 'タイトル: T', '出どころ: 予定', ...JA_TASK_HOW].join('\n'));
  const origins = { user: 'ユーザーの依頼', self: '自分で決めたこと', curiosity: '好奇心から', schedule: '予定' };
  for (const [origin, label] of Object.entries(origins)) {
    assert.ok(taskPrompt({ ...bare, origin }, [], 'UTC').split('\n').includes(`出どころ: ${label}`), origin);
  }
});

test('日本語の固定文: 振り返りの指示は 0250344 の出力と一字も違わない', () => {
  assert.equal(reviewPrompt({ trigger: 'book_full', forgotten: ['忘れた記憶'], bookPressure: 'ユーザーについて: 10/20 文字、メモと教訓: 5/30 文字' }), [
    jaReviewIntro('記憶が大きくなった'),
    ...JA_REVIEW_POLICY,
    '',
    '# ユーザーが消した記憶（同じ内容を覚え直さない）',
    '- 忘れた記憶',
    '',
    '# 記憶の量',
    'ユーザーについて: 10/20 文字、メモと教訓: 5/30 文字',
  ].join('\n'));

  assert.equal(reviewPrompt({
    trigger: 'task', forgotten: [], task: { title: 'T', status: 'done', result_summary: '結果', body: 'メモ本文' },
    taskEvents: [{ kind: 'note', content: '経過' }, { kind: 'x', content: null }],
  }), [
    jaReviewIntro('タスクが終わった'),
    ...JA_REVIEW_POLICY,
    '',
    '# 終わったタスク',
    'タイトル: T',
    '結果: done — 結果',
    'メモ:',
    'メモ本文',
    '経過:',
    '- note: 経過',
  ].join('\n'));

  const stored = [
    { id: 1, role: 'user', text: 'こんにちは', message: { role: 'user' } },
    { id: 2, role: 'assistant', text: '返事', message: { role: 'assistant' } },
    { id: 3, role: 'tool', text: 'tool out', message: { role: 'tool', name: 'file_list' } },
  ] as any;
  assert.equal(reviewPrompt({ trigger: 'idle', forgotten: [], transcript: transcriptOf(stored) }), [
    jaReviewIntro('会話が途切れた'),
    ...JA_REVIEW_POLICY,
    '',
    '# 会話の記録',
    '【ユーザー】こんにちは',
    '【Clive】返事',
    '【道具 file_list】tool out',
  ].join('\n'));

  const triggers = { task: 'タスクが終わった', idle: '会話が途切れた', heavy_run: '道具を多く使った', book_full: '記憶が大きくなった', manual: '手動' };
  for (const [trigger, label] of Object.entries(triggers)) {
    assert.equal(reviewPrompt({ trigger: trigger as ReviewTrigger, forgotten: [] }).split('\n')[0], jaReviewIntro(label), trigger);
  }
  const long = [
    { id: 1, role: 'user', text: 'あ'.repeat(3100), message: { role: 'user' } },
    { id: 2, role: 'tool', text: 'い'.repeat(310), message: { role: 'tool', name: 'file_list' } },
  ] as any;
  assert.equal(transcriptOf(long), `【ユーザー】${'あ'.repeat(3000)}…（略）\n【道具 file_list】${'い'.repeat(300)}…（略）`);
  assert.equal(bookPressureText({ tokens: 900, budget: 500, outside: [{ id: 1, book: 'user', content: '古い事実' }, { id: 2, book: 'notes', content: '古い教訓' }] }), [
    '記憶の合計は約 900 トークンで、会話に入れる量の目安（約 500 トークン）を超えています。会話に入りきらない記憶が 2 件あります。重なりをまとめ、古いものを減らすことを優先する',
    '会話に入りきらない記憶（古い順）:',
    '- [u1] 古い事実',
    '- [n2] 古い教訓',
  ].join('\n'));
});

test('日本語の固定文: json_fallback の説明・スキル一覧・好奇心のタスクの文は 0250344 の出力と一字も違わない', t => {
  const specs = [
    { name: 'file_list', description: '一覧', inputSchema: { type: 'object' } },
    { name: 'memory_save', description: '記憶する', inputSchema: { type: 'object', properties: { body: { type: 'string' } } } },
  ];
  const expectedFallback = [
    '# 使える道具',
    '道具を使うときは、返事の中に次の形式で書いてください（1回の返事で1つまで）。',
    '<tool_call>{"name": "道具の名前", "arguments": { ... }}</tool_call>',
    '道具の結果は次のメッセージで渡します。道具を使わないときは、普通に返事を書いてください。',
    '- file_list: 一覧',
    '  引数（JSON Schema）: {"type":"object"}',
    '- memory_save: 記憶する',
    '  引数（JSON Schema）: {"type":"object","properties":{"body":{"type":"string"}}}',
  ].join('\n');
  assert.equal(jsonFallbackInstructions(specs), expectedFallback);
  assert.equal(jsonFallbackInstructions(specs, 'ja'), expectedFallback);
  assert.equal(jsonFallbackInstructions([]), '');
  assert.deepEqual(toJsonFallbackHistory([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b', toolCalls: [{ id: '1', name: 'file_list', arguments: {} }] },
    { role: 'tool', name: 'file_list', content: 'x', isError: true, toolCallId: '1' },
    { role: 'tool', name: 'file_list', content: 'y', isError: false, toolCallId: '2' },
  ]), [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b\n<tool_call>{"name":"file_list","arguments":{}}</tool_call>' },
    { role: 'user', content: '[道具「file_list」の結果（エラー）]\nx\n\n[道具「file_list」の結果]\ny' },
  ]);

  const p = paths(t);
  mkdirSync(p.workspace, { recursive: true });
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const skills = new SkillStore(db, join(p.workspace, 'skills'));
  assert.equal(skills.index(), '');
  skills.write({ name: 'weekly-report', description: '週報を書くとき', body: '手順' });
  skills.write({ name: 'deploy', description: 'デプロイするとき', body: '手順' });
  const expectedSkills = ['# スキル（手順書）', '次の作業をするときは、先に skill_view で手順を読んでから従う。', '- deploy: デプロイするとき', '- weekly-report: 週報を書くとき'].join('\n');
  assert.equal(skills.index(), expectedSkills);
  assert.equal(skills.index('ja'), expectedSkills);

  const text = curiosityText('ja');
  assert.equal(text.title('X'), '調べる: X');
  assert.equal(text.why('Y'), '気になった理由: Y');
  assert.equal(text.summarize, '調べて分かったことを、ユーザーに役立つ形で短くまとめる。');
  assert.equal(text.doneCriteria, '分かったことを task_complete の summary にまとめた');
  assert.equal(text.doneCriteriaQuiet, '分かったことを task_complete の summary にまとめた（知らせる価値が無ければ notify=false）');
});

// ── 言語を変えた会話にだけ付く、最後の発言への一行の注意 ──

const EN_REMINDER = /\n\n\[System note: the reply language of this conversation is now English\. /u;
const JA_REMINDER = /\n\n\[システムからの注意: この会話の返事の言語は日本語になりました。/u;

test('返事の言語の注意: 最後のユーザーの発言だけに足した写しを返し、元は変えない', () => {
  const original: ChatMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'second' },
    { role: 'tool', toolCallId: '1', name: 'file_list', content: 'out' },
  ];
  const snapshot = JSON.stringify(original);
  const en = withReplyReminder(original, 'en');
  assert.equal(JSON.stringify(original), snapshot, '元の配列と発言は変えない');
  assert.deepEqual(en.map(m => m.content), ['first', 'a', en[2]!.content, 'out']);
  assert.match(en[2]!.content, /^second\n\n\[System note: /u);
  assert.match(withReplyReminder(original, 'ja')[2]!.content, /^second\n\n\[システムからの注意: /u);
  assert.doesNotMatch(withReplyReminder(original, 'en')[2]!.content, CJK);
  assert.deepEqual(withReplyReminder([{ role: 'assistant', content: 'a' }], 'en'), [{ role: 'assistant', content: 'a' }], 'ユーザーの発言が無ければそのまま');
});

test('返事の言語の注意: 言語を変えた会話のモデルへの要求にだけ付き、保存も表示もされない', async t => {
  const s = await startApp(t);
  const contents = (call: ModelRequest) => call.messages.map(m => m.content);
  const stored = (id: string) => s.app.conversations.messages(id).map(m => m.text);

  await say(s, 'c1', 'one');
  const second = await say(s, 'c1', 'two');
  assert.deepEqual(contents(second), ['one', 'ok', 'two'], '言語を変えていない会話は、保存された発言そのまま（注意なし）');
  assert.equal(s.app.kv.get(replyLanguageKey('c1')), undefined, '言語を変えていない会話には、何も記録しない');

  await s.setLanguage('en');
  const third = await say(s, 'c1', 'Hello again');
  assert.deepEqual(contents(third).slice(0, 4), ['one', 'ok', 'two', 'ok'], '前の発言は変わらない');
  assert.match(contents(third).at(-1)!, /^Hello again/u);
  assert.match(contents(third).at(-1)!, EN_REMINDER, 'ja で始まった会話を en にした次の要求には英語の注意が付く');
  const fourth = await say(s, 'c1', 'And again');
  assert.match(contents(fourth).at(-1)!, EN_REMINDER, '会話の言語が元に戻るまで、毎回付く');
  assert.doesNotMatch(contents(fourth).slice(0, -1).join('\n'), /System note/u, '前の発言には付けない');
  assert.deepEqual(stored('c1'), ['one', 'ok', 'two', 'ok', 'Hello again', 'ok', 'And again', 'ok'], '保存された発言に注意は入らない');

  await s.setLanguage('ja');
  const back = await say(s, 'c1', 'three');
  assert.match(contents(back).at(-1)!, JA_REMINDER, '始めた言語（ja）に戻した最初の要求には、直前の返事が英語だったので日本語の注意が付く');
  assert.match(contents(back).at(-1)!, /^three/u);
  assert.doesNotMatch(contents(back).slice(0, -1).join('\n'), /System note|システムからの注意/u, '前の発言には付けない');
  const backAgain = await say(s, 'c1', 'four');
  assert.deepEqual(contents(backAgain).slice(-1), ['four'], '直前の返事が日本語になれば、また付かない');
  assert.equal(s.app.kv.get(replyLanguageKey('c1')), 'ja');
  assert.deepEqual(stored('c1').slice(-4), ['three', 'ok', 'four', 'ok']);

  await s.setLanguage('en');
  const fresh = await say(s, 'c2', 'Hello');
  assert.deepEqual(contents(fresh), ['Hello'], 'en で始めた会話は、変えるまで付かない');
  await s.setLanguage('ja');
  const switched = await say(s, 'c2', 'こんにちは');
  assert.match(contents(switched).at(-1)!, JA_REMINDER, 'en で始まった会話を ja にした次の要求には日本語の注意が付く');
  assert.deepEqual(stored('c2'), ['Hello', 'ok', 'こんにちは', 'ok']);
});

test('返事の言語の注意: en で始めた会話を ja に変え、また en に戻したときも、直前の返事の言語とずれる間は付く', async t => {
  const s = await startApp(t, { language: 'en' });
  const contents = (call: ModelRequest) => call.messages.map(m => m.content);
  const first = await say(s, 'c3', 'Hello');
  assert.deepEqual(contents(first), ['Hello'], 'en で始めた会話は、変えるまで付かない');
  await s.setLanguage('ja');
  const toJa = await say(s, 'c3', 'こんにちは');
  assert.match(contents(toJa).at(-1)!, JA_REMINDER);
  const toJaAgain = await say(s, 'c3', 'もう一度');
  assert.match(contents(toJaAgain).at(-1)!, JA_REMINDER, '始めた言語と違う間は、毎回付く');
  await s.setLanguage('en');
  const backToEn = await say(s, 'c3', 'Hi');
  assert.match(contents(backToEn).at(-1)!, EN_REMINDER, '始めた言語に戻した最初の要求には、直前の返事が日本語だったので英語の注意が付く');
  const backAgain = await say(s, 'c3', 'again');
  assert.deepEqual(contents(backAgain).slice(-1), ['again'], '直前の返事が英語になれば、また付かない');
  assert.deepEqual(s.app.conversations.messages('c3').map(m => m.text), ['Hello', 'ok', 'こんにちは', 'ok', 'もう一度', 'ok', 'Hi', 'ok', 'again', 'ok']);
});

test('返事の言語の注意: 道具を何度も呼ぶ1回の実行では、最後の返事までモデルを呼ぶたびに付き、実行が成功してから記録する', async t => {
  const s = await startApp(t);
  const toolCall = (n: number): Script => async function* () {
    yield { type: 'tool_call', call: { id: `call_${n}`, name: 'file_write', arguments: { path: `note${n}.md`, content: String(n) } } };
    yield { type: 'done', stop: 'tool_use' };
  };
  const lastUser = (call: ModelRequest) => call.messages.filter(m => m.role === 'user').at(-1)!.content as string;

  await say(s, 'c1', 'one');
  await s.setLanguage('en');
  await say(s, 'c1', 'Hello');
  assert.equal(s.app.kv.get(replyLanguageKey('c1')), 'en');
  await s.setLanguage('ja');

  s.adapter().scripts.push(fail(new ProviderError('auth', 'bad key', { retryable: false })));
  const failedOutcome = s.app.engine.send('c1', 'oops');
  assert.ok(failedOutcome.ok);
  assert.equal((await s.app.engine.wait(failedOutcome.runId))?.ok, false);
  assert.equal(s.app.kv.get(replyLanguageKey('c1')), 'en', '失敗した実行は、返事の言語を記録しない');

  const before = s.adapter().calls.length;
  s.adapter().scripts.push(toolCall(1), toolCall(2), reply('done'));
  const outcome = s.app.engine.send('c1', 'three');
  assert.ok(outcome.ok);
  assert.ok((await s.app.engine.wait(outcome.runId))?.ok);
  const run = s.adapter().calls.slice(before);
  assert.equal(run.length, 3, '道具を2回呼んでから返事を書く3回のモデル呼び出し');
  assert.deepEqual(run.map(call => call.messages.filter(m => m.role === 'tool').length), [0, 1, 2], '2 回目以降は道具の結果が履歴に入っている');
  for (const [i, call] of run.entries()) {
    assert.match(lastUser(call), JA_REMINDER, `${i + 1} 回目のモデル呼び出しにも、直前の返事が英語だったことへの注意が付く`);
    assert.match(lastUser(call), /^three/u);
  }
  assert.equal(s.app.kv.get(replyLanguageKey('c1')), 'ja', '成功して終わったときに、日本語で返したと記録する');

  const next = await say(s, 'c1', 'four');
  assert.equal(lastUser(next), 'four', '次の実行には付かない');
  assert.doesNotMatch(JSON.stringify(s.app.conversations.messages('c1').map(m => m.text)), /システムからの注意/u, '保存された発言に注意は入らない');
});

test('返事の言語の注意: 言語を記録していない前からある会話は、日本語で始まったものとして扱う', async t => {
  const s = await startApp(t);
  s.app.conversations.append('legacy', { role: 'user', content: 'old question' });
  s.app.conversations.append('legacy', { role: 'assistant', content: 'old answer' });
  assert.ok(s.app.conversations.setSnapshotOnce('legacy', '# Clive の基本ルール', 'hash'));
  assert.equal(s.app.kv.get(snapshotLanguageKey('legacy')), undefined);

  const ja = await say(s, 'legacy', 'new question');
  assert.deepEqual(ja.messages.map(m => m.content), ['old question', 'old answer', 'new question']);
  await s.setLanguage('en');
  const en = await say(s, 'legacy', 'another');
  assert.match(en.messages.at(-1)!.content as string, EN_REMINDER);
});

test('返事の言語の注意: 新しい会話は、始めたときの言語を記録する', async t => {
  const s = await startApp(t, { language: 'en' });
  await say(s, 'c1', 'Hello');
  assert.equal(s.app.kv.get(snapshotLanguageKey('c1')), 'en');
  await s.setLanguage('ja');
  await say(s, 'c2', 'こんにちは');
  assert.equal(s.app.kv.get(snapshotLanguageKey('c2')), 'ja');
});

// ── 実際の流れ ──

test('裏で動くタスクの実行の指示が、language に合わせて渡る', async t => {
  const s = await startApp(t, { language: 'en' });
  s.app.tasks.create({ title: 'Check the report', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(reply('thinking it over'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const request = s.adapter().calls[0]!;
  const first = request.messages[0]!;
  assert.match(first.role === 'user' ? first.content : '', /^\[Task run\] You are now working on a task/u);
  assert.match(request.system.frozen, /^# Clive's basic rules/u);
  assert.ok(request.system.dynamic.includes(EN_DIRECTIVE));
});

test('裏で動く振り返りの指示が、language に合わせて渡る（日本語の会話の記録は、そのまま材料として渡る）', async t => {
  const s = await startApp(t, { language: 'en' });
  await s.app.worker.tick();
  await say(s, 'c1', '今日は渋谷で打ち合わせ');
  s.app.reviews.enqueue('manual', 'manual:c1', { conversationId: 'c1' });
  s.adapter().scripts.push(reply('No changes'));
  assert.equal(await s.app.worker.tick(), 'ran');
  const request = s.adapter().calls.at(-1)!;
  const prompt = String(request.messages.at(-1)?.content);
  assert.match(prompt, /^\[Review\] Trigger: Manual\./u);
  assert.match(prompt, /# Policy\n- Keep only/u);
  assert.match(prompt, /\[User\] 今日は渋谷で打ち合わせ/u, '会話の記録は訳さずに渡す');
  assert.ok(request.system.dynamic.includes(EN_DIRECTIVE));
});

test('HTTP の経路: 画面と同じ API で言語を en に保存すると、同じ会話の次の送信（モデルへの実際の HTTP リクエスト）が英語の指示になる', async t => {
  const model = await fakeServer((req, _body, res) => {
    if (req.url?.endsWith('/chat/completions')) sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'x' }] })); }
  });
  t.after(() => model.close());
  const p = resolvePaths(tempDir(t));
  mkdirSync(p.data, { recursive: true });
  const config = defaultConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', server: 'generic', baseUrl: `${model.url}/v1`, maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 1024, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  writeFileSync(p.config, JSON.stringify(config));
  const app = new App({ paths: p, databasePath: ':memory:', log: () => undefined, workerTimers: false });
  t.after(() => app.close());
  await app.status.probeAll(app.config());
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); });
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  const api = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, { ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Origin: origin } });
  const chatRequests = () => model.requests.filter(r => r.path.endsWith('/chat/completions'));
  const lastSent = () => chatRequests().at(-1)!.body.messages.at(-1).content as string;
  const speak = async (id: string, text: string) => {
    const before = chatRequests().length;
    const sent = await api(`/api/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
    assert.equal(sent.status, 202);
    const until = Date.now() + 3000;
    while (chatRequests().length === before) {
      if (Date.now() > until) throw new Error('モデルへのリクエストが来ませんでした');
      await new Promise(r => setTimeout(r, 5));
    }
    await app.engine.wait(((await sent.clone().json()) as any).runId);
    return chatRequests().at(-1)!.body.messages[0].content as string;
  };

  const first = await speak('c1', 'こんにちは');
  assert.ok(first.startsWith('# Clive の基本ルール'));
  assert.ok(first.includes(JA_DIRECTIVE) && !first.includes(EN_DIRECTIVE));
  assert.equal(lastSent(), 'こんにちは', '言語を変えていない会話の最後の発言には何も足さない');

  const view = await (await api('/api/settings')).json() as any;
  assert.equal((await api('/api/settings', { method: 'PUT', body: JSON.stringify({ config: { ...view.config, language: 'en' } }) })).status, 200);

  const second = await speak('c1', 'Hello again');
  assert.ok(second.includes(EN_DIRECTIVE) && !second.includes(JA_DIRECTIVE), '同じ会話の次の送信から英語の指示');
  assert.ok(second.startsWith('# Clive の基本ルール'), '会話の途中では固定の system（日本語のルール）は変えない');
  assert.match(lastSent(), /^Hello again\n\n\[System note: the reply language of this conversation is now English\. /u, '言語を変えた会話の最後の発言にだけ一行の注意が付く');
  assert.equal(((await (await api('/api/conversations/c1/messages')).json()) as any).messages.at(-2).text, 'Hello again', '画面から見える発言には注意が入らない');

  const fresh = await speak('c2', 'Hello');
  assert.ok(fresh.startsWith("# Clive's basic rules"), '新しい会話は英語のルールで始まる');
  assert.ok(fresh.includes(EN_DIRECTIVE));
  assert.equal(lastSent(), 'Hello', 'en で始めた新しい会話には何も足さない');

  // 日本語に戻したあと: 直前の返事が英語なので、最初の要求にだけ日本語の注意が付く（ルールは日本語のままでも、英語の履歴に引きずられないように）
  const viewBefore = await (await api('/api/settings')).json() as any;
  assert.equal((await api('/api/settings', { method: 'PUT', body: JSON.stringify({ config: { ...viewBefore.config, language: 'ja' } }) })).status, 200);
  const backToJa = await speak('c1', '👋');
  assert.ok(backToJa.includes(JA_DIRECTIVE) && !backToJa.includes(EN_DIRECTIVE));
  assert.match(lastSent(), /^👋\n\n\[システムからの注意: この会話の返事の言語は日本語になりました。/u, '英語で返した直後に日本語へ戻すと、最初の要求にだけ日本語の注意が付く');
  await speak('c1', '👋');
  assert.equal(lastSent(), '👋', '日本語で返したあとは、始めた言語どうしなので付かない');
});
