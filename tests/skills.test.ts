import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { defaultConfig } from '../src/config/store.ts';
import { renderSkillFile } from '../src/tools/skills/store.ts';
import type { SkillDraft, SkillSummary } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { parseRoute, routeHash } from '../web/src/routes.ts';
import {
  addRoot, broadKind, DEFAULT_DENY, EFFECT_LABEL, findDraft, foldersFromConfig, POLICY_LABEL, removeRoot, setRootMode,
  orderTools, skillDraftLink, skillFileText, skillRows, TOOL_LOOKS, toolLook, wideningChanges, type FolderDraft,
} from '../web/src/skills-meta.ts';
import { toTab } from '../web/src/tabs.ts';
import { startScreenServer } from './screen-server.ts';

// 触れないパスは、設定の画面のタグの欄が直接直す。ここは、フォルダの変更を数える試験のための小さな補助
const addDeny = (f: FolderDraft, path: string): FolderDraft => (!path.trim() || f.deny.includes(path.trim()) ? f : { ...f, deny: [...f.deny, path.trim()] });
const removeDeny = (f: FolderDraft, path: string): FolderDraft => ({ ...f, deny: f.deny.filter(p => p !== path) });
const cloneFolders = (f: FolderDraft): FolderDraft => ({ roots: f.roots.map(r => ({ ...r })), deny: [...f.deny] });
const foldersEqual = (a: FolderDraft, b: FolderDraft): boolean => JSON.stringify(a) === JSON.stringify(b);
const applyFolders = (config: Record<string, any>, folders: FolderDraft): Record<string, any> => ({ ...config, tools: { ...config.tools, roots: folders.roots, deny: folders.deny } });

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
  assert.equal(toTab('#/skills/draft/x'), null, 'スキルのページはタブにしない（タブは会話だけ）');
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

test('道具の一覧: サーバーの一覧（GET /api/tools）の 29 個すべてに、画面の絵と説明（ja と en の辞書）がある。画面にあってサーバーに無い道具も無い', async t => {
  const s = await startScreenServer(t);
  const { tools } = (await (await s.api('/api/tools')).json()) as { tools: Array<{ name: string; effect: keyof typeof EFFECT_LABEL }> };
  const server = builtinTools();
  assert.equal(tools.length, server.length);
  assert.deepEqual(tools.map(tool => tool.name).sort(), server.map(def => def.name).sort());
  assert.deepEqual(Object.keys(TOOL_LOOKS).sort(), server.map(def => def.name).sort(), '絵と説明の辞書は、サーバーの道具と同じ名前');
  for (const tool of tools) {
    const look = toolLook(tool.name);
    assert.equal(tool.effect, server.find(def => def.name === tool.name)!.effect, `${tool.name} の効果`);
    assert.ok(look.desc !== null && look.desc in ja && look.desc in en, `${tool.name} の説明の辞書`);
    assert.equal(look.desc, `tool.${tool.name}`);
    assert.ok(EFFECT_LABEL[tool.effect] in ja && EFFECT_LABEL[tool.effect] in en, `${tool.effect} の辞書`);
  }
  for (const key of Object.values(POLICY_LABEL)) assert.ok(key in ja && key in en, key);
  assert.deepEqual(toolLook('mystery_tool'), { icon: 'wrench', desc: null }, 'あとから増えた道具は、汎用の絵で説明なし');
  assert.deepEqual(toolLook('__proto__'), { icon: 'wrench', desc: null }, 'Object の予約された名前も、道具ではない');
});

