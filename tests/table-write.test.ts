import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { xlsxText } from '../src/shared/office-text.ts';
import { openZip } from '../src/shared/zip.ts';
import { ApprovalBroker, approvalPublic } from '../src/tools/approvals.ts';
import { docRead } from '../src/tools/builtin/docs.ts';
import { TABLE_MAX_TOTAL_CHARS, tableWrite } from '../src/tools/builtin/tables.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// tests/tools.test.ts の setup を写したもの。registry には tableWrite だけ
function setup(t: { after: (fn: () => void) => void }, mutate: (c: AppConfig) => void = () => undefined) {
  const paths: AppPaths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(join(paths.data, 'reference'), { recursive: true });
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }, { path: 'reference', mode: 'read' }];
  mutate(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const events: RunEvent[] = [];
  const approvals = new ApprovalBroker(db, e => events.push(e.type === 'requested'
    ? { type: 'approval.requested', runId: e.view.runId, conversationId: e.view.conversationId, approval: approvalPublic(e.view) }
    : { type: 'approval.resolved', runId: e.view.runId, conversationId: e.view.conversationId, approvalId: e.view.id, outcome: e.outcome }));
  const registry = new ToolRegistry().register(tableWrite);
  const policy = buildPolicy(parsed, paths);
  const controller = new AbortController();
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: controller.signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const call = (args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name: 'table_write', arguments: args }, c, { registry, approvals, db, emit: e => events.push(e), conversationAutoRead: () => false });
  return { paths, ctx, call, approvals, events };
}

async function decideNext(s: ReturnType<typeof setup>, decision: 'once' | 'conversation' | 'folder' | 'deny') {
  for (let i = 0; i < 200 && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
  const pending = s.approvals.pending()[0];
  assert.ok(pending, '承認の依頼が来ていない');
  s.approvals.decide(pending.id, decision);
  return pending;
}

const JAPANESE = /[\u3000-\u9fff\uff00-\uffef]/u;
const BOM = '\uFEFF';
const nulls = (rows: number, cols: number): null[][] => Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
const read = (s: ReturnType<typeof setup>, name: string): Buffer => readFileSync(join(s.paths.workspace, name));
const listing = (s: ReturnType<typeof setup>): string[] => readdirSync(s.paths.workspace);

test('table_write: CSV は BOM 付きで書き、式に見える文字は先頭に \' を付けて、そのことを知らせる', async t => {
  const s = setup(t);
  const out = await s.call({ path: 'out/a.csv', rows: [['名前', '数'], ['=cmd|"/c calc"!A0', 1]] });
  assert.equal(out.decision, 'allow');
  assert.ok(!out.output.isError, out.output.content);
  assert.equal(out.output.content, '表を書きました: out/a.csv（2 行・2 列）\n[式として動かないよう、1 個のセルを文字として書きました]');
  const bytes = read(s, 'out/a.csv');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.toString('utf8'), `${BOM}名前,数\r\n"'=cmd|""/c calc""!A0",1\r\n`);
});

test('table_write: 数は数のまま、文字の "-5" と全角の式の始まりは無害化し、null は空にする', async t => {
  const s = setup(t);
  const out = await s.call({ path: 'n.csv', rows: [['-5', -5, 1.5, null, 'a,b', '\uFF1D1', '+1', '@x', 'ok']] });
  assert.ok(!out.output.isError, out.output.content);
  assert.equal(read(s, 'n.csv').toString('utf8'), `${BOM}'-5,-5,1.5,,"a,b",'\uFF1D1,'+1,'@x,ok\r\n`);
  assert.match(out.output.content, /\[式として動かないよう、4 個のセルを文字として書きました\]$/u);
  const plain = await s.call({ path: 'plain.csv', rows: [['a', 1]] });
  assert.equal(plain.output.content, '表を書きました: plain.csv（1 行・2 列）');
});

