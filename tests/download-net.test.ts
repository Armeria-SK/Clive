import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import { IMAGE_MAX_BYTES } from '../src/shared/image-info.ts';
import {
  defaultDownloadNetwork, DOWNLOAD_LIMITS, downloadPublic, fetchPublic, IMAGE_TYPES, imageNetwork, RetrievalFailure,
  type DownloadNetwork, type DownloadResponse, type DownloadSink, type PageNetwork, type PageResponse,
} from '../src/tools/web/public-page.ts';

const MiB = 1024 * 1024;
const never = <T>() => new Promise<T>(() => undefined);

async function* chunksOf(...parts: Array<string | Uint8Array>): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === 'string' ? Buffer.from(part) : part;
}

interface Plan {
  status?: number; location?: string; contentType?: string; contentDisposition?: string; contentEncoding?: string;
  body?: () => AsyncIterable<Uint8Array>;
}

// 同じ「世界」（名前の引き先と、URL ごとの応答）から、ページ用とダウンロード用の偽の通信を作る
function world(dns: Record<string, string[]>, plans: Record<string, Plan>) {
  const opens: string[] = [];
  const closes = new Map<string, number>();
  const resolve = async (host: string) => { if (!dns[host]) throw new Error('ENOTFOUND'); return dns[host]!; };
  const page: PageNetwork = {
    resolve,
    get: async (url, address) => {
      opens.push(`${url.href}@${address}`);
      const plan = plans[url.href] ?? { status: 404 };
      const response: PageResponse = { status: plan.status ?? 200, contentType: plan.contentType ?? 'text/html', body: Buffer.alloc(0) };
      if (plan.location) response.location = plan.location;
      return response;
    },
  };
  const download: DownloadNetwork = {
    resolve,
    open: async (url, address) => {
      opens.push(`${url.href}@${address}`);
      const plan = plans[url.href] ?? { status: 404 };
      const response: DownloadResponse = {
        status: plan.status ?? 200,
        contentType: plan.contentType ?? 'application/octet-stream',
        body: (plan.body ?? (() => chunksOf()))(),
        close: () => closes.set(url.href, (closes.get(url.href) ?? 0) + 1),
      };
      if (plan.location) response.location = plan.location;
      if (plan.contentDisposition) response.contentDisposition = plan.contentDisposition;
      if (plan.contentEncoding) response.contentEncoding = plan.contentEncoding;
      return response;
    },
  };
  return { page, download, opens, closes };
}

function memorySink(options: { free?: number; delayMs?: number } = {}) {
  const written: Uint8Array[] = [];
  const state = { inFlight: 0, freeCalls: 0 };
  const sink: DownloadSink = {
    write: async chunk => {
      state.inFlight++;
      try {
        if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
        written.push(chunk);
      } finally { state.inFlight--; }
    },
    freeBytes: () => { state.freeCalls++; return options.free ?? Number.MAX_SAFE_INTEGER; },
  };
  return { sink, written, state, total: () => written.reduce((sum, chunk) => sum + chunk.length, 0) };
}

const failureOf = (promise: Promise<unknown>) => promise.then(() => assert.fail('失敗するはず'), (error: unknown) => {
  assert.ok(error instanceof RetrievalFailure, `RetrievalFailure のはず: ${String(error)}`);
  return error;
});

const DNS = {
  'good.example.com': ['93.184.216.34'],
  'good2.example.com': ['93.184.216.35'],
  'files.example.com': ['93.184.216.36'],
  'rebind.example.com': ['127.0.0.1'],
  'private.example.com': ['10.0.0.5'],
  'mixed.example.com': ['93.184.216.34', '10.0.0.5'],
  'meta.example.com': ['169.254.169.254'],
  'cgnat.example.com': ['100.64.0.1'],
  'mapped.example.com': ['::ffff:127.0.0.1'],
  'v6.example.com': ['2606:2800:220:1::1'],
};

