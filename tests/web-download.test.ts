import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { resolvePaths } from '../src/paths.ts';
import type { PermissionMode } from '../src/shared/permission-mode.ts';
import { ApprovalBroker, approvalPublic } from '../src/tools/approvals.ts';
import { webDownload } from '../src/tools/builtin/download.ts';
import { webFailure } from '../src/tools/builtin/web.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { defaultDownloadNetwork, RetrievalFailure, type DownloadNetwork, type DownloadResponse } from '../src/tools/web/public-page.ts';
import { tempDir, testConfig } from './helpers.ts';

const MiB = 1024 * 1024;
const CJK = /[\u3000-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF]/u;
const never = <T>() => new Promise<T>(() => undefined);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

const bytes = (length: number, seed: number) => Buffer.from(Array.from({ length }, (_, i) => (i * 31 + seed) & 255));

async function* chunksOf(...parts: Array<string | Uint8Array>): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === 'string' ? Buffer.from(part) : part;
}

interface Plan {
  status?: number; location?: string; contentType?: string; contentDisposition?: string; contentEncoding?: string;
  body?: () => AsyncIterable<Uint8Array>;
}

const DNS: Record<string, string[]> = {
  'files.example.com': ['93.184.216.34'],
  'private.example.com': ['10.0.0.5'],
};

function world(plans: Record<string, Plan>) {
  const opens: string[] = [];
  const network: DownloadNetwork = {
    resolve: async host => { if (!DNS[host]) throw new Error('ENOTFOUND'); return DNS[host]!; },
    open: async (url, address) => {
      opens.push(`${url.href}@${address}`);
      const plan = plans[url.href] ?? { status: 404 };
      const response: DownloadResponse = {
        status: plan.status ?? 200,
        contentType: plan.contentType ?? 'application/octet-stream',
        body: (plan.body ?? (() => chunksOf()))(),
        close: () => undefined,
      };
      if (plan.location) response.location = plan.location;
      if (plan.contentDisposition) response.contentDisposition = plan.contentDisposition;
      if (plan.contentEncoding) response.contentEncoding = plan.contentEncoding;
      return response;
    },
  };
  return { network, opens };
}

function setup(t: { after: (fn: () => void) => void }, mutate: (c: AppConfig) => void = () => undefined, network?: DownloadNetwork) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  mutate(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const events: RunEvent[] = [];
  const approvals = new ApprovalBroker(db, e => events.push(e.type === 'requested'
    ? { type: 'approval.requested', runId: e.view.runId, conversationId: e.view.conversationId, approval: approvalPublic(e.view) }
    : { type: 'approval.resolved', runId: e.view.runId, conversationId: e.view.conversationId, approvalId: e.view.id, outcome: e.outcome }));
  const registry = new ToolRegistry().register(webDownload);
  const policy = buildPolicy(parsed, paths);
  const controller = new AbortController();
  const services: NonNullable<ToolContext['services']> = { db, memory: new MemoryStore(db), emit: () => undefined, web: { ...(network ? { download: network } : {}) } };
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: controller.signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined, services,
  };
  const call = (args: unknown, c: ToolContext = ctx, mode?: PermissionMode) =>
    runToolCall({ id: `call-${Math.random()}`, name: 'web_download', arguments: args }, c, {
      registry, approvals, db, emit: e => events.push(e), conversationAutoRead: () => false, ...(mode ? { permissionMode: () => mode } : {}),
    });
  const again = (args: unknown) => {
    ctx.taint.tainted = false;
    ctx.taint.sources.length = 0;
    return call(args);
  };
  const downloads = join(ctx.workspace, 'downloads');
  const listing = () => (existsSync(downloads) ? readdirSync(downloads).sort() : []);
  const asked = async (args: unknown, c: ToolContext = ctx) => {
    const pending = call(args, c);
    for (let i = 0; i < 300 && !approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
    const view = approvals.pending()[0];
    assert.ok(view, '承認の依頼が来ていない');
    approvals.decide(view.id, 'deny');
    await pending;
    return view;
  };
  return { paths, ctx, call, again, approvals, controller, downloads, listing, asked };
}

