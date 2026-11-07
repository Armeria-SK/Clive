import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { notifyOwner } from '../src/tools/builtin/notify.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

type NotifyInput = { kind: string; title: string; body?: string; link?: string; dedupKey?: string };

function setup(t: { after: (fn: () => void) => void }, mutate: (c: AppConfig) => void = () => undefined) {
  const paths: AppPaths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  mutate(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const events: RunEvent[] = [];
  const sent: NotifyInput[] = [];
  let dupe = false;
  const approvals = new ApprovalBroker(db, () => undefined);
  const registry = new ToolRegistry().register(notifyOwner);
  const policy = buildPolicy(parsed, paths);
  const controller = new AbortController();
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: controller.signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
    services: { db, memory: new MemoryStore(db), emit: () => undefined, notify: input => { sent.push(input); return dupe ? undefined : { id: sent.length }; } },
  };
  const call = (args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name: 'notify_owner', arguments: args }, c, { registry, approvals, db, emit: e => events.push(e), conversationAutoRead: () => false });
  return { ctx, call, sent, setDupe: (v: boolean) => { dupe = v; } };
}

test('notify_owner: チャットでは会話のリンクで知らせる', async t => {
  const s = setup(t);
  const r = await s.call({ title: '終わりました', body: '結果は会話に' });
  assert.equal(r.decision, 'allow');
  assert.equal(s.sent.length, 1);
  const first = s.sent[0];
  assert.ok(first);
  assert.equal(first.link, '#/c/c1');
  assert.equal(first.kind, 'info');
  assert.equal(first.title, 'Clive より: 終わりました');
  assert.equal(first.body, '結果は会話に');
  assert.equal(r.output.isError, undefined);
});

test('notify_owner: タスクではタスクのリンクになる', async t => {
  const s = setup(t);
  const ctx: ToolContext = { ...s.ctx, kind: 'task', task: { id: 't1', control: { outcome: 'none' } } };
  await s.call({ title: '区切り' }, ctx);
  const first = s.sent[0];
  assert.ok(first);
  assert.equal(first.link, '#/tasks/t1');
});

test('notify_owner: URL・リンク・種類を渡す引数は誤り', async t => {
  for (const args of [{ title: 'x', link: 'https://evil.example' }, { title: 'x', url: 'https://evil.example' }, { title: 'x', kind: 'approval_needed' }]) {
    const s = setup(t);
    const r = await s.call(args);
    assert.equal(r.decision, 'deny');
    assert.equal(s.sent.length, 0);
  }
});

test('notify_owner: 101 文字の題・1,001 文字の本文は誤り', async t => {
  for (const args of [{ title: 'あ'.repeat(101) }, { title: 'x', body: 'あ'.repeat(1001) }]) {
    const s = setup(t);
    const r = await s.call(args);
    assert.equal(r.decision, 'deny');
    assert.equal(s.sent.length, 0);
  }
});

test('notify_owner: 外を読んだあとでは題に印が付く', async t => {
  const s = setup(t);
  s.ctx.taint.tainted = true;
  await s.call({ title: '区切り' });
  const first = s.sent[0];
  assert.ok(first);
  assert.ok(first.title.startsWith('Clive より（よそから来た文を読んだあと）: '), `題 ${JSON.stringify(first.title)} が印付きで始まらない`);
});

test('notify_owner: 題の改行と向き替え文字が落ち、本文の改行は残り向き替え文字は落ちる', async t => {
  const s = setup(t);
  await s.call({ title: 'a\nb‮', body: 'x\ny‮' });
  const first = s.sent[0];
  assert.ok(first);
  assert.equal(first.title, 'Clive より: a b');
  assert.equal(first.body, 'x\ny');
});

test('notify_owner: 同じ題と本文は同じ dedupKey、違えば違う', async t => {
  const s = setup(t);
  await s.call({ title: '題', body: '本文' });
  await s.call({ title: '題', body: '本文' });
  const first = s.sent[0];
  const second = s.sent[1];
  assert.ok(first && second);
  assert.equal(first.dedupKey, second.dedupKey);
  const expected = `owner:${createHash('sha256').update('c1\n題\n本文').digest('hex').slice(0, 32)}`;
  assert.equal(first.dedupKey, expected);
  await s.call({ title: '別の題', body: '本文' });
  const third = s.sent[2];
  assert.ok(third);
  assert.notEqual(first.dedupKey, third.dedupKey);
  const other: ToolContext = { ...s.ctx, conversationId: 'c2' };
  await s.call({ title: '題', body: '本文' }, other);
  const fourth = s.sent[3];
  assert.ok(fourth);
  assert.notEqual(first.dedupKey, fourth.dedupKey);
});

test('notify_owner: 重ねたときは isError にしない', async t => {
  const s = setup(t);
  s.setDupe(true);
  const r = await s.call({ title: '題' });
  assert.equal(r.output.isError, undefined);
  assert.match(r.output.content, /重ね/);
});

test('notify_owner: 件数は数えない（30 回続けて違う題で呼ぶ）', async t => {
  const s = setup(t);
  for (let i = 0; i < 30; i++) await s.call({ title: `題 ${i}` });
  assert.equal(s.sent.length, 30);
});

test('notify_owner: services が無い実行では使えない', async t => {
  const s = setup(t);
  const ctx: ToolContext = { ...s.ctx };
  delete ctx.services;
  const r = await s.call({ title: '題' }, ctx);
  assert.equal(r.output.isError, true);
  assert.equal(s.sent.length, 0);
});

test('notify_owner: 振り返りでは使えない', async t => {
  const s = setup(t);
  const ctx: ToolContext = { ...s.ctx, kind: 'review' };
  const r = await s.call({ title: '題' }, ctx);
  assert.equal(r.decision, 'deny');
  assert.equal(s.sent.length, 0);
});

test('notify_owner: 英語の設定では英語で、日本語の文字が出ない', async t => {
  const s = setup(t, c => { c.language = 'en'; });
  const r = await s.call({ title: 'done', body: 'result in chat' });
  const sent = s.sent[0];
  assert.ok(sent);
  assert.ok(sent.title.startsWith('From Clive: '));
  assert.ok(!/[぀-ヿ一-鿿]/u.test(r.output.content));
  assert.ok(!/[぀-ヿ一-鿿]/u.test(sent.title));
});