test('3 かたまりが順に sink へ届き、bytes が合う。応答は最後に 1 回だけ閉じる', async () => {
  const w = world(DNS, {
    'https://files.example.com/a.bin': {
      contentType: 'application/pdf', contentDisposition: 'attachment; filename="a.pdf"',
      body: () => chunksOf('abc', 'defg', 'h'),
    },
  });
  const memory = memorySink();
  const result = await downloadPublic('https://files.example.com/a.bin#frag', new AbortController().signal, memory.sink, { network: w.download });
  assert.deepEqual(result, { url: 'https://files.example.com/a.bin', contentType: 'application/pdf', contentDisposition: 'attachment; filename="a.pdf"', bytes: 8 });
  assert.deepEqual(memory.written.map(chunk => Buffer.from(chunk).toString()), ['abc', 'defg', 'h']);
  assert.deepEqual(w.opens, ['https://files.example.com/a.bin@93.184.216.36'], '確かめたアドレスにだけつなぐ');
  assert.deepEqual([...w.closes], [['https://files.example.com/a.bin', 1]]);
  assert.equal(memory.state.freeCalls, 0, '8MiB に届くまでは空きを見ない');
});

test('Content-Disposition が無く、Content-Type は何でも受ける。identity の圧縮指定は受ける', async () => {
  const w = world(DNS, { 'https://files.example.com/x': { contentType: 'x-weird/type; foo=bar', contentEncoding: ' Identity ', body: () => chunksOf('z') } });
  const result = await downloadPublic('https://files.example.com/x', new AbortController().signal, memorySink().sink, { network: w.download });
  assert.equal(result.contentDisposition, undefined);
  assert.equal(result.contentType, 'x-weird/type; foo=bar');
  assert.equal(result.bytes, 1);
});

// 転送先の確かめは fetchPublic と同じ 1 つの関数を通る。同じ世界で両方を走らせ、同じ失敗になること・sink に何も書かれないことを確かめる
const BAD_TARGETS: Array<[label: string, target: string, key: string]> = [
  ['名前の引き先が 127.0.0.1', 'https://rebind.example.com/', 'fetch.not_public'],
  ['名前の引き先が LAN', 'https://private.example.com/', 'fetch.not_public'],
  ['引き先の 1 つが LAN', 'https://mixed.example.com/', 'fetch.not_public'],
  ['メタデータのアドレス', 'https://meta.example.com/', 'fetch.not_public'],
  ['CGNAT の範囲', 'https://cgnat.example.com/', 'fetch.not_public'],
  ['IPv4 射影の IPv6', 'https://mapped.example.com/', 'fetch.not_public'],
  ['IPv6 の引き先', 'https://v6.example.com/', 'fetch.not_public'],
  ['メタデータの IP を直接', 'http://169.254.169.254/latest/meta-data/', 'fetch.policy'],
  ['10 進数の 127.0.0.1', 'http://2130706433/', 'fetch.policy'],
  ['16 進数の 127.0.0.1', 'http://0x7f.1/', 'fetch.policy'],
  ['IPv6 リテラルの射影', 'http://[::ffff:7f00:1]/', 'fetch.policy'],
  ['localhost', 'http://localhost/', 'fetch.policy'],
  ['独自のポート', 'http://good2.example.com:8080/', 'fetch.policy'],
  ['認証情報つき', 'http://user:pw@good2.example.com/', 'fetch.policy'],
  ['file', 'file:///etc/passwd', 'fetch.policy'],
  ['https から http へ下がる', 'http://good2.example.com/plain', 'fetch.redirect_downgrade'],
];

for (const [label, target, key] of BAD_TARGETS) {
  test(`転送のとちゅうで断る（ダウンロード）: ${label}`, async () => {
    const plans: Record<string, Plan> = {
      'https://good.example.com/start': { status: 302, location: 'https://good2.example.com/mid' },
      'https://good2.example.com/mid': { status: 301, location: target },
    };
    const forDownload = world(DNS, plans);
    const memory = memorySink();
    const downloadError = await failureOf(downloadPublic('https://good.example.com/start', new AbortController().signal, memory.sink, { network: forDownload.download }));
    const forPage = world(DNS, plans);
    const pageError = await failureOf(fetchPublic('https://good.example.com/start', undefined, forPage.page));
    assert.deepEqual([downloadError.code, downloadError.key, downloadError.message], [pageError.code, pageError.key, pageError.message], 'fetchPublic と同じ失敗');
    assert.equal(downloadError.code, 'policy_blocked', '決まりで断る（つなげなかった、ではない）');
    assert.equal(downloadError.key, key);
    assert.equal(memory.written.length, 0, 'sink に何も書かれない');
    assert.deepEqual(forDownload.opens, forPage.opens, '同じところまでしかつながない');
    assert.deepEqual(forDownload.opens, ['https://good.example.com/start@93.184.216.34', 'https://good2.example.com/mid@93.184.216.35']);
    assert.deepEqual([...forDownload.closes.values()], [1, 1], '転送の応答は 1 つずつ閉じる');
  });
}

