import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { App, builtinTools } from '../src/app.ts';
import { defaultConfig } from '../src/config/store.ts';
import { resolvePaths } from '../src/paths.ts';
import { renderSkillFile } from '../src/tools/skills/store.ts';
import { createWebServer } from '../src/web/server.ts';
import type { SkillDraft, SkillSummary } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { parseRoute, routeHash } from '../web/src/routes.ts';
import {
  addDeny, addRoot, applyFolders, cloneFolders, EFFECT_LABEL, findDraft, foldersEqual, foldersFromConfig, removeDeny, removeRoot, setRootMode,
  skillDraftLink, skillFileText, skillRows, TOOL_CATALOG,
} from '../web/src/skills-meta.ts';
import { toTab } from '../web/src/tabs.ts';
import { tempDir } from './helpers.ts';

const draft = (over: Partial<SkillDraft>): SkillDraft => ({
  id: 1, name: 'a', description: 'd', body: 'b', reason: null, status: 'pending', created_at: 100, current: null, ...over,
});
const skill = (name: string, over: Partial<SkillSummary> = {}): SkillSummary => ({ name, description: `${name} の説明`, uses: 0, lastUsedAt: null, updatedAt: 0, ...over });

test('経路: スキルの深いリンク（#/skills/<名前>、#/skills/draft/<名前>）を読み、元の形に戻せる', () => {
  assert.deepEqual(parseRoute('#/skills'), { page: 'skills' });
  assert.deepEqual(parseRoute('#/skills/weekly-report'), { page: 'skills', target: { kind: 'skill', name: 'weekly-report' } });
  assert.deepEqual(parseRoute('#/skills/draft/weekly-report'), { page: 'skills', target: { kind: 'draft', name: 'weekly-report' } });
  assert.deepEqual(parseRoute('#/skills/draft'), { page: 'skills', target: { kind: 'skill', name: 'draft' } }, 'draft という名前のスキルは、スキルとして開く');
  assert.deepEqual(parseRoute('#/skills/%E3%81%82'), { page: 'skills', target: { kind: 'skill', name: 'あ' } });
  assert.deepEqual(parseRoute('#/skills/%E0%A4%A'), { page: 'skills', target: { kind: 'skill', name: '%E0%A4%A' } }, '壊れたエンコードでも落ちない');
  for (const hash of ['#/skills', '#/skills/x', '#/skills/draft/x', '#/skills/draft']) assert.equal(routeHash(parseRoute(hash)), hash);
  assert.deepEqual(parseRoute('#/review'), { page: 'review' }, '古い経路は変えない');
  assert.deepEqual(toTab('#/skills/draft/x'), { key: 'skills', hash: '#/skills/draft/x' }, 'スキルのタブは 1 つ。開いている窓の行き先を覚える');
});

test('スキルの一覧: レビュー待ちの下書きを先頭に（新しい順）、そのあとにスキルを名前順で並べる', () => {
  const rows = skillRows(
    [draft({ id: 1, name: 'old', created_at: 100 }), draft({ id: 2, name: 'new', created_at: 200, current: { description: 'x', body: 'y' } }), draft({ id: 3, name: 'done', status: 'approved' })],
    [skill('zeta', { uses: 2, lastUsedAt: 9 }), skill('alpha')],
  );
  assert.deepEqual(rows.map(r => `${r.kind}:${r.name}`), ['draft:new', 'draft:old', 'skill:alpha', 'skill:zeta']);
  assert.equal(rows[0]!.kind === 'draft' && rows[0]!.revises, true, '既存のスキルがある下書きは「修正」');
  assert.equal(rows[1]!.kind === 'draft' && rows[1]!.revises, false);
  assert.deepEqual(skillRows([], []), []);
});

test('findDraft: 同じ名前の下書きが複数あれば、承認待ちの中でいちばん新しいものを返す', () => {
  const list = [draft({ id: 1, name: 'x', created_at: 100 }), draft({ id: 2, name: 'x', created_at: 300 }), draft({ id: 3, name: 'x', created_at: 400, status: 'rejected' })];
  assert.equal(findDraft(list, 'x')?.id, 2);
  assert.equal(findDraft(list, 'nothing'), undefined);
});

test('通知のリンク: スキルの下書きの通知（#/review）は、その下書きの窓を開く。名前が読めなければ一覧へ', () => {
  assert.equal(skillDraftLink({ link: '#/review', title: 'スキルの下書きを確かめてください: weekly-report' }), '#/skills/draft/weekly-report');
  assert.equal(skillDraftLink({ link: '#/review', title: 'Review the skill draft: csv-import2' }), '#/skills/draft/csv-import2');
  assert.equal(skillDraftLink({ link: '#/review', title: 'スキルの下書きを確かめてください' }), '#/skills');
  assert.equal(skillDraftLink({ link: '#/review', title: 'スキルの下書き: Weekly Report' }), '#/skills', '名前の形でなければ一覧へ');
  assert.equal(skillDraftLink({ link: '#/tasks/t1', title: 'x: weekly-report' }), null, '#/review 以外は触らない');
  assert.equal(skillDraftLink({ link: null, title: 'x: y' }), null);
});