// node:fs の関数を一時的に差し替える（ESM の名前つき import にも効かせるため syncBuiltinESMExports を呼ぶ）。テストが終わると戻す
function patchFs<K extends keyof typeof fs>(t: { after: (fn: () => void) => void }, name: K, make: (original: (typeof fs)[K]) => (typeof fs)[K]) {
  const original = fs[name];
  const patched = mock.method(fs, name, make(original) as never);
  syncBuiltinESMExports();
  let restored = false;
  const restore = () => { if (restored) return; restored = true; patched.mock.restore(); syncBuiltinESMExports(); };
  t.after(restore);
  return { restore, calls: () => patched.mock.callCount() };
}

const withError = (code: string, message: string) => Object.assign(new Error(message), { code });

const URL_PDF = 'https://files.example.com/report.pdf';

test('保存: downloads/ に中身が同じバイトで書かれ、書きかけは残らず、外を読んだ印が付く', async t => {
  const body = [bytes(70_000, 1), Buffer.alloc(0), bytes(100_000, 2), bytes(5, 3)];
  const w = world({ [URL_PDF]: { contentType: 'application/pdf', body: () => chunksOf(...body) } });
  const s = setup(t, undefined, w.network);
  const out = await s.call({ url: URL_PDF });
  assert.equal(out.decision, 'allow');
  assert.ok(!out.output.isError, out.output.content);
  assert.deepEqual(s.listing(), ['report.pdf']);
  assert.ok(readFileSync(join(s.downloads, 'report.pdf')).equals(Buffer.concat(body)));
  assert.match(out.output.content, /downloads\/report\.pdf（170,005 バイト、種類 application\/pdf）。取得元: https:\/\/files\.example\.com\/report\.pdf/u);
  assert.match(out.output.content, /外部の内容/u);
  assert.equal(s.ctx.taint.tainted, true);
  assert.deepEqual(s.ctx.taint.sources, ['web_download']);
});

test('保存: 書き込みの途中では最終の名前が見えず、隠した書きかけだけがある', async t => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let stalled = false;
  const w = world({
    [URL_PDF]: { body: async function* () { yield Buffer.from('first'); stalled = true; await gate; yield Buffer.from('second'); } },
  });
  const s = setup(t, undefined, w.network);
  const pending = s.call({ url: URL_PDF });
  while (!stalled) await tick();
  await tick();
  const during = s.listing();
  assert.equal(during.length, 1);
  assert.match(during[0]!, /^\.[0-9a-f-]{36}\.part$/u);
  release();
  const out = await pending;
  assert.ok(!out.output.isError, out.output.content);
  assert.deepEqual(s.listing(), ['report.pdf']);
  assert.equal(readFileSync(join(s.downloads, 'report.pdf'), 'utf8'), 'firstsecond');
});

test('名前: ../ を含む候補でも downloads/ の中の evil.txt になり、外には何もできない', async t => {
  const w = world({ [URL_PDF]: { body: () => chunksOf('x') } });
  const s = setup(t, undefined, w.network);
  for (const name of ['../../evil.txt', '..\\..\\evil.txt', '/etc/evil.txt']) {
    const out = await s.again({ url: URL_PDF, name });
    assert.ok(!out.output.isError, `${name}: ${out.output.content}`);
  }
  assert.deepEqual(s.listing(), ['evil.txt', 'evil-1.txt', 'evil-2.txt'].sort());
  for (const outside of [join(s.ctx.workspace, 'evil.txt'), join(s.ctx.workspace, '..', 'evil.txt'), join(s.ctx.workspace, '..', '..', 'evil.txt'), join(s.ctx.workspace, 'etc')]) {
    assert.equal(existsSync(outside), false, outside);
  }
});

test('名前: 危ない文字・予約名・名前の流れ（:）を落とす', async t => {
  const w = world({ [URL_PDF]: { body: () => chunksOf('x') } });
  const s = setup(t, undefined, w.network);
  const cases: Array<[string, string]> = [
    ['a<b>c?.txt', 'abc.txt'],
    ['con.txt', '_con.txt'],
    ['x.pdf:Zone.Identifier', 'x.pdfZone.Identifier'],
    ['  ..hidden.txt..  ', 'hidden.txt'],
    ['\u202Egpj.exe', 'gpj.exe'],
  ];
  for (const [candidate] of cases) assert.ok(!(await s.again({ url: URL_PDF, name: candidate })).output.isError, candidate);
  assert.deepEqual(s.listing(), cases.map(([, expected]) => expected).sort());
});