test('最初の URL が LAN を指していても、つなぐ前に断る', async () => {
  for (const url of ['https://rebind.example.com/a', 'https://mixed.example.com/a', 'http://192.168.0.1/a', 'https://unknown.example.com/a']) {
    const w = world(DNS, {});
    const memory = memorySink();
    await failureOf(downloadPublic(url, new AbortController().signal, memory.sink, { network: w.download }));
    assert.deepEqual(w.opens, [], url);
    assert.equal(memory.written.length, 0);
  }
});

test('転送は 5 回まで。6 回目は断る（fetchPublic と同じ回数）', async () => {
  const plans: Record<string, Plan> = { 'https://good.example.com/loop': { status: 302, location: '/loop' } };
  const forDownload = world(DNS, plans);
  const forPage = world(DNS, plans);
  const memory = memorySink();
  const downloadError = await failureOf(downloadPublic('https://good.example.com/loop', new AbortController().signal, memory.sink, { network: forDownload.download }));
  const pageError = await failureOf(fetchPublic('https://good.example.com/loop', undefined, forPage.page));
  assert.equal(downloadError.key, 'fetch.redirects');
  assert.equal(pageError.key, 'fetch.redirects');
  assert.equal(forDownload.opens.length, 6);
  assert.equal(forPage.opens.length, 6);
  assert.equal([...forDownload.closes.values()].reduce((a, b) => a + b, 0), 6, '6 つとも閉じる');
  assert.equal(memory.written.length, 0);
});

test('転送をたどった先のファイルを保存する。相対の転送先も、途中の応答も閉じる', async () => {
  const w = world(DNS, {
    'https://good.example.com/start': { status: 302, location: 'https://files.example.com/dir/file' },
    'https://files.example.com/dir/file': { status: 307, location: '../final.bin?x=1' },
    'https://files.example.com/final.bin?x=1': { body: () => chunksOf('ok') },
  });
  const memory = memorySink();
  const result = await downloadPublic('https://good.example.com/start', new AbortController().signal, memory.sink, { network: w.download });
  assert.equal(result.url, 'https://files.example.com/final.bin?x=1');
  assert.equal(memory.total(), 2);
  assert.deepEqual([...w.closes.values()], [1, 1, 1]);
});

test('状態が 200 以外なら断り、応答を閉じる。404 は見つからない、403 は拒否', async () => {
  for (const [status, code] of [[404, 'not_found'], [403, 'refused'], [429, 'refused'], [500, 'http_failure'], [204, 'http_failure']] as const) {
    const w = world(DNS, { 'https://files.example.com/a': { status, body: () => chunksOf('x') } });
    const memory = memorySink();
    const error = await failureOf(downloadPublic('https://files.example.com/a', new AbortController().signal, memory.sink, { network: w.download }));
    assert.equal(error.code, code, String(status));
    assert.equal(error.key, 'fetch.http_status');
    assert.equal(error.status, status);
    assert.equal(memory.written.length, 0);
    assert.deepEqual([...w.closes.values()], [1]);
  }
});

test('Content-Type に改行があれば断る', async () => {
  const w = world(DNS, { 'https://files.example.com/a': { contentType: 'text/plain\r\nX-Evil: 1' } });
  const memory = memorySink();
  const error = await failureOf(downloadPublic('https://files.example.com/a', new AbortController().signal, memory.sink, { network: w.download }));
  assert.equal(error.key, 'fetch.type');
  assert.equal(memory.written.length, 0);
  assert.deepEqual([...w.closes.values()], [1]);
});

test('圧縮して返されたら保存しない（identity 以外）', async () => {
  for (const encoding of ['gzip', 'br', 'deflate', 'identity, gzip', 'GZIP']) {
    const w = world(DNS, { 'https://files.example.com/a.gz': { contentEncoding: encoding, body: () => chunksOf('x') } });
    const memory = memorySink();
    const error = await failureOf(downloadPublic('https://files.example.com/a.gz', new AbortController().signal, memory.sink, { network: w.download }));
    assert.equal(error.key, 'download.encoded', encoding);
    assert.equal(error.code, 'invalid_response');
    assert.match(error.text('ja'), new RegExp(encoding.toLowerCase().replace(/[^\w]/gu, '.'), 'u'));
    assert.equal(memory.written.length, 0);
    assert.deepEqual([...w.closes.values()], [1]);
  }
});