test('table_write: xlsx は式を書かず、文字は変えずに文字のセルの書式を付け、書いた形が読み戻せる', async t => {
  const s = setup(t);
  const out = await s.call({ path: 'a.xlsx', rows: [['a', 1], ['=1+1', null, 'x']] });
  assert.ok(!out.output.isError, out.output.content);
  assert.equal(out.output.content, '表を書きました: a.xlsx（2 行・3 列）\n[式として動かないよう、1 個のセルを文字として書きました]');
  const opened = openZip(read(s, 'a.xlsx'));
  assert.equal(opened.ok, true);
  const text = xlsxText(opened.zip, 'ja');
  assert.equal(text.ok, true);
  assert.ok(text.ok && text.text.includes('a\t1'));
  assert.ok(text.ok && text.text.includes('=1+1\t\tx'));
  const sheet = opened.zip.read('xl/worksheets/sheet1.xml');
  assert.ok(sheet.ok);
  const xml = sheet.data.toString('utf8');
  assert.ok(!xml.includes('<f>'), '式の要素を書かない');
  assert.ok(xml.includes('s="1"'), '式に見える文字のセルに quotePrefix の書式');
  assert.ok(!xml.includes("'=1+1"), 'xlsx には \' を足さない');
  const back = await docRead.execute({ path: 'a.xlsx' }, s.ctx);
  assert.ok(back.content.endsWith('<<<\n[シート: Sheet1]\na\t1\n=1+1\t\tx\n>>>'), back.content);
});

test('table_write: 既にあるファイルは overwrite: true のときだけ上書きし、そうでなければ中身を変えない', async t => {
  const s = setup(t);
  writeFileSync(join(s.paths.workspace, 'a.csv'), 'old');
  writeFileSync(join(s.paths.workspace, 'a.xlsx'), 'old');
  for (const args of [{ path: 'a.csv', rows: [['new']] }, { path: 'a.csv', rows: [['new']], overwrite: false }, { path: 'a.xlsx', rows: [['new']] }]) {
    const refused = await s.call(args);
    assert.equal(refused.decision, 'allow');
    assert.equal(refused.output.isError, true);
    assert.equal(refused.output.content, `既にあります: ${args.path}`);
  }
  assert.equal(read(s, 'a.csv').toString('utf8'), 'old');
  assert.equal(read(s, 'a.xlsx').toString('utf8'), 'old');
  const over = await s.call({ path: 'a.csv', rows: [['new']], overwrite: true });
  assert.ok(!over.output.isError, over.output.content);
  assert.equal(read(s, 'a.csv').toString('utf8'), `${BOM}new\r\n`);
  const overX = await s.call({ path: 'a.xlsx', rows: [['new']], overwrite: true });
  assert.ok(!overX.output.isError, overX.output.content);
  assert.equal(read(s, 'a.xlsx').subarray(0, 2).toString('latin1'), 'PK');
  assert.deepEqual(listing(s).filter(name => name.endsWith('.tmp')), [], '一時ファイルが残らない');
});

test('table_write: execute を直接呼んでも、overwrite なしでは既にあるファイルを変えない。フォルダには書かない', async t => {
  const s = setup(t);
  writeFileSync(join(s.paths.workspace, 'a.csv'), 'old');
  mkdirSync(join(s.paths.workspace, 'd.csv'));
  const refused = await tableWrite.execute({ path: 'a.csv', rows: [['new']] }, s.ctx);
  assert.equal(refused.isError, true);
  assert.equal(read(s, 'a.csv').toString('utf8'), 'old');
  for (const overwrite of [undefined, true]) {
    const dir = await tableWrite.execute({ path: 'd.csv', rows: [['new']], ...(overwrite === undefined ? {} : { overwrite }) }, s.ctx);
    assert.equal(dir.isError, true);
    assert.equal(dir.content, 'フォルダです: d.csv');
  }
});