test('名前: 候補が無ければ Content-Disposition（filename* を先に）、次に URL の最後の部分、最後に download', async t => {
  const w = world({
    'https://files.example.com/a.bin': { contentDisposition: 'attachment; filename="from-header.bin"', body: () => chunksOf('1') },
    'https://files.example.com/b.bin': { contentDisposition: "attachment; filename=\"ascii.pdf\"; filename*=UTF-8''%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88.pdf", body: () => chunksOf('2') },
    'https://files.example.com/from-url.bin': { body: () => chunksOf('3') },
    'https://files.example.com/': { body: () => chunksOf('4') },
    'https://files.example.com/c.bin': { contentDisposition: 'attachment; filename="../.."', body: () => chunksOf('5') },
  });
  const s = setup(t, undefined, w.network);
  await s.again({ url: 'https://files.example.com/a.bin' });
  await s.again({ url: 'https://files.example.com/b.bin' });
  await s.again({ url: 'https://files.example.com/from-url.bin' });
  await s.again({ url: 'https://files.example.com/' });
  await s.again({ url: 'https://files.example.com/c.bin', name: '...' });
  assert.deepEqual(s.listing(), ['from-header.bin', 'レポート.pdf', 'from-url.bin', 'download', 'c.bin'].sort());
  await s.again({ url: 'https://files.example.com/a.bin', name: 'mine.bin' });
  assert.ok(s.listing().includes('mine.bin'), '候補があれば、ヘッダーより優先');
});

test('名前: 開くと動く名前（desktop.ini）は .download を付け、そう伝える', async t => {
  const w = world({ [URL_PDF]: { body: () => chunksOf('x') } });
  const s = setup(t, undefined, w.network);
  const out = await s.call({ url: URL_PDF, name: 'desktop.ini' });
  assert.deepEqual(s.listing(), ['desktop.ini.download']);
  assert.match(out.output.content, /downloads\/desktop\.ini\.download/u);
  assert.match(out.output.content, /\.download を付けました/u);
});

test('上書きしない: 同じ名前を 3 回 → a.pdf a-1.pdf a-2.pdf、最初のファイルの中身は変わらない', async t => {
  const bodies = ['first', 'second', 'third'];
  let next = 0;
  const w = world({ 'https://files.example.com/a.pdf': { body: () => chunksOf(bodies[next++]!) } });
  const s = setup(t, undefined, w.network);
  for (let i = 0; i < 3; i++) assert.ok(!(await s.again({ url: 'https://files.example.com/a.pdf' })).output.isError);
  assert.deepEqual(s.listing(), ['a-1.pdf', 'a-2.pdf', 'a.pdf']);
  assert.equal(readFileSync(join(s.downloads, 'a.pdf'), 'utf8'), 'first');
  assert.equal(readFileSync(join(s.downloads, 'a-1.pdf'), 'utf8'), 'second');
  assert.equal(readFileSync(join(s.downloads, 'a-2.pdf'), 'utf8'), 'third');
});

test('上書きしない: 持ち主が置いたファイルも壊さない。同時に落としても名前を取り合わない', async t => {
  const w = world({ 'https://files.example.com/b.txt': { body: () => chunksOf('downloaded') } });
  const s = setup(t, undefined, w.network);
  mkdirSync(s.downloads, { recursive: true });
  writeFileSync(join(s.downloads, 'b.txt'), 'owner file');
  const outs = await Promise.all([1, 2, 3].map(() => s.call({ url: 'https://files.example.com/b.txt' })));
  assert.ok(outs.every(o => !o.output.isError), outs.map(o => o.output.content).join('\n'));
  assert.deepEqual(s.listing(), ['b-1.txt', 'b-2.txt', 'b-3.txt', 'b.txt']);
  assert.equal(readFileSync(join(s.downloads, 'b.txt'), 'utf8'), 'owner file');
});

