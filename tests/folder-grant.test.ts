import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { ApprovalBroker, approvalPublic } from '../src/tools/approvals.ts';
import { fileEdit, fileRead, fileWrite } from '../src/tools/builtin/files.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { webFetch } from '../src/tools/builtin/web.ts';
import { Type } from '@sinclair/typebox';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { PreCheck, ToolContext, ToolDef } from '../src/tools/types.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { en } from '../web/src/i18n/en.ts';
import { decideApproval } from '../web/src/approval-decide.ts';
import { grantFolderLabel } from '../web/src/chat-logic.ts';
import { CONVERSATION, settled, startApp, waitFor } from './app-setup.ts';
import { tempDir, testConfig, type Script } from './helpers.ts';

// 外から読んだ内容のあとの書き込みの確かめ（種類が taint だけ）に、「この返事のあいだ、このフォルダ以下への書き込みを許可」を添える。
// 覆うのは、同じ実行の中の file_write / file_edit で、それ自身の確かめも taint だけのもの。それ以外は、すべて今までどおり

function setup(t: { after: (fn: () => void) => void }, options: { tainted?: boolean; mutate?: (c: AppConfig) => void; tools?: ToolDef[] } = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }];
  options.mutate?.(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const approvals = new ApprovalBroker(db, () => undefined);
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(shellRun).register(webFetch);
  for (const tool of options.tools ?? []) registry.register(tool);
  const policy = buildPolicy(parsed, paths);
  const makeCtx = (runId: string, tainted = options.tainted !== false): ToolContext => ({
    runId, conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: tainted ? { tainted: true, sources: ['web_fetch'] } : { tainted: false, sources: [] }, log: () => undefined,
  });
  const ctx = makeCtx('r1');
  const call = (name: string, args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, { registry, approvals, db, emit: () => undefined, conversationAutoRead: () => false });
  const write = (path: string) => join(paths.workspace, path);
  return { paths, ctx, makeCtx, call, approvals, db, write };
}
type Setup = ReturnType<typeof setup>;