test('道具の一覧: 組み込みの道具 24 個と、名前・効果が一致し、説明は ja と en の辞書にある', () => {
  const server = builtinTools();
  assert.equal(TOOL_CATALOG.length, server.length);
  assert.deepEqual(TOOL_CATALOG.map(c => c.name).sort(), server.map(s => s.name).sort());
  for (const entry of TOOL_CATALOG) {
    assert.equal(entry.effect, server.find(s => s.name === entry.name)!.effect, `${entry.name} の効果`);
    assert.ok(entry.desc in ja && entry.desc in en, `${entry.desc} の辞書`);
    assert.equal(entry.desc, `tool.${entry.name}`);
    assert.ok(EFFECT_LABEL[entry.effect] in ja && EFFECT_LABEL[entry.effect] in en);
  }
  assert.equal(new Set(TOOL_CATALOG.map(c => c.name)).size, TOOL_CATALOG.length, '名前の重複なし');
});

test('skillFileText: サーバーが SKILL.md に書く形と同じ', () => {
  for (const input of [
    { name: 'weekly-report', description: '週の終わりに使う', body: '1. 集める\n2. まとめる' },
    { name: 'x', description: '改行\nを含む "説明"', body: '  本文  \n\n' },
  ]) assert.equal(skillFileText(input), renderSkillFile(input));
});

test('フォルダ: 追加は前後の空白を除き重ねず、外す・読み書きの切り替えは対象だけを変える', () => {
  const start = { roots: [{ path: 'workspace', mode: 'write' as const }], deny: ['~/.ssh'] };
  const added = addRoot(start, '  ~/Documents/notes  ', 'read');
  assert.deepEqual(added.roots, [{ path: 'workspace', mode: 'write' }, { path: '~/Documents/notes', mode: 'read' }]);
  assert.equal(addRoot(added, '~/Documents/notes', 'write'), added, '同じパスは足さない');
  assert.equal(addRoot(added, '   ', 'read'), added, '空は足さない');
  assert.deepEqual(setRootMode(added, '~/Documents/notes', 'write').roots.map(r => r.mode), ['write', 'write']);
  assert.deepEqual(setRootMode(added, 'workspace', 'read').roots.map(r => r.mode), ['read', 'read']);
  assert.deepEqual(removeRoot(added, 'workspace').roots, [{ path: '~/Documents/notes', mode: 'read' }]);
  assert.deepEqual(addDeny(start, ' ~/.aws ').deny, ['~/.ssh', '~/.aws']);
  assert.equal(addDeny(start, '~/.ssh'), start);
  assert.deepEqual(removeDeny(start, '~/.ssh').deny, []);
  assert.equal(start.roots.length, 1, '元の値は変わらない');
  assert.ok(foldersEqual(start, cloneFolders(start)));
  assert.ok(!foldersEqual(start, added));
  assert.ok(!foldersEqual(start, setRootMode(start, 'workspace', 'read')));
});

test('applyFolders: 設定の tools.roots / tools.deny だけを差し替え、ほかの項目はそのまま', () => {
  const config = { timezone: 'UTC', language: 'en', tools: { roots: [{ path: 'workspace', mode: 'write' }], deny: ['a'], outsideRoots: 'deny', shell: { enabled: true } } };
  const next = applyFolders(config, { roots: [{ path: 'x', mode: 'read' }], deny: ['b', 'c'] });
  assert.deepEqual(next.tools, { roots: [{ path: 'x', mode: 'read' }], deny: ['b', 'c'], outsideRoots: 'deny', shell: { enabled: true } });
  assert.equal(next.timezone, 'UTC');
  assert.deepEqual(config.tools.roots, [{ path: 'workspace', mode: 'write' }], '元の設定は変えない');
  assert.deepEqual(foldersFromConfig({}), { roots: [], deny: [] });
  assert.deepEqual(foldersFromConfig({ tools: { roots: [{ path: 'a', mode: 'read' }, { path: 1, mode: 'read' }, { path: 'b', mode: 'bad' }], deny: ['x', 2] } }), { roots: [{ path: 'a', mode: 'read' }], deny: ['x'] });
});

async function startServer(t: Parameters<typeof tempDir>[0]) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = defaultConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FAKE_KEY', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  writeFileSync(paths.config, JSON.stringify(config));
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, adapterOverride: provider => ({ provider, stream: async function* () { }, probe: async () => ({ status: 'ok', server: 'fake', effective: 65536, required: 0, message: '' }) as never }) });
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); app.close(); });
  const api = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, { ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Origin: origin, ...init.headers } });
  return { app, api };
}

