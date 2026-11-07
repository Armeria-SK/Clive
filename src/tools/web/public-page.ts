import { lookup } from 'node:dns/promises';
import { get as httpGet, type ClientRequest, type IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { isIPv4 } from 'node:net';
import type { Language } from '../../config/schema.ts';
import { IMAGE_MAX_BYTES } from '../../shared/image-info.ts';
import type { MessageParams } from '../../shared/messages/define.ts';
import { toolText, type ToolMessageKey } from '../../shared/messages/tools.ts';

export type RetrievalCode = 'not_found' | 'refused' | 'http_failure' | 'invalid_response' | 'empty_content' | 'policy_blocked' | 'invalid_request' | 'aborted';

export class RetrievalFailure extends Error {
  readonly code: RetrievalCode;
  readonly status: number | undefined;
  readonly key: ToolMessageKey | undefined;
  readonly params: MessageParams;
  constructor(code: RetrievalCode, message: string, status?: number, key?: ToolMessageKey, params: MessageParams = {}) {
    super(message);
    this.code = code; this.status = status; this.key = key; this.params = params;
  }

  text(language: Language): string { return this.key ? toolText(language, this.key, this.params) : this.message; }
}

function failure(code: RetrievalCode, key: ToolMessageKey, params: MessageParams = {}, status?: number): RetrievalFailure {
  return new RetrievalFailure(code, toolText('ja', key, params), status, key, params);
}

export function clip(text: string, max: number): string {
  const clean = text.replace(/\p{Cc}/gu, ' ');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// 相手が返した Content-Type から、画面とモデルに見せる「種類」だけを取る（パラメータ・指示のような文は捨てる）。種類の形でなければ undefined
export function mediaTypeOf(contentType: string): string | undefined {
  const media = (contentType.split(';')[0] ?? '').trim();
  return /^[\w.+-]+\/[\w.+-]+$/u.test(media) ? media.slice(0, 100) : undefined;
}

const typeShown = (contentType: string) => mediaTypeOf(contentType) ?? toolText('ja', 'fetch.type_unknown');

const MAX_BYTES = 512 * 1024;
export const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)(;|$)/iu;
const PAGE_TYPES = /^(text\/(html|plain|xml|markdown|csv)|application\/(json|xml|rss\+xml|atom\+xml|xhtml\+xml))(;|$)/iu;
const USER_AGENT = 'Clive/0.1 (personal agent; public page reader)';

export interface PageResponse { status: number; location?: string; contentType: string; body: Buffer; truncated?: boolean }
export interface PageNetwork {
  resolve(host: string): Promise<string[]>;
  get(url: URL, address: string, signal: AbortSignal): Promise<PageResponse>;
}

export function publicIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b, c] = address.split('.').map(Number) as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