async function waitPending(s: Setup, label = '') {
  for (let i = 0; i < 300 && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
  const pending = s.approvals.pending()[0];
  assert.ok(pending, `承認の依頼が来ていない ${label}`);
  return pending;
}

// 札が出るはず: 札を見て、決めて、結果を返す
async function ask(s: Setup, name: string, args: unknown, decision: 'once' | 'conversation' | 'folder' | 'deny', c: ToolContext = s.ctx) {
  const running = s.call(name, args, c);
  const card = await waitPending(s, `${name} ${JSON.stringify(args)}`);
  const seen = { id: card.id, kinds: [...(card.kinds ?? [])].sort(), grantFolder: approvalPublic(card).grantFolder, everyTime: card.everyTime === true, onceOnly: card.onceOnly === true, path: card.paths?.[0]?.path };
  s.approvals.decide(card.id, decision);
  return { seen, outcome: await running };
}

// 札が出ないはず: 札なしで終わる
async function noCard(s: Setup, name: string, args: unknown, c: ToolContext = s.ctx) {
  const running = s.call(name, args, c);
  const first = await Promise.race([running.then(outcome => ({ outcome })), new Promise<{ outcome: undefined }>(resolve => setTimeout(() => resolve({ outcome: undefined }), 400))]);
  if (!first.outcome) {
    s.approvals.decide((await waitPending(s)).id, 'deny');
    await running;
    assert.fail(`${name}: 札が出た`);
  }
  return first.outcome;
}

const rows = (s: Setup) => s.db.prepare('SELECT tool, decision, decided_by, approval_id FROM tool_calls ORDER BY created_at, rowid').all() as Array<{ tool: string; decision: string; decided_by: string; approval_id: string | null }>;
const approvalRow = (s: Setup, id: string) => ({ ...(s.db.prepare('SELECT status, scope, grant_folder FROM approvals WHERE id = ?').get(id) as { status: string; scope: string; grant_folder: string | null }) });

test('外から読んだあとの file_write / file_edit の札（確かめの種類が taint だけ）には、書き込み先のフォルダの許可が添えられる', async t => {
  const s = setup(t);
  const written = await ask(s, 'file_write', { path: 'notes/a.txt', content: 'A' }, 'deny');
  assert.deepEqual(written.seen.kinds, ['taint']);
  assert.equal(written.seen.grantFolder, dirname(written.seen.path!), '書き込み先のファイルのフォルダ');
  assert.ok(written.seen.grantFolder!.endsWith('notes'));
  mkdirSync(s.write('notes'), { recursive: true });
  writeFileSync(s.write('notes/e.txt'), 'before');
  const edited = await ask(s, 'file_edit', { path: 'notes/e.txt', old: 'before', new: 'after' }, 'deny');
  assert.deepEqual(edited.seen.kinds, ['taint']);
  assert.equal(edited.seen.grantFolder, dirname(edited.seen.path!));
  // 作業フォルダの直下のファイルなら、フォルダは作業フォルダそのもの
  const top = await ask(s, 'file_write', { path: 'top.txt', content: 'T' }, 'deny');
  assert.equal(top.seen.grantFolder, dirname(top.seen.path!));
  assert.equal(existsSync(s.write('notes/a.txt')), false, '断ったので書かれていない');
});

test('フォルダの許可を選ぶと、書いて、承認の記録に scope=folder と許可したフォルダが残り、同じ実行の同じフォルダ（下も）の file_write / file_edit は札なしで動く。決めたのは folder-grant で、許可した札につながる', async t => {
  const s = setup(t);
  const first = await ask(s, 'file_write', { path: 'notes/a.txt', content: 'A' }, 'folder');
  assert.equal(first.outcome.output.isError ?? false, false);
  assert.equal(readFileSync(s.write('notes/a.txt'), 'utf8'), 'A');
  assert.deepEqual(approvalRow(s, first.seen.id), { status: 'approved', scope: 'folder', grant_folder: first.seen.grantFolder! });
  // 同じフォルダの別のファイル・書き換え・下のフォルダ
  const sibling = await noCard(s, 'file_write', { path: 'notes/b.txt', content: 'B' });
  assert.deepEqual([sibling.decision, sibling.decidedBy], ['allow', 'folder-grant']);
  assert.equal(readFileSync(s.write('notes/b.txt'), 'utf8'), 'B');
  const edit = await noCard(s, 'file_edit', { path: 'notes/b.txt', old: 'B', new: 'B2' });
  assert.equal(edit.decidedBy, 'folder-grant');
  assert.equal(readFileSync(s.write('notes/b.txt'), 'utf8'), 'B2');
  const deeper = await noCard(s, 'file_write', { path: 'notes/deep/er/c.txt', content: 'C' });
  assert.equal(deeper.decidedBy, 'folder-grant');
  assert.equal(existsSync(s.write('notes/deep/er/c.txt')), true);
  // 道具の記録は、許可した札の承認の記録につながる（実行ログで見える）
  const log = rows(s);
  assert.deepEqual(log.map(r => [r.tool, r.decision, r.decided_by]), [['file_write', 'ask', 'user'], ['file_write', 'allow', 'folder-grant'], ['file_edit', 'allow', 'folder-grant'], ['file_write', 'allow', 'folder-grant']]);
  assert.ok(log.every(r => r.approval_id === first.seen.id), '全部が許可した札の承認につながる');
  assert.equal(s.approvals.pending().length, 0);
});

test('フォルダの許可が覆わないもの: 別のフォルダ・シェル・保護された場所（人格・.git・道具の設定）・許可フォルダの外・次の実行', async t => {
  const s = setup(t);
  // 作業フォルダそのものを許可すると、保護された場所も「下」になる。それでも、保護された場所は自分の確かめがあるので覆われない
  const root = await ask(s, 'file_write', { path: 'top.txt', content: 'T' }, 'folder');
  assert.equal(root.seen.grantFolder, dirname(root.seen.path!));
  assert.equal((await noCard(s, 'file_write', { path: 'sub/x.txt', content: 'X' })).decidedBy, 'folder-grant', '比べる基準: 下のフォルダは覆われる');

  // 保護された場所
  // .gitattributes・.bashrc・.yarnrc は、作業フォルダの中のものは確かめの種類が taint だけだが、ツールの設定の名前なので、フォルダの許可は添えず、覆わない
  for (const [path, kinds] of [['SOUL.md', ['persona', 'taint']], ['.git/config', ['code', 'taint']], ['.curlrc', ['code', 'taint']], ['sub/.gitattributes', ['taint']], ['.bashrc', ['taint']], ['.yarnrc', ['taint']]] as const) {
    const protectedWrite = await ask(s, 'file_write', { path, content: 'x' }, 'deny');
    assert.deepEqual(protectedWrite.seen.kinds, [...kinds], path);
    assert.equal(protectedWrite.seen.grantFolder, null, `${path}: ほかの理由もある札には、フォルダの許可を添えない`);
    assert.equal(protectedWrite.outcome.decidedBy, 'user', path);
  }
  // シェル: 外から読んだあとの確かめ（taint だけ）が出る。フォルダの許可は添えず、覆われない
  const shell = await ask(s, 'shell_run', { command: 'echo hello' }, 'deny');
  assert.equal(shell.seen.grantFolder, null);
  assert.equal(shell.outcome.decidedBy, 'user');
  const shellWrite = await ask(s, 'shell_run', { command: 'echo x > sub/s.txt' }, 'deny');
  assert.equal(shellWrite.seen.grantFolder, null);
  assert.equal(existsSync(s.write('sub/s.txt')), false);
  // 許可フォルダの外は、確かめにもならず拒否のまま
  const outside = await s.call('file_write', { path: '../outside.txt', content: 'x' });
  assert.deepEqual([outside.decision, outside.decidedBy], ['deny', 'builtin']);
  // 次の実行は引き継がない
  const next = s.makeCtx('r2');
  const again = await ask(s, 'file_write', { path: 'sub/y.txt', content: 'Y' }, 'deny', next);
  assert.deepEqual(again.seen.kinds, ['taint']);
  assert.equal(again.outcome.decidedBy, 'user');
});

test('別のフォルダ: 許可していないフォルダは札が出て、そのフォルダ用の許可が添えられる（先のフォルダの許可は覆わない）', async t => {
  const s = setup(t);
  await ask(s, 'file_write', { path: 'notes/a.txt', content: 'A' }, 'folder');
  const other = await ask(s, 'file_write', { path: 'other/x.txt', content: 'X' }, 'folder');
  assert.ok(other.seen.grantFolder!.endsWith('other'));
  assert.equal((await noCard(s, 'file_write', { path: 'other/y.txt', content: 'Y' })).decidedBy, 'folder-grant', '2 つ目のフォルダの許可も効く');
  assert.equal((await noCard(s, 'file_write', { path: 'notes/z.txt', content: 'Z' })).decidedBy, 'folder-grant', '1 つ目も残る');
  const third = await ask(s, 'file_write', { path: 'notesX/q.txt', content: 'Q' }, 'deny');
  assert.deepEqual(third.seen.kinds, ['taint'], '名前が似ているだけのフォルダ（notes と notesX）は別');
});

test('フォルダの許可を添えない札: ほかの理由もある・毎回の確かめ・今回だけの確かめ・外から読んでいない・file 以外の道具。「フォルダ」が送られても今回だけとして扱い、許可は残らない', async t => {
  // 人格（外から読んでいなくても札）
  const plain = setup(t, { tainted: false });
  const persona = await ask(plain, 'file_write', { path: 'SOUL.md', content: 'x' }, 'folder');
  assert.deepEqual(persona.seen.kinds, ['persona']);
  assert.equal(persona.seen.grantFolder, null);
  assert.deepEqual(approvalRow(plain, persona.seen.id), { status: 'approved', scope: 'once', grant_folder: null }, '添えていない札に folder が送られても、今回だけ');
  const git = await ask(plain, 'file_write', { path: '.git/config', content: 'x' }, 'deny');
  assert.deepEqual([git.seen.kinds, git.seen.grantFolder, git.seen.onceOnly], [['code'], null, true]);
  // 外から読んでいなければ、ふつうの書き込みは札が出ない
  assert.equal((await noCard(plain, 'file_write', { path: 'notes/a.txt', content: 'A' })).decidedBy, 'builtin');
  // 方針 ask（毎回）
  const policy = setup(t, { mutate: c => { c.tools.policies = { file_write: 'ask' }; } });
  const everyTime = await ask(policy, 'file_write', { path: 'notes/a.txt', content: 'A' }, 'folder');
  assert.deepEqual([everyTime.seen.kinds, everyTime.seen.grantFolder, everyTime.seen.everyTime], [['policy', 'taint'], null, true]);
  assert.deepEqual(approvalRow(policy, everyTime.seen.id).scope, 'once');
  const secondTime = await ask(policy, 'file_write', { path: 'notes/b.txt', content: 'B' }, 'deny');
  assert.equal(secondTime.outcome.decidedBy, 'user', '送られた folder は許可として残らない');
  // 通信の道具
  const web = setup(t);
  const fetched = web.call('web_fetch', { url: 'https://example.com/?key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' });
  const card = await waitPending(web);
  assert.equal(approvalPublic(card).grantFolder, null);
  web.approvals.decide(card.id, 'deny');
  await fetched;
});

// 事前の判定が「許可フォルダの中の書き込み先 1 つ」を返す代わりの道具。file_write / file_edit 以外・今回だけの確かめ・フックの確かめでは、フォルダの許可は添えない
const standIn = (name: string, over: { effect: ToolDef['effect']; folderGrant?: boolean; onceOnly?: boolean }): ToolDef => ({
  name, description: '', input: Type.Object({ path: Type.String() }), effect: over.effect, allowedIn: ['chat', 'task'], ...(over.folderGrant ? { folderGrant: true } : {}),
  preCheck: (input: { path: string }, ctx): PreCheck => ({ decision: 'allow', reasons: [], paths: [{ input: input.path, path: join(ctx.workspace, input.path), verdict: 'in', mode: 'write' }], ...(over.onceOnly ? { onceOnly: true } : {}) }),
  execute: async () => ({ content: 'ran' }),
});

test('フォルダの許可を添えない札（道具の側の条件）: 許可の印を持たない書き込み・実行の道具、今回だけの確かめ、フックの確かめが重なった札', async t => {
  const s = setup(t, { tools: [
    standIn('stand_file', { effect: 'write', folderGrant: true }),
    standIn('stand_once', { effect: 'write', folderGrant: true, onceOnly: true }),
    standIn('stand_nomark', { effect: 'write' }),
    standIn('stand_exec', { effect: 'exec' }),
    standIn('stand_exec_marked', { effect: 'exec', folderGrant: true }),
  ] });
  // 比べる基準: 許可の印のある書き込みの道具には添えられる
  assert.ok((await ask(s, 'stand_file', { path: 'a/x.txt' }, 'deny')).seen.grantFolder, '基準');
  for (const name of ['stand_once', 'stand_nomark', 'stand_exec', 'stand_exec_marked']) {
    const seen = (await ask(s, name, { path: 'a/x.txt' }, 'deny')).seen;
    assert.deepEqual(seen.kinds, ['taint'], name);
    assert.equal(seen.grantFolder, null, name);
  }
  // 許可の印のない道具で「フォルダ」が送られても、残らない
  const sent = await ask(s, 'stand_nomark', { path: 'a/x.txt' }, 'folder');
  assert.equal(approvalRow(s, sent.seen.id).scope, 'once');
  assert.equal(s.ctx.writeGrants, undefined);
  // フックの確かめ（種類 hook）が重なると、taint だけではない
  const dir = tempDir(t);
  const hook = join(dir, 'ask.mjs');
  writeFileSync(hook, `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'ask',permissionDecisionReason:'念のため確認'}}))})`);
  const hooked = setup(t, { mutate: c => { c.tools.hooks.preToolUse = [{ matcher: 'file_write', command: [process.execPath, hook], timeoutMs: 10_000, onError: 'deny' }]; } });
  const seen = (await ask(hooked, 'file_write', { path: 'notes/a.txt', content: 'A' }, 'folder')).seen;
  assert.deepEqual(seen.kinds, ['hook', 'taint']);
  assert.equal(seen.grantFolder, null);
  assert.equal(hooked.ctx.writeGrants, undefined);
});

test('フォルダの許可は、実行の中だけ: 別の実行・別のコンテキストには渡らず、承認の記録だけが残る', async t => {
  const s = setup(t);
  await ask(s, 'file_write', { path: 'notes/a.txt', content: 'A' }, 'folder');
  assert.equal(s.ctx.writeGrants?.length, 1);
  const other = s.makeCtx('r2');
  assert.equal(other.writeGrants, undefined);
  assert.equal((await ask(s, 'file_write', { path: 'notes/b.txt', content: 'B' }, 'deny', other)).outcome.decidedBy, 'user');
});

// ── 本物のエンジンと API を通す ──

const toolCall = (name: string, args: unknown): Script => async function* () {
  yield { type: 'tool_call', call: { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args } };
  yield { type: 'done', stop: 'tool_use' };
};
const say = (text: string): Script => async function* () { yield { type: 'text', delta: text }; yield { type: 'done', stop: 'end_turn' }; };

test('エンジンと API: 添付を読んだ実行の file_write の札に grantFolder が付き、POST /api/approvals/:id の folder で同じフォルダの file_write は札なしで動く。実行ログの API にフォルダが出る。次の実行は札', async t => {
  const s = await startApp(t);
  const upload = s.app.uploads.save({ name: 'memo.txt', mime: 'text/plain', body: Buffer.from('添付の文') });
  s.adapter().scripts = [toolCall('file_write', { path: 'notes/a.txt', content: 'A' }), toolCall('file_write', { path: 'notes/b.txt', content: 'B' }), say('書きました')];
  const sent = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: '添付を読んで、メモに書いて', attachments: [upload.id] });
  await waitFor(() => s.app.approvals.pending().length === 1, '最初の札');
  const listed = await s.json('/api/approvals', 'GET');
  const card = listed.body.approvals[0];
  assert.ok(card.grantFolder.endsWith('notes'), JSON.stringify(card));
  assert.deepEqual(card.reasons.length, 1, 'taint の理由だけ');
  const decided = await s.json(`/api/approvals/${card.id}`, 'POST', { decision: 'folder' });
  assert.equal(decided.status, 200);
  await settled(s.app, sent.body.runId);
  assert.equal(readFileSync(join(s.paths.workspace, 'notes/b.txt'), 'utf8'), 'B', '2 つ目は札なしで書かれた');
  assert.equal(s.app.approvals.pending().length, 0);

  const logged = await s.json('/api/tool-calls', 'GET');
  const writes = (logged.body.toolCalls as Array<{ tool: string; decided_by: string; grantFolder: string | null; approval_id: string | null; autoReason: string | null }>).filter(r => r.tool === 'file_write');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map(w => w.decided_by).sort(), ['folder-grant', 'user']);
  assert.ok(writes.every(w => w.grantFolder === card.grantFolder && w.approval_id === card.id), '許可した札と、許したフォルダが両方の行に出る');
  assert.ok(writes.every(w => w.autoReason === null));

  // 次の実行（また添付を読む）は、札から
  const again = s.app.uploads.save({ name: 'memo2.txt', mime: 'text/plain', body: Buffer.from('別の添付') });
  s.adapter().scripts = [toolCall('file_write', { path: 'notes/c.txt', content: 'C' }), say('書きました')];
  const next = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'もう一つ', attachments: [again.id] });
  await waitFor(() => s.app.approvals.pending().length === 1, '次の実行の札');
  s.app.approvals.decide(s.app.approvals.pending()[0]!.id, 'deny');
  await settled(s.app, next.body.runId);
  assert.equal(existsSync(join(s.paths.workspace, 'notes/c.txt')), false);

  // 知らない決定は 400（folder を含む一覧で知らせる）
  const bad = await s.json('/api/approvals/none', 'POST', { decision: 'maybe' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.params.values, 'once / conversation / folder / deny');
});