test('圧縮の指定の文字は、改行などを落として短くしてから文に入れる', async () => {
  const w = world(DNS, { 'https://files.example.com/a': { contentEncoding: `x\u0007${'y'.repeat(500)}` } });
  const error = await failureOf(downloadPublic('https://files.example.com/a', new AbortController().signal, memorySink().sink, { network: w.download }));
  assert.equal(error.key, 'download.encoded');
  assert.ok(error.message.length < 200, String(error.message.length));
  assert.doesNotMatch(error.message, /\u0007/u);
});

test('最後のかたまりから idleMs のあいだ何も来なければ止める。応答は閉じ、書いた分で止まる', { timeout: 10_000 }, async () => {
  const w = world(DNS, {
    'https://files.example.com/stuck': {
      body: () => (async function* () { yield Buffer.from('first'); await never<void>(); })(),
    },
  });
  const memory = memorySink();
  const started = Date.now();
  const error = await failureOf(downloadPublic('https://files.example.com/stuck', new AbortController().signal, memory.sink, { network: w.download, limits: { idleMs: 50 } }));
  assert.equal(error.key, 'download.idle');
  assert.equal(error.code, 'http_failure');
  assert.ok(Date.now() - started < 3000);
  assert.equal(memory.written.length, 1);
  assert.deepEqual([...w.closes.values()], [1]);
});

test('最初のかたまりが来ないときも idleMs で止める', { timeout: 10_000 }, async () => {
  const w = world(DNS, { 'https://files.example.com/slow': { body: () => (async function* () { await never<void>(); yield Buffer.alloc(0); })() } });
  const memory = memorySink();
  const error = await failureOf(downloadPublic('https://files.example.com/slow', new AbortController().signal, memory.sink, { network: w.download, limits: { idleMs: 50 } }));
  assert.equal(error.key, 'download.idle');
  assert.equal(memory.written.length, 0);
  assert.deepEqual([...w.closes.values()], [1]);
});

test('idleMs は「待っている時間」。書く側（sink）が遅いあいだは数えない', async () => {
  const w = world(DNS, { 'https://files.example.com/a': { body: () => chunksOf('a', 'b', 'c') } });
  const memory = memorySink({ delayMs: 120 });
  const result = await downloadPublic('https://files.example.com/a', new AbortController().signal, memory.sink, { network: w.download, limits: { idleMs: 50 } });
  assert.equal(result.bytes, 3);
});

test('既定の止める条件は 60 秒・空き 1GiB・8MiB ごと', () => {
  assert.deepEqual({ ...DOWNLOAD_LIMITS }, { idleMs: 60_000, minFreeBytes: 1024 ** 3, freeCheckBytes: 8 * MiB });
  assert.throws(() => { (DOWNLOAD_LIMITS as { idleMs: number }).idleMs = 1; }, TypeError, '書き換えられない');
});

test('取り消し: 受け取りの途中で止めると fetch.aborted、応答は閉じ、それ以上は書かない', async () => {
  const controller = new AbortController();
  const w = world(DNS, { 'https://files.example.com/long': { body: () => (async function* () { yield Buffer.from('one'); yield Buffer.from('two'); await never<void>(); })() } });
  const memory = memorySink();
  const sink: DownloadSink = { write: async chunk => { await memory.sink.write(chunk); controller.abort(); }, freeBytes: memory.sink.freeBytes };
  const error = await failureOf(downloadPublic('https://files.example.com/long', controller.signal, sink, { network: w.download }));
  assert.equal(error.key, 'fetch.aborted');
  assert.equal(error.code, 'aborted');
  assert.equal(memory.written.length, 1);
  assert.deepEqual([...w.closes.values()], [1]);
});

test('取り消し: かたまりを待っているあいだに止めても、すぐ止まる', { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  const w = world(DNS, { 'https://files.example.com/long': { body: () => (async function* () { await never<void>(); yield Buffer.alloc(0); })() } });
  setTimeout(() => controller.abort(), 30);
  const started = Date.now();
  const error = await failureOf(downloadPublic('https://files.example.com/long', controller.signal, memorySink().sink, { network: w.download }));
  assert.equal(error.key, 'fetch.aborted');
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual([...w.closes.values()], [1]);
});