test('table_write: 確かめたあとに別の誰かが作ったファイルは、overwrite なしでは黙って置き換えず、既にあると答える（csv も xlsx も）', async t => {
  const s = setup(t);
  const statOriginal = fs.statSync;
  const writeOriginal = fs.writeFileSync;
  const raced = new Set<string>();
  const spy = mock.method(fs, 'statSync', ((path: fs.PathLike, ...rest: unknown[]) => {
    const found = (statOriginal as (...args: unknown[]) => unknown)(path, ...rest);
    const name = String(path);
    if (found === undefined && /race\.(csv|xlsx)$/u.test(name) && (rest[0] as { throwIfNoEntry?: boolean } | undefined)?.throwIfNoEntry === false && !raced.has(name)) {
      raced.add(name);
      (writeOriginal as (...args: unknown[]) => void)(name, 'racer');
    }
    return found;
  }) as typeof fs.statSync);
  syncBuiltinESMExports();
  try {
    for (const args of [{ path: 'race.csv', rows: [['new']] }, { path: 'race.xlsx', rows: [['new']], overwrite: false }]) {
      const out = await s.call(args);
      assert.equal(out.output.isError, true, args.path);
      assert.equal(out.output.content, `既にあります: ${args.path}`);
      assert.equal(read(s, args.path).toString('utf8'), 'racer', `${args.path}: 確かめたあとに作られたファイルを置き換えてしまった`);
    }
    assert.equal(raced.size, 2, '確かめたあとにファイルを作る細工が両方で働いた');
    assert.deepEqual(listing(s).filter(name => name.endsWith('.tmp')), [], '一時ファイルが残らない');
    const direct = await tableWrite.execute({ path: 'race.csv', rows: [['new']] }, s.ctx);
    assert.equal(direct.isError, true);
    assert.equal(read(s, 'race.csv').toString('utf8'), 'racer');
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('table_write: overwrite: true なら、確かめたあとに作られたファイルも置き換える（今までどおり）', async t => {
  const s = setup(t);
  const statOriginal = fs.statSync;
  const writeOriginal = fs.writeFileSync;
  const spy = mock.method(fs, 'statSync', ((path: fs.PathLike, ...rest: unknown[]) => {
    const found = (statOriginal as (...args: unknown[]) => unknown)(path, ...rest);
    if (found === undefined && String(path).endsWith('race.csv') && (rest[0] as { throwIfNoEntry?: boolean } | undefined)?.throwIfNoEntry === false) (writeOriginal as (...args: unknown[]) => void)(String(path), 'racer');
    return found;
  }) as typeof fs.statSync);
  syncBuiltinESMExports();
  try {
    const out = await s.call({ path: 'race.csv', rows: [['new']], overwrite: true });
    assert.ok(!out.output.isError, out.output.content);
    assert.equal(read(s, 'race.csv').toString('utf8'), `${BOM}new\r\n`);
    assert.deepEqual(listing(s).filter(name => name.endsWith('.tmp')), []);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('table_write: 書ける形は拡張子だけで決まり、.csv .xlsx 以外（紛らわしい名前も）は何も書かない。大文字は書ける', async t => {
  const s = setup(t);
  const names = ['a.txt', 'a.csv.exe', 'noext', 'a.csv.', 'a.csv ', '.csv', 'a.xls', 'a.csv::$DATA', 'a.xlsx.bak', 'dir/a.json'];
  for (const path of names) {
    const out = await s.call({ path, rows: [['a']] });
    assert.equal(out.decision, 'deny', path);
    assert.equal(out.output.isError, true, path);
    assert.match(out.output.content, /実行しませんでした/u, path);
  }
  assert.match((await s.call({ path: 'a.txt', rows: [['a']] })).output.content, /書ける形は \.csv と \.xlsx だけです: a\.txt/u);
  if (process.platform === 'win32') assert.equal((await s.call({ path: 'a.txt:x.csv', rows: [['a']] })).decision, 'deny', 'Windows の別のデータの流れ');
  assert.deepEqual(listing(s), [], '何も書かれていない');
  const direct = await tableWrite.execute({ path: 'a.txt', rows: [['a']] }, s.ctx);
  assert.equal(direct.isError, true);
  assert.match(direct.content, /書ける形は/u);
  assert.deepEqual(listing(s), []);
  assert.ok(!(await s.call({ path: 'A.CSV', rows: [['a']] })).output.isError);
  assert.ok(!(await s.call({ path: 'B.XLSX', rows: [['a']] })).output.isError);
  assert.equal(read(s, 'A.CSV').toString('utf8'), `${BOM}a\r\n`);
  assert.equal(read(s, 'B.XLSX').subarray(0, 2).toString('latin1'), 'PK');
});

test('table_write: 許可フォルダの外・読むだけのフォルダ・秘密の場所は書かず、.git とスキルのフォルダは確かめる', async t => {
  const s = setup(t);
  const refused = [
    '../x.csv', join(s.paths.data, 'outside.csv'), join(s.paths.data, 'reference', 'x.csv'), join(s.paths.data, 'reference', 'x.xlsx'),
    'secrets/a.csv', 'secrets/a.xlsx', '~/x.csv',
  ];
  for (const path of refused) {
    const out = await s.call({ path, rows: [['a']] });
    assert.equal(out.decision, 'deny', path);
    assert.match(out.output.content, /実行しませんでした/u, path);
  }
  assert.equal(existsSync(join(s.paths.data, 'outside.csv')), false);
  assert.equal(existsSync(join(s.paths.data, 'x.csv')), false);
  assert.equal(existsSync(join(s.paths.data, 'reference', 'x.csv')), false);
  assert.equal(existsSync(join(s.paths.workspace, 'secrets')), false);

  for (const path of ['.git/x.csv', 'skills/evil.csv']) {
    const pending = s.call({ path, rows: [['a']] });
    const request = await decideNext(s, 'deny');
    assert.equal(request.onceOnly, path.startsWith('.git'), path);
    assert.match((await pending).output.content, /拒否しました/u, path);
    assert.equal(existsSync(join(s.paths.workspace, path)), false, `${path} に書かれてしまった`);
  }

  const outside = await tableWrite.execute({ path: '../x.csv', rows: [['a']] }, s.ctx);
  assert.equal(outside.isError, true);
  assert.equal(existsSync(join(s.paths.data, 'x.csv')), false, 'execute を直接呼んでも外には書かない');
  const readonly = await tableWrite.execute({ path: join(s.paths.data, 'reference', 'x.csv'), rows: [['a']] }, s.ctx);
  assert.equal(readonly.isError, true);
  assert.equal(existsSync(join(s.paths.data, 'reference', 'x.csv')), false);
});

test('table_write: 作業フォルダの中から外を指すリンクの先には書かない', async t => {
  const s = setup(t);
  const target = join(s.paths.data, 'outside-dir');
  mkdirSync(target);
  try { symlinkSync(target, join(s.paths.workspace, 'link'), 'junction'); } catch { t.skip('シンボリックリンクを作れない環境'); return; }
  const out = await s.call({ path: 'link/x.csv', rows: [['a']] });
  assert.equal(out.decision, 'deny');
  assert.equal(existsSync(join(target, 'x.csv')), false);
});

test('table_write: フォルダを作った直後にリンクへ差し替えられても、確かめ直して外には書かない', async t => {
  const s = setup(t);
  const target = join(s.paths.data, 'outside-dir');
  mkdirSync(target);
  const original = fs.mkdirSync;
  let swapped = false;
  const spy = mock.method(fs, 'mkdirSync', ((path: fs.PathLike, ...rest: unknown[]) => {
    const made = (original as (...args: unknown[]) => unknown)(path, ...rest);
    if (String(path).endsWith('swap')) {
      rmdirSync(path);
      try { symlinkSync(target, String(path), 'junction'); swapped = true; } catch { }
    }
    return made;
  }) as typeof fs.mkdirSync);
  syncBuiltinESMExports();
  try {
    const out = await s.call({ path: 'swap/x.csv', rows: [['a']] });
    if (!swapped) { t.skip('シンボリックリンクを作れない環境'); return; }
    assert.equal(out.output.isError, true);
    assert.match(out.output.content, /書き込み先の確認に失敗しました/u);
    assert.equal(existsSync(join(target, 'x.csv')), false, '差し替えたリンクの先に書かれてしまった');
    assert.equal(spy.mock.callCount() > 0, true);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('table_write: 引数の形が正しくなければ実行せずに直させる（rows が空・列が多すぎる・型違い・format などの余計な項目）', async t => {
  const s = setup(t);
  const bad: unknown[] = [
    { path: 'a.csv', rows: [] },
    { path: 'a.csv', rows: [Array.from({ length: 16385 }, () => null)] },
    { path: 'a.csv', rows: [[{}]] },
    { path: 'a.csv', rows: [[true]] },
    { path: 'a.csv', rows: [[['nested']]] },
    { path: 'a.csv', rows: [['a'], 'b'] },
    { path: 'a.csv', rows: [['x'.repeat(32768)]] },
    { path: 'a.csv', rows: [[Infinity]] },
    { path: 'a.csv', rows: [[Number.NaN]] },
    { path: 'a.csv', rows: 'a' },
    { path: 'a.csv' },
    { path: '', rows: [['a']] },
    { path: 'a.csv', rows: [['a']], format: 'csv' },
    { path: 'a.csv', rows: [['a']], overwrite: 'yes' },
  ];
  for (const args of bad) {
    const out = await s.call(args);
    assert.equal(out.invalidArguments, true, JSON.stringify(args).slice(0, 80));
    assert.match(out.output.content, /引数の形が正しくありません/u);
  }
  assert.deepEqual(listing(s), []);
  const edge = await s.call({ path: 'edge.csv', rows: [nulls(1, 16384)[0], ['x'.repeat(32767)]] });
  assert.ok(!edge.output.isError, edge.output.content);
  assert.match(edge.output.content, /^表を書きました: edge\.csv（2 行・16384 列）/u);
});

test('table_write: セルは 10 万個まで。超えたら書かない（道具の呼び出しでも、execute を直接呼んでも）', async t => {
  const s = setup(t);
  const over = await s.call({ path: 'big.csv', rows: nulls(1001, 100) });
  assert.equal(over.decision, 'deny');
  assert.equal(over.output.isError, true);
  assert.match(over.output.content, /セルが多すぎます（100,100 個。100,000 個まで）/u);
  const overX = await s.call({ path: 'big.xlsx', rows: nulls(1001, 100) });
  assert.match(overX.output.content, /セルが多すぎます/u);
  const direct = await tableWrite.execute({ path: 'big.csv', rows: [Array.from({ length: 100_001 }, () => null)] }, s.ctx);
  assert.equal(direct.isError, true);
  assert.equal(direct.content, 'セルが多すぎます（100,001 個。100,000 個まで）');
  assert.deepEqual(listing(s), []);
  const edge = await s.call({ path: 'edge.csv', rows: nulls(1000, 100) });
  assert.ok(!edge.output.isError, edge.output.content);
  assert.match(edge.output.content, /^表を書きました: edge\.csv（1000 行・100 列）/u);
});

test('table_write: 文字の合計は 500 万文字まで。1 セル 32,767 文字 × 多数でも、超えたら書かない', async t => {
  const s = setup(t);
  assert.equal(TABLE_MAX_TOTAL_CHARS, 5_000_000);
  const cell = 'a'.repeat(32767);
  const rows = (count: number): string[][] => Array.from({ length: count }, () => [cell]);
  const over = await s.call({ path: 'big.csv', rows: rows(153) });
  assert.equal(over.decision, 'deny');
  assert.match(over.output.content, /文字の合計が多すぎます（5,013,351 文字。5,000,000 文字まで）/u);
  assert.doesNotMatch(over.output.content, /失敗しました|characters/u);
  const direct = await tableWrite.execute({ path: 'big.csv', rows: rows(153) }, s.ctx);
  assert.equal(direct.isError, true);
  assert.equal(direct.content, '文字の合計が多すぎます（5,013,351 文字。5,000,000 文字まで）');
  assert.deepEqual(listing(s), []);
  const within = await s.call({ path: 'ok.csv', rows: rows(152) });
  assert.ok(!within.output.isError, within.output.content);
  assert.equal(read(s, 'ok.csv').length, 3 + 152 * (32767 + 2));
});

test('table_write: 外から読んだあとは、作業フォルダの中でも確かめになり、札には無害化した中身が出る', async t => {
  const s = setup(t);
  const ctx = { ...s.ctx, taint: { tainted: true, sources: ['web_fetch'] } };
  const args = { path: 'a.csv', rows: [['=cmd', 'x'], ['ok', 1]] };
  const denied = s.call(args, ctx);
  const request = await decideNext(s, 'deny');
  assert.match(request.reasons.join(), /よそから来た文/u);
  assert.equal(request.title, '表のファイルを書く: a.csv（2 行）');
  assert.equal(request.body, "'=cmd,x\r\nok,1\r\n");
  assert.equal((await denied).output.isError, true);
  assert.equal(existsSync(join(s.paths.workspace, 'a.csv')), false);
  const approved = s.call(args, ctx);
  await decideNext(s, 'once');
  assert.ok(!(await approved).output.isError);
  assert.equal(read(s, 'a.csv').toString('utf8'), `${BOM}'=cmd,x\r\nok,1\r\n`);
});

test('table_write: 外から読んだあとの札にはフォルダの許可が添えられ、選ぶと同じ実行の同じフォルダへの書き込みは札なしで動く', async t => {
  const s = setup(t);
  const ctx = { ...s.ctx, taint: { tainted: true, sources: ['web_fetch'] } };
  const first = s.call({ path: 'notes/a.csv', rows: [['a']] }, ctx);
  const card = await decideNext(s, 'folder');
  assert.match(card.grantFolder ?? '', /notes$/u);
  assert.ok(!(await first).output.isError);
  const second = await s.call({ path: 'notes/b.xlsx', rows: [['b']] }, ctx);
  assert.equal(second.decidedBy, 'folder-grant');
  assert.ok(!second.output.isError, second.output.content);
  assert.equal(s.approvals.pending().length, 0);
  const other = s.call({ path: 'other/c.csv', rows: [['c']] }, ctx);
  await decideNext(s, 'deny');
  assert.equal((await other).output.isError, true);
  assert.equal(existsSync(join(s.paths.workspace, 'other', 'c.csv')), false);
});

test('table_write: 札の中身は先頭 20 行・4,000 文字までで、BOM は付けず、日英で題が変わる', () => {
  const rows = Array.from({ length: 25 }, (_, i) => [`r${i}`]);
  const card = tableWrite.summarize!({ path: 'a.csv', rows }, 'ja');
  assert.equal(card.title, '表のファイルを書く: a.csv（25 行）');
  assert.equal(card.body, rows.slice(0, 20).map(r => `${r[0]}\r\n`).join(''));
  assert.ok(!card.body.includes(BOM));
  const long = tableWrite.summarize!({ path: 'a.xlsx', rows: [['-'.repeat(3000)], ['b'.repeat(3000)]] }, 'en');
  assert.equal(long.title, 'Writing a table file: a.xlsx (2 rows)');
  assert.equal(long.body.length, 4000);
  assert.ok(long.body.startsWith("'---"));
});

test('table_write: 振り返りと計画モードの会話では断る', async t => {
  const s = setup(t);
  const review = await s.call({ path: 'a.csv', rows: [['a']] }, { ...s.ctx, kind: 'review' });
  assert.equal(review.decision, 'deny');
  const plan = await s.call({ path: 'a.csv', rows: [['a']] }, { ...s.ctx, permissionMode: 'plan' });
  assert.equal(plan.decision, 'deny');
  assert.deepEqual(listing(s), []);
});

test('table_write: 道具の定義は書き込み・フォルダの許可つきで、format の引数を持たない', () => {
  assert.equal(tableWrite.name, 'table_write');
  assert.equal(tableWrite.effect, 'write');
  assert.equal(tableWrite.folderGrant, true);
  assert.deepEqual([...tableWrite.allowedIn], ['chat', 'task']);
  const properties = (tableWrite.input as unknown as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(Object.keys(properties), ['path', 'rows', 'overwrite']);
});

test('table_write: 書けずに投げられた失敗は、パスを含む message を出さずコードだけ返す', async t => {
  const s = setup(t);
  const original = fs.writeFileSync;
  const spy = mock.method(fs, 'writeFileSync', ((path: unknown, ...rest: unknown[]) => {
    if (String(path).includes('boom.csv')) throw Object.assign(new Error("EACCES: permission denied, open 'C:\\hidden-place\\boom.csv'"), { code: 'EACCES' });
    return (original as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.writeFileSync);
  syncBuiltinESMExports();
  try {
    const out = await s.call({ path: 'boom.csv', rows: [['a']] });
    assert.equal(out.output.isError, true);
    assert.equal(out.output.content, '失敗しました: EACCES');
    assert.doesNotMatch(out.output.content, /hidden-place/u);
    assert.equal(spy.mock.callCount() > 0, true);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(listing(s).some(name => name.startsWith('boom.csv')), false);
});

test('table_write: 英語の設定では、結果にも失敗の文にも日本語が出ない', async t => {
  const s = setup(t, c => { c.language = 'en'; });
  writeFileSync(join(s.paths.workspace, 'old.csv'), 'old');
  mkdirSync(join(s.paths.workspace, 'dir.csv'));
  const results = [
    await s.call({ path: 'a.csv', rows: [['name', 'count'], ['=cmd', 1]] }),
    await s.call({ path: 'a.xlsx', rows: [['name', 'count'], ['=cmd', 1]] }),
    await s.call({ path: 'plain.csv', rows: [['name', 'count']] }),
    await s.call({ path: 'old.csv', rows: [['x']] }),
    await s.call({ path: 'dir.csv', rows: [['x']], overwrite: true }),
    await s.call({ path: 'a.txt', rows: [['x']] }),
    await s.call({ path: '../x.csv', rows: [['x']] }),
    await s.call({ path: 'big.csv', rows: nulls(1001, 100) }),
    await s.call({ path: 'big.csv', rows: Array.from({ length: 153 }, () => ['a'.repeat(32767)]) }),
    await s.call({ path: 'bad.csv', rows: [] }),
  ];
  for (const r of results) {
    assert.ok(r.output.content.length > 0);
    assert.doesNotMatch(r.output.content, JAPANESE, r.output.content);
  }
  assert.equal(results[0]!.output.content, 'Wrote the table: a.csv (2 rows, 2 columns)\n[To prevent it from working as a formula, 1 cells were written as text]');
  assert.equal(results[2]!.output.content, 'Wrote the table: plain.csv (1 rows, 2 columns)');
  assert.equal(results[3]!.output.content, 'It already exists: old.csv');
  assert.equal(results[4]!.output.content, 'This is a folder: dir.csv');
  assert.match(results[5]!.output.content, /Only \.csv and \.xlsx can be written: a\.txt/u);
  assert.match(results[7]!.output.content, /There are too many cells \(100,100 cells, up to 100,000 cells\)/u);
  assert.match(results[8]!.output.content, /The table has too many characters in total \(5,013,351 characters, up to 5,000,000 characters\)/u);
  const direct = await tableWrite.execute({ path: 'e.txt', rows: [['x']] }, s.ctx);
  assert.doesNotMatch(direct.content, JAPANESE);
});