test('上書きしない: ハードリンクが使えない保存先では、上書きしないコピーに切り替える', async t => {
  let next = 0;
  const bodies = ['first', 'second'];
  const w = world({ 'https://files.example.com/a.pdf': { body: () => chunksOf(bodies[next++]!) } });
  const s = setup(t, undefined, w.network);
  const link = patchFs(t, 'linkSync', () => () => { throw withError('EPERM', 'EPERM: operation not permitted, link'); });
  assert.ok(!(await s.again({ url: 'https://files.example.com/a.pdf' })).output.isError);
  assert.ok(!(await s.again({ url: 'https://files.example.com/a.pdf' })).output.isError);
  assert.ok(link.calls() >= 1, 'リンクを試した');
  assert.deepEqual(s.listing(), ['a-1.pdf', 'a.pdf']);
  assert.equal(readFileSync(join(s.downloads, 'a.pdf'), 'utf8'), 'first', 'コピーでも既にあるファイルを上書きしない');
  assert.equal(readFileSync(join(s.downloads, 'a-1.pdf'), 'utf8'), 'second');
});

test('上書きしない: 名前が 1000 個とも取られていたら download.name_taken で、何も増えない', async t => {
  const w = world({ 'https://files.example.com/a.pdf': { body: () => chunksOf('x') } });
  const s = setup(t, undefined, w.network);
  mkdirSync(s.downloads, { recursive: true });
  writeFileSync(join(s.downloads, 'a.pdf'), 'taken');
  for (let n = 1; n <= 999; n++) writeFileSync(join(s.downloads, `a-${n}.pdf`), 'taken');
  const out = await s.call({ url: 'https://files.example.com/a.pdf' });
  assert.equal(out.output.isError, true);
  assert.match(out.output.content, /同じ名前のファイルが多すぎる/u);
  assert.equal(s.listing().length, 1000);
  assert.ok(s.listing().every(name => readFileSync(join(s.downloads, name), 'utf8') === 'taken'));
});

test('失敗の後始末: 60 秒なにも届かなければ止めて、downloads/ に何も残さない（外を読んだ印も付けない）', async t => {
  let stalled = false;
  const w = world({ [URL_PDF]: { body: async function* () { yield Buffer.from('partial'); stalled = true; await never(); } } });
  const s = setup(t, undefined, w.network);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = s.call({ url: URL_PDF });
    while (!stalled) await tick();
    await tick();
    assert.equal(s.listing().length, 1, '途中までは書きかけがある');
    mock.timers.tick(60_000);
    const out = await pending;
    assert.equal(out.output.isError, true);
    assert.match(out.output.content, /60 秒のあいだ何も届かなかった/u);
    assert.deepEqual(s.listing(), []);
    assert.equal(s.ctx.taint.tainted, false, '決まった文だけの失敗');
  } finally { mock.timers.reset(); }
});

test('失敗の後始末: 実行の取り消しで止めて、downloads/ に何も残さない', async t => {
  let stalled = false;
  const w = world({ [URL_PDF]: { body: async function* () { yield Buffer.from('partial'); stalled = true; await never(); } } });
  const s = setup(t, undefined, w.network);
  const pending = s.call({ url: URL_PDF });
  while (!stalled) await tick();
  await tick();
  assert.equal(s.listing().length, 1);
  s.controller.abort();
  const out = await pending;
  assert.equal(out.output.isError, true);
  assert.match(out.output.content, /中止しました/u);
  assert.deepEqual(s.listing(), []);
});

test('失敗の後始末: 書いている途中で空きが 1GiB を切ったら止めて、downloads/ に何も残さない', async t => {
  const w = world({ [URL_PDF]: { body: () => chunksOf(Buffer.alloc(9 * MiB, 1)) } });
  const s = setup(t, undefined, w.network);
  let calls = 0;
  patchFs(t, 'statfsSync', () => (() => ({ bavail: ++calls === 1 ? 10 * 1024 ** 3 : 5, bsize: 1 })) as never);
  const out = await s.call({ url: URL_PDF });
  assert.ok(calls >= 2, '最初のほかに、書いている途中でも空きを見た');
  assert.equal(out.output.isError, true);
  assert.match(out.output.content, /空きが少なくなった/u);
  assert.deepEqual(s.listing(), []);
  assert.equal(s.ctx.taint.tainted, false, '決まった文だけの失敗');
});