test('取り消し: 始める前に取り消されていたら、つながない', async () => {
  const controller = new AbortController();
  controller.abort();
  const w = world(DNS, { 'https://files.example.com/a': { body: () => chunksOf('x') } });
  const error = await failureOf(downloadPublic('https://files.example.com/a', controller.signal, memorySink().sink, { network: w.download }));
  assert.equal(error.key, 'fetch.aborted');
  assert.deepEqual(w.opens, []);
});

test('取り消し: つないでいる最中でも止まり、届いた応答は閉じる', async () => {
  const controller = new AbortController();
  const closes: string[] = [];
  const network: DownloadNetwork = {
    resolve: async () => ['93.184.216.34'],
    open: async () => {
      controller.abort();
      return { status: 200, contentType: 'application/octet-stream', body: chunksOf('late'), close: () => closes.push('closed') };
    },
  };
  const memory = memorySink();
  const error = await failureOf(downloadPublic('https://files.example.com/a', controller.signal, memory.sink, { network }));
  assert.equal(error.key, 'fetch.aborted');
  assert.equal(memory.written.length, 0);
  assert.deepEqual(closes, ['closed']);
});

test('取り消し: sink が書いている最中なら、書き終わってから戻る（戻ったあとに sink は動かない）', async () => {
  const controller = new AbortController();
  const w = world(DNS, { 'https://files.example.com/a': { body: () => chunksOf('a', 'b', 'c') } });
  const memory = memorySink({ delayMs: 100 });
  const sink: DownloadSink = { write: chunk => { setTimeout(() => controller.abort(), 20); return memory.sink.write(chunk); }, freeBytes: memory.sink.freeBytes };
  const error = await failureOf(downloadPublic('https://files.example.com/a', controller.signal, sink, { network: w.download }));
  assert.equal(error.key, 'fetch.aborted');
  assert.equal(memory.state.inFlight, 0, '戻った時点で書き込みは終わっている');
  assert.equal(memory.written.length, 1, '取り消したあとの次のかたまりは書かない');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(memory.written.length, 1);
});

test('つなぐ時間は 20 秒まで。本文の受け取りには総時間の上限を置かない', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const network: DownloadNetwork = {
    resolve: async () => ['93.184.216.34'],
    open: (_url, _address, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  };
  const pending = failureOf(downloadPublic('https://files.example.com/a', new AbortController().signal, memorySink().sink, { network }));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(19_999);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1);
  const error = await pending;
  assert.equal(error.key, 'fetch.timeout');
  assert.match(error.message, /20/u);
});

test('つなぎ終えたあとは時間切れの 20 秒に巻き込まれない（受け取りは 20 秒を超えてもよい）', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const w = world(DNS, { 'https://files.example.com/a': { body: () => (async function* () { yield Buffer.from('a'); await gate; yield Buffer.from('b'); })() } });
  const memory = memorySink();
  const pending = downloadPublic('https://files.example.com/a', new AbortController().signal, memory.sink, { network: w.download });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(25_000);
  await new Promise(resolve => setImmediate(resolve));
  open();
  const result = await pending;
  assert.equal(result.bytes, 2);
});

test('空きが minFreeBytes を切ったら止める。freeCheckBytes 書くごとに見る', async () => {
  const w = world(DNS, { 'https://files.example.com/a': { body: () => chunksOf('1234', '5678', '9abc', 'defg') } });
  const low = memorySink({ free: 100 });
  const error = await failureOf(downloadPublic('https://files.example.com/a', new AbortController().signal, low.sink, { network: w.download, limits: { freeCheckBytes: 8, minFreeBytes: 1000 } }));
  assert.equal(error.key, 'download.disk_low');
  assert.match(error.message, /100/u, '残りの量が文に入る');
  assert.equal(low.written.length, 2, '8 バイト書いたところで見て、止まる');
  assert.equal(low.state.freeCalls, 1);
  assert.deepEqual([...w.closes.values()], [1]);

  const enough = memorySink({ free: 5000 });
  const ok = await downloadPublic('https://files.example.com/a', new AbortController().signal, enough.sink, { network: world(DNS, { 'https://files.example.com/a': { body: () => chunksOf('1234', '5678', '9abc', 'defg') } }).download, limits: { freeCheckBytes: 8, minFreeBytes: 1000 } });
  assert.equal(ok.bytes, 16);
  assert.equal(enough.state.freeCalls, 2, '16 バイトで 2 回');
});