export function pageUrl(input: string): URL {
  if (input.length > 4096) throw failure('invalid_request', 'fetch.too_long');
  let url: URL;
  try { url = new URL(input); } catch { throw failure('invalid_request', 'fetch.bad_url', { url: input.slice(0, 200) }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
    || url.hostname.includes(':') || !url.hostname.includes('.') || /^[\d.]+$/u.test(url.hostname) && !publicIPv4(url.hostname)
    || /\.(localhost|local|internal|home|lan|test|invalid|example|onion|arpa)\.?$/iu.test(url.hostname)) {
    throw failure('policy_blocked', 'fetch.policy');
  }
  url.hash = '';
  return url;
}

// Host と SNI は元の URL のまま、つなぐ先は確かめたアドレスに固定する。プロキシと使い回しの接続は使わない。
// Accept-Encoding は送らない（圧縮されずに返ってくる）。ページの読み取りとダウンロードが同じ接続を使う
function pinnedGet(url: URL, address: string, signal: AbortSignal, accept: string, extraHeaders: Record<string, string>, onResponse: (response: IncomingMessage) => void, onError: (error: Error) => void): ClientRequest {
  const request = (url.protocol === 'https:' ? httpsGet : httpGet)(url, {
    agent: false, signal, family: 4,
    lookup: (_host, _options, callback) => callback(null, address, 4),
    headers: { accept, 'user-agent': USER_AGENT, ...extraHeaders },
  }, onResponse);
  request.on('error', onError);
  return request;
}

const resolveIPv4 = async (host: string): Promise<string[]> => (await lookup(host, { family: 4, all: true })).map(item => item.address);

function statusFailure(status: number): RetrievalFailure {
  return failure(status === 404 ? 'not_found' : [401, 403, 429].includes(status) ? 'refused' : 'http_failure', 'fetch.http_status', { status }, status);
}

export function networkFor(accept: string, types: RegExp, maxBytes = MAX_BYTES, extraHeaders: Record<string, string> = { 'accept-language': 'ja,en;q=0.8' }): PageNetwork {
  return {
    resolve: resolveIPv4,
    get: (url, address, signal) => new Promise((resolve, reject) => {
      pinnedGet(url, address, signal, accept, extraHeaders, response => {
        const status = response.statusCode ?? 0;
        const contentType = response.headers['content-type'] ?? '';
        const location = response.headers.location;
        if (status >= 300 && status < 400) {
          response.destroy(); resolve({ status, contentType, body: Buffer.alloc(0), ...(location ? { location } : {}) }); return;
        }
        if (status !== 200 || !types.test(contentType) || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          response.destroy();
          reject(status !== 200 ? statusFailure(status) : failure('invalid_response', 'fetch.type', { type: typeShown(contentType) }, status));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          if (size + chunk.length > maxBytes) {
            // 上限で切って読み終える（テキストのページだけなので、途中までで役に立つ）
            chunks.push(chunk.subarray(0, maxBytes - size)); size = maxBytes;
            response.destroy(); resolve({ status, contentType, body: Buffer.concat(chunks), truncated: true }); return;
          }
          size += chunk.length; chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve({ status, contentType, body: Buffer.concat(chunks) }));
      }, reject);
    }),
  };
}

export const searchNetwork = networkFor('*/*', PAGE_TYPES, MAX_BYTES, {});

export const imageNetwork: PageNetwork = networkFor('image/png,image/jpeg,image/gif,image/webp', IMAGE_TYPES, IMAGE_MAX_BYTES + 1, {});

export const defaultNetwork = networkFor('text/html,application/xhtml+xml,text/plain,text/markdown,text/csv,application/json,application/xml,application/rss+xml,application/atom+xml,text/xml', PAGE_TYPES);

export async function publicAddress(host: string, signal: AbortSignal, resolveHost: PageNetwork['resolve']): Promise<string> {
  signal.throwIfAborted();
  const addresses = await new Promise<string[]>((resolve, reject) => {
    const abort = () => reject(failure('aborted', 'fetch.aborted'));
    signal.addEventListener('abort', abort, { once: true });
    resolveHost(host).then(resolve, error => reject(failure('not_found', 'fetch.dns', { host, detail: clip((error as Error).message, 200) })))
      .finally(() => signal.removeEventListener('abort', abort));
  });
  signal.throwIfAborted();
  if (!addresses.length || !addresses.every(publicIPv4)) throw failure('policy_blocked', 'fetch.not_public', { host });
  return addresses[0]!;
}

export interface FetchedPage { url: string; contentType: string; body: Buffer; truncated: boolean }

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

// ページの読み取り（fetchPublic）とダウンロード（downloadPublic）が通る、転送のたどりの全部。
// 行き先ごとに URL の形・名前を引いた先のアドレスを確かめ直し、https から http への下がりを断り、5 回までで止める。
// 最後の（転送でない）応答はそのまま返す。転送の応答と、たどりの途中で失敗したときの応答は discard で後始末する
async function followPublic<R extends { status: number; location?: string | undefined }>(
  input: string, signal: AbortSignal, resolveHost: PageNetwork['resolve'],
  send: (url: URL, address: string) => Promise<R>, discard: (response: R) => void,
): Promise<{ url: URL; response: R }> {
  let url = pageUrl(input);
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const address = await publicAddress(url.hostname, signal, resolveHost);
    const response = await send(url, address);
    try { signal.throwIfAborted(); } catch (error) { discard(response); throw error; }
    if (!REDIRECT_STATUSES.includes(response.status) || !response.location) return { url, response };
    discard(response);
    if (redirects === 5) throw failure('invalid_response', 'fetch.redirects');
    const next = pageUrl(new URL(response.location, url).href);
    if (url.protocol === 'https:' && next.protocol === 'http:') throw failure('policy_blocked', 'fetch.redirect_downgrade');
    url = next;
  }
}