test('失敗の後始末: 空きが最初から 1GiB を切っていれば、つなぐ前に断り、書きかけも作らない', async t => {
  const w = world({ [URL_PDF]: { body: () => chunksOf('x') } });
  const s = setup(t, undefined, w.network);
  patchFs(t, 'statfsSync', () => (() => ({ bavail: 100, bsize: 1 })) as never);
  const out = await s.call({ url: URL_PDF });
  assert.equal(out.output.isError, true);
  assert.match(out.output.content, /空きが少なくなった/u);
  assert.deepEqual(w.opens, []);
  assert.deepEqual(s.listing(), []);
});

test('失敗の後始末: 圧縮して返す相手・HTTP の失敗・LAN の宛先は、何も書かずに断る', async t => {
  const w = world({
    [URL_PDF]: { contentEncoding: 'gzip', body: () => chunksOf('x') },
    'https://files.example.com/missing.bin': { status: 404 },
    'https://private.example.com/a.bin': { body: () => chunksOf('x') },
    'https://files.example.com/redirect': { status: 302, location: 'https://private.example.com/a.bin' },
  });
  const s = setup(t, undefined, w.network);
  const encoded = await s.again({ url: URL_PDF });
  assert.match(encoded.output.content, /圧縮した形（gzip）/u);
  assert.equal(encoded.output.isError, true);
  assert.equal((await s.again({ url: 'https://files.example.com/missing.bin' })).output.isError, true);
  const lan = await s.again({ url: 'https://private.example.com/a.bin' });
  assert.equal(lan.output.isError, true);
  const viaRedirect = await s.again({ url: 'https://files.example.com/redirect' });
  assert.equal(viaRedirect.output.isError, true);
  assert.deepEqual(w.opens, [`${URL_PDF}@93.184.216.34`, 'https://files.example.com/missing.bin@93.184.216.34', 'https://files.example.com/redirect@93.184.216.34']);
  assert.deepEqual(s.listing(), []);
});

test('失敗の後始末: ディスクへの書き込みが失敗しても、書きかけを消し、結果にパスを入れない', async t => {
  const w = world({ [URL_PDF]: { body: () => chunksOf('WRITE-FAILS-HERE') } });
  const s = setup(t, undefined, w.network);
  patchFs(t, 'write', original => ((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null) => void;
    if (Buffer.from(args[1] as Uint8Array).toString().includes('WRITE-FAILS-HERE')) { callback(withError('ENOSPC', 'ENOSPC: no space left on device, write')); return; }
    return (original as (...a: unknown[]) => void)(...args);
  }) as never);
  const out = await s.call({ url: URL_PDF });
  assert.equal(out.output.isError, true);
  assert.match(out.output.content, /ENOSPC/u);
  assert.deepEqual(s.listing(), []);
});

test('エラーの文に絶対パスを入れない（書きかけを開けなかったとき）', async t => {
  const w = world({ [URL_PDF]: { body: () => chunksOf('x') } });
  const s = setup(t, undefined, w.network);
  patchFs(t, 'openSync', original => ((path: string, ...rest: unknown[]) => {
    if (String(path).endsWith('.part')) throw withError('EACCES', `EACCES: permission denied, open '${String(path)}'`);
    return (original as (...a: unknown[]) => number)(path, ...rest);
  }) as never);
  const out = await s.call({ url: URL_PDF });
  assert.equal(out.output.isError, true);
  assert.match(out.output.content, /EACCES/u);
  assert.ok(!out.output.content.includes(s.ctx.workspace), out.output.content);
  assert.ok(!out.output.content.includes(s.paths.data), out.output.content);
  assert.deepEqual(s.listing(), []);
});