test('空きがちょうど minFreeBytes なら続ける。下回ったときだけ止める', async () => {
  const body = () => chunksOf('12345678');
  const exact = memorySink({ free: 1000 });
  const ok = await downloadPublic('https://files.example.com/a', new AbortController().signal, exact.sink, { network: world(DNS, { 'https://files.example.com/a': { body } }).download, limits: { freeCheckBytes: 8, minFreeBytes: 1000 } });
  assert.equal(ok.bytes, 8);
  const under = memorySink({ free: 999 });
  const error = await failureOf(downloadPublic('https://files.example.com/a', new AbortController().signal, under.sink, { network: world(DNS, { 'https://files.example.com/a': { body } }).download, limits: { freeCheckBytes: 8, minFreeBytes: 1000 } }));
  assert.equal(error.key, 'download.disk_low');
});

test('sink が投げた失敗（書けない・空きを調べられない）は作り替えずにそのまま投げ、応答は閉じる', async () => {
  const w = world(DNS, { 'https://files.example.com/a': { body: () => chunksOf('a', 'b') } });
  const diskFull = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  const failing: DownloadSink = { write: async () => { throw diskFull; }, freeBytes: () => Number.MAX_SAFE_INTEGER };
  await assert.rejects(downloadPublic('https://files.example.com/a', new AbortController().signal, failing, { network: w.download }), error => error === diskFull);
  assert.deepEqual([...w.closes.values()], [1]);

  const w2 = world(DNS, { 'https://files.example.com/a': { body: () => chunksOf('abcd') } });
  const statfsError = new Error('statfs failed');
  const blind: DownloadSink = { write: async () => undefined, freeBytes: () => { throw statfsError; } };
  await assert.rejects(downloadPublic('https://files.example.com/a', new AbortController().signal, blind, { network: w2.download, limits: { freeCheckBytes: 1 } }), error => error === statfsError);
  assert.deepEqual([...w2.closes.values()], [1]);
});

test('本文の途中で通信が切れたら失敗にする（途中までを成功にしない）', async () => {
  const w = world(DNS, { 'https://files.example.com/a': { body: () => (async function* () { yield Buffer.from('half'); throw new Error('aborted'); })() } });
  const memory = memorySink();
  const error = await failureOf(downloadPublic('https://files.example.com/a', new AbortController().signal, memory.sink, { network: w.download }));
  assert.equal(error.key, 'fetch.connect');
  assert.equal(memory.written.length, 1);
  assert.deepEqual([...w.closes.values()], [1]);
});

// 強制の GC を使える形にする（テストの実行に --expose-gc を付けなくてよいように）
v8.setFlagsFromString('--expose-gc');
const collectGarbage = vm.runInNewContext('gc') as () => void;

test('大きなファイルを流してもメモリに溜めない: 1 かたまりずつ受け、sink が終わるまで次を引かず、渡し終えたかたまりを持ち続けない', async () => {
  const count = 400;
  let pulled = 0;
  let written = 0;
  let ahead = 0;
  const refs: Array<WeakRef<Uint8Array>> = [];
  const w = world(DNS, {
    'https://files.example.com/huge': {
      body: () => (async function* () {
        for (let i = 0; i < count; i++) {
          pulled++; ahead = Math.max(ahead, pulled - written);
          const chunk = Buffer.allocUnsafe(MiB);
          refs.push(new WeakRef(chunk));
          yield chunk;
        }
      })(),
    },
  });
  let alive = -1;
  const sink: DownloadSink = {
    write: async () => {
      written++;
      if (written === 300) {
        // WeakRef は同じ処理の区切りの中では相手を生かしておく。区切りをまたいでから集める
        await new Promise(resolve => setImmediate(resolve));
        collectGarbage();
        alive = refs.slice(0, 280).filter(ref => ref.deref() !== undefined).length;
      }
    },
    freeBytes: () => Number.MAX_SAFE_INTEGER,
  };
  const result = await downloadPublic('https://files.example.com/huge', new AbortController().signal, sink, { network: w.download });
  assert.equal(result.bytes, count * MiB);
  assert.equal(written, count);
  assert.ok(ahead <= 1, `sink より先に引いたかたまり: ${ahead}`);
  assert.equal(alive, 0, `300 個目を書いた時点で、渡し終えた 280 個のうち残っているもの: ${alive}`);
});