function transferFailure(error: unknown, cancellation: AbortSignal, signal: AbortSignal | undefined, timeoutMs: number): RetrievalFailure {
  if (error instanceof RetrievalFailure) return error;
  if (cancellation.aborted) return signal?.aborted ? failure('aborted', 'fetch.aborted') : failure('aborted', 'fetch.timeout', { seconds: timeoutMs / 1000 });
  return failure('http_failure', 'fetch.connect', { detail: clip((error as Error).message, 200) });
}

export async function fetchPublic(input: string, signal: AbortSignal | undefined, transport: PageNetwork = defaultNetwork, timeoutMs = 20_000, types: RegExp = PAGE_TYPES): Promise<FetchedPage> {
  const cancellation = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  try {
    const { url, response } = await followPublic(input, cancellation, transport.resolve, (next, address) => transport.get(next, address, cancellation), () => undefined);
    if (response.status !== 200) throw failure(response.status === 404 ? 'not_found' : 'http_failure', 'fetch.http_status', { status: response.status }, response.status);
    if (!types.test(response.contentType) || /[\r\n]/u.test(response.contentType)) throw failure('invalid_response', 'fetch.type', { type: typeShown(response.contentType) });
    return { url: url.href, contentType: response.contentType, body: response.body, truncated: Boolean(response.truncated) };
  } catch (error) {
    throw transferFailure(error, cancellation, signal, timeoutMs);
  }
}

export interface DownloadResponse {
  status: number;
  location?: string;
  contentType: string;
  contentDisposition?: string;
  contentEncoding?: string;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}

export interface DownloadNetwork {
  resolve: PageNetwork['resolve'];
  open(url: URL, address: string, signal: AbortSignal): Promise<DownloadResponse>;
}

// ページの読み取りと同じ接続（アドレス固定・プロキシなし・Accept-Encoding なし）で、本文を溜めずに渡す
export const defaultDownloadNetwork: DownloadNetwork = {
  resolve: resolveIPv4,
  open: (url, address, signal) => new Promise((resolve, reject) => {
    const request = pinnedGet(url, address, signal, '*/*', {}, response => {
      const header = (name: 'location' | 'content-type' | 'content-disposition' | 'content-encoding') => response.headers[name];
      const location = header('location');
      const contentDisposition = header('content-disposition');
      const contentEncoding = header('content-encoding');
      resolve({
        status: response.statusCode ?? 0,
        contentType: header('content-type') ?? '',
        ...(location ? { location } : {}),
        ...(contentDisposition ? { contentDisposition } : {}),
        ...(contentEncoding ? { contentEncoding } : {}),
        body: response,
        close: () => { response.destroy(); request.destroy(); },
      });
    }, reject);
  }),
};

export interface DownloadLimits {
  // 最後のかたまりから、これだけ何も届かなければ止める
  idleMs: number;
  // 保存先の空きがこれを切ったら止める
  minFreeBytes: number;
  // 書いた量がこれだけ増えるごとに、空きを見る
  freeCheckBytes: number;
}

export const DOWNLOAD_LIMITS: DownloadLimits = Object.freeze({ idleMs: 60_000, minFreeBytes: 1024 ** 3, freeCheckBytes: 8 * 1024 * 1024 });

export interface DownloadSink {
  write(chunk: Uint8Array): Promise<void>;
  freeBytes(): number;
}

export interface Downloaded { url: string; contentType: string; contentDisposition: string | undefined; bytes: number }

// 接続して最初の応答（転送をたどった先）が届くまでの時間。本文の受け取りには総時間の上限を置かない
const CONNECT_MS = 20_000;

// promise を待つ。signal が取り消されたら、待たずに signal の理由で投げる。idleMs があれば、それだけ待っても終わらないとき idle() で投げる
function waitFor<T>(pending: Promise<T>, signal: AbortSignal, idleMs: number | undefined, idle: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
    const onAbort = () => { done(); reject(signal.reason ?? new Error('aborted')); };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    if (idleMs !== undefined) timer = setTimeout(() => { done(); reject(idle()); }, idleMs);
    pending.then(value => { done(); resolve(value); }, error => { done(); reject(error); });
  });
}

