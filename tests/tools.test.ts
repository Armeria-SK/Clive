import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
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
import { resolveShell, runProcess, scrubEnv } from '../src/tools/shell/runner.ts';
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
  const cases: Array<[string, RegExp]> = [
    ['skills/evil/SKILL.md', /スキルのフォルダ/u],
    ['skills/ok/extra.md', /スキルのフォルダ/u],
    ['.git/hooks/pre-commit', /git のフォルダ/u],
    ['proj/.git/hooks/post-checkout', /git のフォルダ/u],
  ];
  if (process.platform === 'win32') cases.push(['proj/.GIT/config', /git のフォルダ/u]);
  for (const [path, reason] of cases) {
    const pending = s.call('file_write', { path, content: 'x' });
    const request = await decideNext(s, 'deny');
    assert.match(request.reasons.join(), reason, path);
    assert.equal(request.onceOnly, false, '確かめはこれまでの承認と同じ（コードを動かす確かめではない）');
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

test('V5: シェルでも、スキルのフォルダと .git への書き込み・読むだけでないコマンドは確かめになる。読むだけは通す', async t => {
  const s = setup(t);
  mkdirSync(join(s.paths.workspace, 'skills'), { recursive: true });
  const asks: Array<[string, RegExp]> = [
    ['echo x > skills/a/SKILL.md', /スキルのフォルダに書き込みます/u],
    ['Set-Content -Path .git/config -Value x', /git のフォルダ（.git）に書き込みます/u],
    ['cp notes.md skills/a/SKILL.md', /スキルのフォルダ/u],
    ['git clone https://example.com/x.git skills/x', /スキルのフォルダを指しています/u],
    ['python tool.py .git/hooks/pre-commit', /git のフォルダ/u],
  ];
  for (const [command, reason] of asks) {
    const pending = s.call('shell_run', { command });
    const request = await decideNext(s, 'deny');
    assert.match(request.reasons.join(), reason, command);
    await pending;
  }
  for (const command of ['Get-Content skills/a/SKILL.md', 'ls skills', 'git log --oneline -1', 'Get-ChildItem -Force .git']) {
    const outcome = await s.call('shell_run', { command });
    assert.equal(outcome.decision, 'allow', `${command}: ${outcome.output.content}`);
  }
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
  assert.deepEqual(resolveShell('bash').args('ls'), ['--noprofile', '--norc', '-c', 'ls']);
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
