import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { fileEdit, fileList, fileRead, fileWrite } from '../src/tools/builtin/files.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { runProcess, scrubEnv } from '../src/tools/shell/runner.ts';
import type { ToolContext } from '../src/tools/types.ts';
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
    ? { type: 'approval.requested', runId: e.view.runId, conversationId: e.view.conversationId, approval: { id: e.view.id, tool: e.view.tool, title: e.view.title, body: e.view.body, cwd: e.view.cwd, reasons: e.view.reasons, details: e.view.details, expiresAt: e.view.expiresAt } }
    : { type: 'approval.resolved', runId: e.view.runId, conversationId: e.view.conversationId, approvalId: e.view.id, outcome: e.outcome }));
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(fileList).register(shellRun);
  const policy = buildPolicy(parsed, paths);
  const controller = new AbortController();
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: controller.signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const call = (name: string, args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, { registry, approvals, db, emit: e => events.push(e) });
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

test('taint: Web や添付の内容を読んだ後は、書き込みも承認制になる', async t => {
  const s = setup(t);
  const ctx = { ...s.ctx, taint: { tainted: true, sources: ['web_fetch'] } };
  const pending = s.call('file_write', { path: 'a.md', content: 'x' }, ctx);
  const request = await decideNext(s, 'deny');
  assert.match(request.reasons.join(), /Web や添付/u);
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