// 本文を 1 かたまりずつ sink へ渡して保存先へ流す（メモリに溜めない）。LAN を断る・転送ごとの確かめ直し・https から http への下がりを
// 断る決まりは fetchPublic と同じ followPublic。どの失敗でも応答を close() する。この関数が戻る（投げる）ときには、sink の呼び出しは
// 1 つも進行中でない（書きかけを消す側が、書き込みと取り合わない）
export async function downloadPublic(
  input: string, signal: AbortSignal, sink: DownloadSink,
  options: { network?: DownloadNetwork; limits?: Partial<DownloadLimits> } = {},
): Promise<Downloaded> {
  const network = options.network ?? defaultDownloadNetwork;
  const limits: DownloadLimits = { ...DOWNLOAD_LIMITS, ...options.limits };
  // 呼び出し元の取り消しと、接続までの時間切れの両方で止める。本文の受け取りが始まったら、時間切れの方は外す
  const link = new AbortController();
  const forward = () => link.abort(signal.reason);
  if (signal.aborted) forward(); else signal.addEventListener('abort', forward, { once: true });
  const connectTimer = setTimeout(() => link.abort(), CONNECT_MS);
  let opened: DownloadResponse | undefined;
  let sinkFault: { error: unknown } | undefined;
  const viaSink = async <T>(work: () => T | Promise<T>): Promise<T> => {
    try { return await work(); } catch (error) { sinkFault = { error }; throw error; }
  };
  try {
    const { url, response } = await followPublic(input, link.signal, network.resolve, (next, address) => network.open(next, address, link.signal), found => found.close());
    opened = response;
    clearTimeout(connectTimer);
    if (response.status !== 200) throw statusFailure(response.status);
    if (/[\r\n]/u.test(response.contentType)) throw failure('invalid_response', 'fetch.type', { type: typeShown(response.contentType) });
    const encoding = response.contentEncoding?.trim().toLowerCase();
    if (encoding && encoding !== 'identity') throw failure('invalid_response', 'download.encoded', { encoding: clip(encoding, 40) });
    const iterator = response.body[Symbol.asyncIterator]();
    let bytes = 0;
    let sinceCheck = 0;
    for (;;) {
      const step = await waitFor(iterator.next(), link.signal, limits.idleMs, () => failure('http_failure', 'download.idle', { seconds: limits.idleMs / 1000 }));
      if (step.done) break;
      const chunk = step.value;
      if (!chunk.length) continue;
      await viaSink(() => sink.write(chunk));
      link.signal.throwIfAborted();
      bytes += chunk.length; sinceCheck += chunk.length;
      if (sinceCheck >= limits.freeCheckBytes) {
        sinceCheck = 0;
        const free = await viaSink(() => sink.freeBytes());
        if (free < limits.minFreeBytes) throw failure('http_failure', 'download.disk_low', { free });
      }
    }
    return { url: url.href, contentType: response.contentType, contentDisposition: response.contentDisposition, bytes };
  } catch (error) {
    if (sinkFault && sinkFault.error === error && !link.signal.aborted && !(error instanceof RetrievalFailure)) throw error;
    throw transferFailure(error, link.signal, signal, CONNECT_MS);
  } finally {
    clearTimeout(connectTimer);
    signal.removeEventListener('abort', forward);
    opened?.close();
  }
}

const CHARSET_META =/<meta\s[^>]*?charset\s*=\s*["']?\s*([\w:.-]+)/iu;

export function decodeText(body: Buffer, contentType: string): string {
  const html = /^text\/html(?:;|$)/iu.test(contentType);
  const label = /charset\s*=\s*["']?\s*([\w:.-]+)/iu.exec(contentType)?.[1] ?? (html ? CHARSET_META.exec(body.subarray(0, 2048).toString('latin1'))?.[1] : undefined);
  if (label && !/^utf-?8$/iu.test(label)) {
    try { return new TextDecoder(label).decode(body); } catch { }
  }
  return body.toString('utf8');
}