test('画面が使う API: フォルダを保存すると config に残り、画面の読み取りで同じ値に戻る', async t => {
  const s = await startServer(t);
  const view = await (await s.api('/api/settings')).json() as any;
  const before = foldersFromConfig(view.config);
  assert.ok(before.roots.length >= 1, '既定のフォルダがある');
  const draftFolders = addDeny(addRoot(setRootMode(before, before.roots[0]!.path, 'read'), '~/Documents/notes', 'write'), '~/.kube');
  const put = await s.api('/api/settings', { method: 'PUT', body: JSON.stringify({ config: applyFolders(view.config, draftFolders) }) });
  assert.equal(put.status, 200);
  const saved = foldersFromConfig(((await put.json()) as any).config);
  assert.ok(foldersEqual(saved, draftFolders));
  const reread = foldersFromConfig(((await (await s.api('/api/settings')).json()) as any).config);
  assert.ok(foldersEqual(reread, draftFolders), '読み直しても同じ');
  assert.equal(((await (await s.api('/api/settings')).json()) as any).config.timezone, view.config.timezone, 'ほかの設定は変わらない');
  assert.equal(((await (await s.api('/api/settings')).json()) as any).restartRequired, false, 'フォルダの変更に再起動は要らない');
});

test('画面が使う API: 不正なフォルダの設定は 400 で理由を返し、保存しない', async t => {
  const s = await startServer(t);
  const view = await (await s.api('/api/settings')).json() as any;
  const bad = applyFolders(view.config, { roots: [{ path: '', mode: 'read' }], deny: [] });
  const res = await s.api('/api/settings', { method: 'PUT', body: JSON.stringify({ config: bad }) });
  assert.equal(res.status, 400);
  assert.ok(((await res.json()) as any).problems.length > 0);
  assert.ok(foldersEqual(foldersFromConfig(((await (await s.api('/api/settings')).json()) as any).config), foldersFromConfig(view.config)));
});

test('画面が使う API: スキルの下書きは current つきで返り、承認するとスキルになって一覧から消える', async t => {
  const s = await startServer(t);
  s.app.skills.write({ name: 'weekly-report', description: '古い説明', body: '古い手順' });
  s.app.skills.draft({ name: 'weekly-report', description: '新しい説明', body: '新しい手順', reason: '手順が変わった' });
  s.app.skills.draft({ name: 'csv-import', description: '取り込む', body: '1. 読む' });
  const review = await (await s.api('/api/review')).json() as any;
  const drafts = review.skillDrafts as SkillDraft[];
  assert.deepEqual(skillRows(drafts, []).map(r => `${r.kind}:${r.name}`), ['draft:csv-import', 'draft:weekly-report']);
  const revision = findDraft(drafts, 'weekly-report')!;
  assert.deepEqual(revision.current, { description: '古い説明', body: '古い手順' });
  assert.equal(findDraft(drafts, 'csv-import')!.current, null);

  assert.equal((await s.api(`/api/skill-drafts/${revision.id}/approve`, { method: 'POST', body: '{}' })).status, 200);
  const after = await (await s.api('/api/review')).json() as any;
  assert.deepEqual((after.skillDrafts as SkillDraft[]).map(d => d.name), ['csv-import']);
  const listed = (await (await s.api('/api/skills')).json() as any).skills as SkillSummary[];
  assert.deepEqual(skillRows(after.skillDrafts, listed).map(r => `${r.kind}:${r.name}`), ['draft:csv-import', 'skill:weekly-report']);
  assert.equal(listed[0]!.description, '新しい説明');
  const rejected = await s.api(`/api/skill-drafts/${findDraft(after.skillDrafts, 'csv-import')!.id}/reject`, { method: 'POST', body: '{}' });
  assert.equal(rejected.status, 200);
  assert.deepEqual(((await (await s.api('/api/review')).json()) as any).skillDrafts, []);
});

test('画面が使う API: スキルの新規・保存・削除と、名前の不正は 400', async t => {
  const s = await startServer(t);
  const put = (name: string, description: string, body: string) => s.api(`/api/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ description, body }) });
  assert.equal((await put('new-skill', 'いつ使うか', '手順').then(r => r.status)), 200);
  assert.equal((await put('Bad Name', 'x', 'y')).status, 400, '名前の形はサーバーが断る（画面はメッセージを出す）');
  const got = await (await s.api('/api/skills/new-skill')).json() as any;
  assert.equal(got.skill.body, '手順');
  assert.equal(skillFileText(got.skill), renderSkillFile(got.skill), '窓に出す SKILL.md はサーバーの形と同じ');
  assert.equal((await s.api('/api/skills/new-skill', { method: 'DELETE' })).status, 200);
  assert.equal((await s.api('/api/skills/new-skill')).status, 404);
});