test('Zone.Identifier（Windows）: 保存したファイルに ZoneId=3 と取得元の URL が付く', { skip: process.platform !== 'win32' }, async t => {
  const w = world({ 'https://files.example.com/a.pdf': { body: () => chunksOf('x') } });
  const s = setup(t, undefined, w.network);
  await s.again({ url: 'https://files.example.com/a.pdf' });
  await s.again({ url: 'https://files.example.com/a.pdf' });
  for (const name of ['a.pdf', 'a-1.pdf']) {
    assert.equal(readFileSync(`${join(s.downloads, name)}:Zone.Identifier`, 'utf8'), '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://files.example.com/a.pdf\r\n', name);
  }
  assert.deepEqual(s.listing(), ['a-1.pdf', 'a.pdf']);
});

test('Zone.Identifier（Windows）: 印を書けなくても、保存したファイルは残し、そう伝える', { skip: process.platform !== 'win32' }, async t => {
  const w = world({ 'https://files.example.com/a.pdf': { body: () => chunksOf('x') } });
  const s = setup(t, undefined, w.network);
  patchFs(t, 'writeFileSync', original => ((path: string, ...rest: unknown[]) => {
    if (String(path).endsWith(':Zone.Identifier')) throw withError('EINVAL', `EINVAL: invalid argument, open '${String(path)}'`);
    return (original as (...a: unknown[]) => void)(path, ...rest);
  }) as never);
  const out = await s.call({ url: 'https://files.example.com/a.pdf' });
  assert.ok(!out.output.isError, out.output.content);
  assert.match(out.output.content, /Zone\.Identifier）を付けられませんでした: EINVAL/u);
  assert.ok(!out.output.content.includes(s.ctx.workspace));
  assert.deepEqual(s.listing(), ['a.pdf']);
  assert.equal(readFileSync(join(s.downloads, 'a.pdf'), 'utf8'), 'x');
});

test('Zone.Identifier: Windows 以外では書かない', { skip: process.platform === 'win32' }, async t => {
  const w = world({ 'https://files.example.com/a.pdf': { body: () => chunksOf('x') } });
  const s = setup(t, undefined, w.network);
  const out = await s.call({ url: 'https://files.example.com/a.pdf' });
  assert.ok(!out.output.isError);
  assert.doesNotMatch(out.output.content, /Zone\.Identifier/u);
  assert.deepEqual(s.listing(), ['a.pdf']);
});

test('リンク: downloads が別の場所へのジャンクション（リンク）なら、道具の判定が断り、リンクの先に何もできない', async t => {
  const w = world({ [URL_PDF]: { body: () => chunksOf('x') } });
  const s = setup(t, undefined, w.network);
  const elsewhere = join(s.paths.data, 'elsewhere');
  const inside = join(s.ctx.workspace, 'real-downloads');
  mkdirSync(elsewhere, { recursive: true });
  mkdirSync(inside, { recursive: true });
  for (const target of [elsewhere, inside]) {
    fs.rmSync(s.downloads, { recursive: true, force: true });
    symlinkSync(target, s.downloads, process.platform === 'win32' ? 'junction' : 'dir');
    const out = await s.call({ url: URL_PDF });
    assert.equal(out.decision, 'deny', target);
    assert.equal(out.output.isError, true);
    assert.deepEqual(readdirSync(target), [], `${target} の中に何も作らない`);
  }
  assert.deepEqual(w.opens, [], '通信もしない');
});

test('リンク: 判定のあとで downloads がリンクに替わっていても、execute が download.dir_link で断る（リンクの先に何も作らない）', async t => {
  const w = world({ [URL_PDF]: { body: () => chunksOf('x') } });
  const s = setup(t, undefined, w.network);
  const target = join(s.ctx.workspace, 'real-downloads');
  mkdirSync(target, { recursive: true });
  symlinkSync(target, s.downloads, process.platform === 'win32' ? 'junction' : 'dir');
  const out = await webDownload.execute({ url: URL_PDF }, s.ctx);
  assert.equal(out.isError, true);
  assert.match(out.content, /リンクになっている/u);
  assert.ok(!out.content.includes(s.ctx.workspace));
  assert.equal(out.noRemoteContent, true);
  assert.deepEqual(readdirSync(target), []);
  assert.deepEqual(w.opens, []);
});