test('道具の並び: 画面の辞書の順（ファイル → シェル → Web → …）。辞書に無い道具は、そのあとに名前順', () => {
  const names = (list: Array<{ name: string }>) => list.map(tool => tool.name);
  const server = builtinTools().map(def => ({ name: def.name }));
  const ordered = names(orderTools(server));
  assert.deepEqual(ordered, Object.keys(TOOL_LOOKS), 'サーバーの登録順によらず、辞書の順');
  assert.deepEqual(names(orderTools([{ name: 'zeta_new' }, { name: 'shell_run' }, { name: 'alpha_new' }, { name: 'file_read' }])), ['file_read', 'shell_run', 'alpha_new', 'zeta_new']);
  assert.deepEqual(names(orderTools([])), []);
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

test('広がる変更: 触れないパスを外す・フォルダを足す・読むだけを読み書きにする、だけを数える。狭くなる変更は数えない', () => {
  const base = { roots: [{ path: 'workspace', mode: 'write' as const }, { path: '~/ref', mode: 'read' as const }], deny: ['~/.ssh', '~/.aws', 'mine'] };
  assert.deepEqual(wideningChanges(base, cloneFolders(base)), [], '何も変えなければ無し');
  assert.deepEqual(wideningChanges(base, removeDeny(base, '~/.ssh')), [{ kind: 'deny-removed', path: '~/.ssh', builtin: true }], '初めから入っている触れないパスを外す');
  assert.deepEqual(wideningChanges(base, removeDeny(base, 'mine')), [{ kind: 'deny-removed', path: 'mine', builtin: false }], '自分で足したものを外す');
  assert.deepEqual(wideningChanges(base, addRoot(base, '~/Documents/notes', 'write')), [{ kind: 'root-added', path: '~/Documents/notes', mode: 'write', broad: null }]);
  assert.deepEqual(wideningChanges(base, addRoot(base, '~/Documents/notes', 'read')), [{ kind: 'root-added', path: '~/Documents/notes', mode: 'read', broad: null }], '読むだけでも、新しい場所に触れられる');
  assert.deepEqual(wideningChanges(base, setRootMode(base, '~/ref', 'write')), [{ kind: 'root-write', path: '~/ref', broad: null }], '読むだけ → 読み書き');
  assert.deepEqual(wideningChanges(base, addRoot(base, 'C:\\', 'read')), [{ kind: 'root-added', path: 'C:\\', mode: 'read', broad: 'filesystem' }]);
  assert.deepEqual(wideningChanges(base, setRootMode(addRoot(base, '~', 'read'), '~', 'write')), [{ kind: 'root-added', path: '~', mode: 'write', broad: 'home' }], '足してから読み書きにしても、足したことだけを 1 件で数える');
  // 狭くなる変更
  assert.deepEqual(wideningChanges(base, removeRoot(base, 'workspace')), []);
  assert.deepEqual(wideningChanges(base, setRootMode(base, 'workspace', 'read')), []);
  assert.deepEqual(wideningChanges(base, addDeny(base, '~/.kube')), []);
  // 外してから同じものを戻せば、差は無い
  assert.deepEqual(wideningChanges(base, addDeny(removeDeny(base, '~/.ssh'), '~/.ssh')), []);
  assert.deepEqual(wideningChanges(base, addRoot(removeRoot(base, 'workspace'), 'workspace', 'write')), [], '外して戻した読み書きは、元と同じ');
  // 複数は、触れないパス → フォルダの順で全部並べる
  const many = addRoot(setRootMode(removeDeny(removeDeny(base, '~/.aws'), '~/.ssh'), '~/ref', 'write'), '/', 'read');
  assert.deepEqual(wideningChanges(base, many).map(w => `${w.kind}:${w.path}`), ['deny-removed:~/.ssh', 'deny-removed:~/.aws', 'root-write:~/ref', 'root-added:/']);
});

test('広すぎる場所: ディスク全体・ドライブの直下・ホームフォルダの全体を見分け、ふつうのフォルダは見分けない', () => {
  for (const path of ['/', '//', '\\', 'C:', 'c:\\', 'D:/', 'C:\\\\']) assert.equal(broadKind(path), 'filesystem', path);
  for (const path of ['~', '~/', '~\\', '/home/alice', '/home/alice/', '/Users/bob', 'C:\\Users\\carol', 'c:/users/carol/']) assert.equal(broadKind(path), 'home', path);
  for (const path of ['workspace', '~/Documents', '/home/alice/notes', '/var/log', 'C:\\Users\\carol\\Documents', 'C:\\Windows', '', '   ']) assert.equal(broadKind(path), null, path);
});

test('広すぎる場所: . と .. を畳んで見分ける（ホームの . や、ディスク全体への ..、ホームの外への ~/..）。相対の名前は見分けない', () => {
  for (const path of ['/home/alice/.', '/home/alice/./', '/home/alice/notes/..', '/home//alice', '/Users/bob/x/y/../..', 'C:\\Users\\carol\\.', 'C:\\Users\\carol\\Documents\\..', '~/.', '~/x/..', '~/./']) {
    assert.equal(broadKind(path), 'home', path);
  }
  // /home と /Users（C:\Users）そのものと、そこへ畳まれるもの（/home/me/..）は、全員のホームをまとめて含むので、ホームの全体と同じに扱う
  for (const path of ['/home', '/home/', '/Users', '/users/', 'C:\\Users', 'c:/users/', '/home/alice/..', '/home/me/..', '/Users/bob/..', 'C:\\Users\\carol\\..']) {
    assert.equal(broadKind(path), 'home', path);
  }
  for (const path of ['/tmp/..', '/var/log/../..', '/..', '/../..', '/home/alice/../..', 'C:\\Windows\\..', 'D:/a/../', '~/..', '~/../..', '~/x/../..']) {
    assert.equal(broadKind(path), 'filesystem', path);
  }
  for (const path of ['/homework', '/Users2', '/var/home', 'workspace/..', '../..', './', 'notes/./x', '~user', '~user/..', '/home/alice/x/./y']) {
    assert.equal(broadKind(path), null, path);
  }
});

test('広すぎる場所: . と .. を使った書き方でも、フォルダを足す確認に「広すぎる」の印が付く', () => {
  const base = { roots: [], deny: [] };
  assert.deepEqual(wideningChanges(base, addRoot(base, '/home/alice/.', 'read')), [{ kind: 'root-added', path: '/home/alice/.', mode: 'read', broad: 'home' }]);
  assert.deepEqual(wideningChanges(base, addRoot(base, '/tmp/..', 'write')), [{ kind: 'root-added', path: '/tmp/..', mode: 'write', broad: 'filesystem' }]);
});

test('既定の触れないパス: 画面の DEFAULT_DENY は、サーバーの既定値と同じ', () => {
  assert.deepEqual([...DEFAULT_DENY], defaultConfig().tools.deny);
});

test('foldersFromConfig: 設定から、読める形のフォルダだけを取り出す', () => {
  assert.deepEqual(foldersFromConfig({}), { roots: [], deny: [] });
  assert.deepEqual(foldersFromConfig({ tools: { roots: [{ path: 'a', mode: 'read' }, { path: 1, mode: 'read' }, { path: 'b', mode: 'bad' }], deny: ['x', 2] } }), { roots: [{ path: 'a', mode: 'read' }], deny: ['x'] });
});

test('画面が使う API: フォルダを保存すると config に残り、画面の読み取りで同じ値に戻る', async t => {
  const s = await startScreenServer(t);
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
  const s = await startScreenServer(t);
  const view = await (await s.api('/api/settings')).json() as any;
  const bad = applyFolders(view.config, { roots: [{ path: '', mode: 'read' }], deny: [] });
  const res = await s.api('/api/settings', { method: 'PUT', body: JSON.stringify({ config: bad }) });
  assert.equal(res.status, 400);
  assert.ok(((await res.json()) as any).problems.length > 0);
  assert.ok(foldersEqual(foldersFromConfig(((await (await s.api('/api/settings')).json()) as any).config), foldersFromConfig(view.config)));
});

test('画面が使う API: スキルの下書きは current つきで返り、承認するとスキルになって一覧から消える', async t => {
  const s = await startScreenServer(t);
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
  const s = await startScreenServer(t);
  const put = (name: string, description: string, body: string) => s.api(`/api/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ description, body }) });
  assert.equal((await put('new-skill', 'いつ使うか', '手順').then(r => r.status)), 200);
  assert.equal((await put('Bad Name', 'x', 'y')).status, 400, '名前の形はサーバーが断る（画面はメッセージを出す）');
  const got = await (await s.api('/api/skills/new-skill')).json() as any;
  assert.equal(got.skill.body, '手順');
  assert.equal(skillFileText(got.skill), renderSkillFile(got.skill), '窓に出す SKILL.md はサーバーの形と同じ');
  assert.equal((await s.api('/api/skills/new-skill', { method: 'DELETE' })).status, 200);
  assert.equal((await s.api('/api/skills/new-skill')).status, 404);
});