// ---- 本物の通信（127.0.0.1 の小さなサーバーへ。公開のアドレスの確かめは偽の世界で済んでいるので、ここはつなぎ方だけ見る）

async function withServer(t: { after(fn: () => void): void }, handler: (request: IncomingMessage, response: import('node:http').ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { server, port: (server.address() as AddressInfo).port };
}

const viaLocal = (port: number): DownloadNetwork => ({
  resolve: async () => ['93.184.216.34'],
  open: (url, _address, signal) => defaultDownloadNetwork.open(new URL(`http://127.0.0.1:${port}${url.pathname}${url.search}`), '127.0.0.1', signal),
});

test('本物の通信: 本文を流して受け取り、Accept-Encoding は送らない', async t => {
  let seen: IncomingMessage['headers'] = {};
  const { port } = await withServer(t, (request, response) => {
    seen = request.headers;
    response.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': "attachment; filename*=UTF-8''%E5%90%8D.zip" });
    response.write(Buffer.alloc(100_000, 1));
    setTimeout(() => response.end(Buffer.alloc(50_000, 2)), 20);
  });
  const memory = memorySink();
  const result = await downloadPublic('http://files.example.com/big.zip', new AbortController().signal, memory.sink, { network: viaLocal(port) });
  assert.equal(result.bytes, 150_000);
  assert.equal(memory.total(), 150_000);
  assert.equal(result.contentType, 'application/zip');
  assert.equal(result.contentDisposition, "attachment; filename*=UTF-8''%E5%90%8D.zip");
  assert.equal(seen['accept-encoding'], undefined, 'Accept-Encoding を送らない');
  assert.equal(seen.accept, '*/*');
  assert.match(String(seen['user-agent']), /^Clive\//u);
  assert.ok(memory.written.length >= 2, '複数のかたまりに分かれて届く');
});

test('本物の通信: つなぐ先は確かめたアドレスに固定し、名前の引き直しはしない（引けない名前でも、固定したアドレスにつながる）', async t => {
  let seenHost = '';
  const { port } = await withServer(t, (request, response) => {
    seenHost = String(request.headers.host);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('pinned');
  });
  // .invalid は決して引けない名前（RFC 6761）。引き直していれば ENOTFOUND で失敗する
  const response = await defaultDownloadNetwork.open(new URL(`http://pinned-check.invalid:${port}/x`), '127.0.0.1', new AbortController().signal);
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  assert.equal(response.status, 200);
  assert.equal(Buffer.concat(chunks).toString(), 'pinned');
  assert.equal(seenHost, `pinned-check.invalid:${port}`, 'Host は元の URL のまま');
});

test('本物の通信: 転送の応答は location を持って届き、圧縮の指定も見える', async t => {
  const { port } = await withServer(t, (request, response) => {
    if (request.url === '/r') { response.writeHead(302, { location: '/final' }); response.end('moved'); return; }
    response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
    response.end('zipped?');
  });
  const redirect = await defaultDownloadNetwork.open(new URL(`http://127.0.0.1:${port}/r`), '127.0.0.1', new AbortController().signal);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.location, '/final');
  redirect.close();
  const encoded = await defaultDownloadNetwork.open(new URL(`http://127.0.0.1:${port}/z`), '127.0.0.1', new AbortController().signal);
  assert.equal(encoded.contentEncoding, 'gzip');
  encoded.close();
  const memory = memorySink();
  const error = await failureOf(downloadPublic('http://files.example.com/z', new AbortController().signal, memory.sink, { network: viaLocal(port) }));
  assert.equal(error.key, 'download.encoded');
  assert.equal(memory.written.length, 0);
});

test('本物の通信: 途中で切られたら失敗にして、書いた分は返さない', async t => {
  const { port } = await withServer(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '1000000' });
    response.write(Buffer.alloc(1000, 7));
    setTimeout(() => response.destroy(), 30);
  });
  const memory = memorySink();
  const error = await failureOf(downloadPublic('http://files.example.com/cut', new AbortController().signal, memory.sink, { network: viaLocal(port) }));
  assert.equal(error.key, 'fetch.connect');
  assert.ok(memory.total() <= 1000);
});