test('事前の判定: 計画モードと振り返りでは断る（何も作らず、通信もしない）', async t => {
  const w = world({ [URL_PDF]: { body: () => chunksOf('x') } });
  const s = setup(t, undefined, w.network);
  const plan = await s.call({ url: URL_PDF }, s.ctx, 'plan');
  assert.equal(plan.decision, 'deny');
  assert.equal(plan.decidedBy, 'mode');
  const review = await s.call({ url: URL_PDF }, { ...s.ctx, kind: 'review' });
  assert.equal(review.decision, 'deny');
  assert.deepEqual(w.opens, []);
  assert.equal(existsSync(s.downloads), false);
});

test('事前の判定: 外を読んだあとは確かめになり（種類 taint）、札に URL と保存先のフォルダが出る。断れば何も作らない', async t => {
  const w = world({ [URL_PDF]: { body: () => chunksOf('x') } });
  const s = setup(t, undefined, w.network);
  s.ctx.taint.tainted = true;
  s.ctx.taint.sources.push('web_fetch');
  const view = await s.asked({ url: URL_PDF, name: 'wanted.pdf' });
  assert.ok(view.kinds?.includes('taint'));
  assert.match(view.title, /downloads\//u);
  assert.equal(view.body, `${URL_PDF}\nwanted.pdf`);
  assert.deepEqual(view.paths, [{ input: 'downloads', path: s.downloads, verdict: 'in', mode: 'write' }]);
  assert.deepEqual(w.opens, []);
  assert.equal(existsSync(s.downloads), false);
});

test('事前の判定: URL に秘密らしい文字・長い問い合わせがあれば確かめ。ローカルの宛先・tools.web.fetch が off は断る', async t => {
  const w = world({});
  const s = setup(t, undefined, w.network);
  const secret = await s.asked({ url: 'https://files.example.com/a.pdf?k=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
  assert.ok(secret.kinds?.includes('web'));
  assert.ok(secret.paths?.some(p => p.input === 'downloads'));
  const long = await s.asked({ url: `https://files.example.com/a.pdf?${'q=1&'.repeat(100)}` });
  assert.match(long.reasons.join('\n'), /長いクエリ/u);
  for (const url of ['http://localhost/a.bin', 'http://192.168.1.10/a.bin', 'file:///etc/passwd', 'https://user:pw@files.example.com/a.bin']) {
    const out = await s.call({ url });
    assert.equal(out.decision, 'deny', url);
  }
  assert.deepEqual(w.opens, []);

  const off = setup(t, c => { c.tools.web.fetch = false; }, w.network);
  const offOut = await off.call({ url: URL_PDF });
  assert.equal(offOut.decision, 'deny');
  assert.match(offOut.output.content, /tools\.web\.fetch/u);
});

test('事前の判定: 作業フォルダが読むだけのフォルダなら断り、downloads/ を作らない', async t => {
  const w = world({ [URL_PDF]: { body: () => chunksOf('x') } });
  const s = setup(t, c => { c.tools.roots = [{ path: 'workspace', mode: 'read' }]; }, w.network);
  const out = await s.call({ url: URL_PDF });
  assert.equal(out.decision, 'deny');
  assert.equal(out.output.isError, true);
  assert.equal(existsSync(s.downloads), false);
  assert.deepEqual(w.opens, []);
});

test('引数: 保存先は選べない（path など知らない項目は断る）', async t => {
  const w = world({ [URL_PDF]: { body: () => chunksOf('x') } });
  const s = setup(t, undefined, w.network);
  for (const extra of [{ path: '../out' }, { dir: '/tmp' }, { folder: 'x' }]) {
    const out = await s.call({ url: URL_PDF, ...extra });
    assert.equal(out.output.isError, true);
    assert.equal(out.invalidArguments, true);
  }
  assert.deepEqual(w.opens, []);
  assert.equal(existsSync(s.downloads), false);
});

test('「外を読んだ」印: 決まった文だけの失敗の鍵（idle・disk_low・encoded）だけ、印を付けない失敗にする', () => {
  const marked = new Set(['download.idle', 'download.disk_low', 'download.encoded']);
  for (const key of ['download.idle', 'download.disk_low', 'download.encoded', 'fetch.http_status', 'fetch.type', 'fetch.dns'] as const) {
    assert.equal(webFailure(new RetrievalFailure('http_failure', 'x', undefined, key), 'ja').noRemoteContent === true, marked.has(key), key);
  }
});

test('英語の設定: 結果・失敗・断りの文に日本語の文字が無い', async t => {
  const w = world({
    [URL_PDF]: { body: () => chunksOf('x') },
    'https://files.example.com/enc.bin': { contentEncoding: 'br' },
    'https://files.example.com/missing.bin': { status: 404 },
  });
  const s = setup(t, c => { c.language = 'en'; }, w.network);
  const texts: string[] = [];
  texts.push((await s.again({ url: URL_PDF, name: 'desktop.ini' })).output.content);
  texts.push((await s.again({ url: 'https://files.example.com/enc.bin' })).output.content);
  texts.push((await s.again({ url: 'https://files.example.com/missing.bin' })).output.content);
  texts.push((await s.again({ url: 'https://private.example.com/a.bin' })).output.content);
  texts.push((await s.again({ url: 'http://localhost/' })).output.content);
  const target = join(s.ctx.workspace, 'real-downloads');
  mkdirSync(target, { recursive: true });
  fs.rmSync(s.downloads, { recursive: true, force: true });
  symlinkSync(target, s.downloads, process.platform === 'win32' ? 'junction' : 'dir');
  texts.push((await webDownload.execute({ url: URL_PDF }, s.ctx)).content);
  assert.match(texts[0]!, /Saved: downloads\/desktop\.ini\.download/u);
  assert.match(texts[1]!, /compressed form \(br\)/u);
  for (const text of texts) assert.doesNotMatch(text, CJK, text);
  assert.equal(webDownload.summarize!({ url: URL_PDF }, 'en').title, 'Download a file and save it to downloads/');
});

// ---- 本物の通信（127.0.0.1 の小さなサーバーへ。公開のアドレスの確かめは偽の世界で済んでいるので、ここは流して書くところだけ見る）

async function localServer(t: { after(fn: () => void): void }, handler: (response: ServerResponse) => void): Promise<DownloadNetwork> {
  const server = createServer((_request, response) => handler(response));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address() as AddressInfo;
  return {
    resolve: async () => ['93.184.216.34'],
    open: (url, _address, signal) => defaultDownloadNetwork.open(new URL(`http://127.0.0.1:${port}${url.pathname}${url.search}`), '127.0.0.1', signal),
  };
}

test('本物の通信: 24MiB を流しながら書き、保存したファイルの中身は送ったものと同じ', async t => {
  const sent = createHash('sha256');
  const network = await localServer(t, response => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="big.bin"' });
    let n = 0;
    const next = () => {
      while (n < 24) {
        const chunk = bytes(MiB, n);
        sent.update(chunk);
        n++;
        if (!response.write(chunk)) { response.once('drain', next); return; }
      }
      response.end();
    };
    next();
  });
  const s = setup(t, undefined, network);
  const out = await s.call({ url: 'https://files.example.com/download?id=1' });
  assert.ok(!out.output.isError, out.output.content);
  assert.match(out.output.content, /downloads\/big\.bin（25,165,824 バイト/u);
  assert.deepEqual(s.listing(), ['big.bin']);
  assert.equal(createHash('sha256').update(readFileSync(join(s.downloads, 'big.bin'))).digest('hex'), sent.digest('hex'));
});

test('本物の通信: 途中で切られたら失敗にして、書きかけを残さない', async t => {
  const network = await localServer(t, response => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '1000000' });
    response.write(Buffer.alloc(1000, 7));
    setTimeout(() => response.destroy(), 30);
  });
  const s = setup(t, undefined, network);
  const out = await s.call({ url: 'https://files.example.com/cut.bin' });
  assert.equal(out.output.isError, true);
  assert.deepEqual(s.listing(), []);
  assert.ok(!out.output.content.includes(s.ctx.workspace));
});