test('画面: 札の「フォルダの許可」と実行ログの文が日本語・英語にあり、英語に日本語が混ざらない。決定は folder として送られる', async () => {
  const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;
  const keys = ['approval.folder', 'runs.by.folder', 'runs.grantFolder'] as const;
  for (const key of keys) assert.ok(key in ja && key in en, key);
  assert.match((ja['approval.folder'] as (folder: string) => string)('C:/work/notes'), /C:\/work\/notes/u);
  assert.match((ja['approval.folder'] as (folder: string) => string)('C:/work/notes'), /返事/u);
  assert.doesNotMatch((en['approval.folder'] as (folder: string) => string)('C:/work/notes'), CJK);
  assert.match((en['approval.folder'] as (folder: string) => string)('C:/work/notes'), /C:\/work\/notes/u);
  assert.doesNotMatch(en['runs.by.folder'] as string, CJK);
  assert.doesNotMatch((en['runs.grantFolder'] as (folder: string) => string)('C:/work/notes'), CJK);
  assert.equal(grantFolderLabel('C:\\Users\\me\\work\\notes'), '…/work/notes', '長い絶対パスは末尾の 2 つの名前だけ');
  assert.equal(grantFolderLabel('/home/me/work/notes/'), '…/work/notes');
  assert.equal(grantFolderLabel('notes'), 'notes');
  assert.equal(grantFolderLabel('work/notes'), 'work/notes');
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => { calls.push(`${String(url)} ${String(init?.body)}`); return Response.json({ ok: true }); }) as typeof fetch;
  try {
    assert.equal(await decideApproval('f1', 'folder'), true);
    assert.deepEqual(calls, ['/api/approvals/f1 {"decision":"folder"}']);
  } finally { globalThis.fetch = original; }
});