test('本物の通信: 止まったら idleMs で止め、取り消しても、サーバーとの接続を閉じる', { timeout: 15_000 }, async t => {
  const closed: Array<Promise<void>> = [];
  const { port } = await withServer(t, (request, response) => {
    closed.push(new Promise(resolve => request.socket.once('close', () => resolve())));
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.write(Buffer.alloc(10, 1));
  });
  const idle = await failureOf(downloadPublic('http://files.example.com/stall', new AbortController().signal, memorySink().sink, { network: viaLocal(port), limits: { idleMs: 80 } }));
  assert.equal(idle.key, 'download.idle');
  await Promise.race([closed[0]!, new Promise((_, reject) => setTimeout(() => reject(new Error('接続が閉じない')), 3000))]);

  const controller = new AbortController();
  const memory = memorySink();
  const sink: DownloadSink = { write: async chunk => { await memory.sink.write(chunk); controller.abort(); }, freeBytes: memory.sink.freeBytes };
  const aborted = await failureOf(downloadPublic('http://files.example.com/stall', controller.signal, sink, { network: viaLocal(port) }));
  assert.equal(aborted.key, 'fetch.aborted');
  await Promise.race([closed[1]!, new Promise((_, reject) => setTimeout(() => reject(new Error('接続が閉じない')), 3000))]);
});

// ---- 画像の受け取り

test('fetchPublic に受ける種類を渡せる: 画像は IMAGE_TYPES で受け、HTML は断る。既定では画像を断る', async () => {
  const plans: Record<string, Plan> = {
    'https://files.example.com/a.png': { contentType: 'image/png' },
    'https://files.example.com/b.webp': { contentType: 'Image/WebP; q=1' },
    'https://files.example.com/page': { contentType: 'text/html' },
    'https://files.example.com/vector.svg': { contentType: 'image/svg+xml' },
    'https://files.example.com/jpg': { contentType: 'image/jpeg\r\nX: 1' },
  };
  const { page } = world(DNS, plans);
  assert.equal((await fetchPublic('https://files.example.com/a.png', undefined, page, 20_000, IMAGE_TYPES)).contentType, 'image/png');
  assert.equal((await fetchPublic('https://files.example.com/b.webp', undefined, page, 20_000, IMAGE_TYPES)).contentType, 'Image/WebP; q=1');
  for (const url of ['page', 'vector.svg', 'jpg']) {
    const error = await failureOf(fetchPublic(`https://files.example.com/${url}`, undefined, page, 20_000, IMAGE_TYPES));
    assert.equal(error.key, 'fetch.type', url);
  }
  const refused = await failureOf(fetchPublic('https://files.example.com/a.png', undefined, page));
  assert.equal(refused.key, 'fetch.type', '既定の fetchPublic は画像を断る');
  assert.equal((await fetchPublic('https://files.example.com/page', undefined, page)).contentType, 'text/html');
});

test('画像の通信: 画像の種類だけ受け、5MiB を 1 バイト超えたら切って truncated にする。LAN の転送は同じ決まりで断る', async t => {
  let accept = '';
  const { port } = await withServer(t, (request, response) => {
    accept = String(request.headers.accept);
    if (request.url === '/exact') { response.writeHead(200, { 'content-type': 'image/png' }); response.end(Buffer.alloc(IMAGE_MAX_BYTES)); return; }
    if (request.url === '/over') { response.writeHead(200, { 'content-type': 'image/png' }); response.end(Buffer.alloc(IMAGE_MAX_BYTES + 10)); return; }
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('<p>x</p>');
  });
  const get = (path: string) => imageNetwork.get(new URL(`http://127.0.0.1:${port}${path}`), '127.0.0.1', new AbortController().signal);
  const exact = await get('/exact');
  assert.equal(exact.body.length, IMAGE_MAX_BYTES);
  assert.equal(exact.truncated, undefined);
  const over = await get('/over');
  assert.equal(over.truncated, true);
  assert.equal(over.body.length, IMAGE_MAX_BYTES + 1, '上限を 1 バイト超えたところで切る');
  await assert.rejects(get('/page'), (error: unknown) => error instanceof RetrievalFailure && error.key === 'fetch.type');
  assert.equal(accept, 'image/png,image/jpeg,image/gif,image/webp');

  const w = world(DNS, { 'https://good.example.com/i.png': { status: 302, location: 'http://169.254.169.254/i.png' } });
  const error = await failureOf(fetchPublic('https://good.example.com/i.png', undefined, w.page, 20_000, IMAGE_TYPES));
  assert.equal(error.code, 'policy_blocked');
});
