import { lookup } from 'node:dns/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { isIPv4 } from 'node:net';
import type { Language } from '../../config/schema.ts';
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

const MAX_BYTES = 512 * 1024;
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

export function networkFor(accept: string, types: RegExp, maxBytes = MAX_BYTES, extraHeaders: Record<string, string> = { 'accept-language': 'ja,en;q=0.8' }): PageNetwork {
  return {
    resolve: async host => (await lookup(host, { family: 4, all: true })).map(item => item.address),
    get: (url, address, signal) => new Promise((resolve, reject) => {
      // Host と SNI は元の URL のまま、つなぐ先は確かめたアドレスに固定する。プロキシと使い回しの接続は使わない
      const request = (url.protocol === 'https:' ? httpsGet : httpGet)(url, {
        agent: false, signal, family: 4,
        lookup: (_host, _options, callback) => callback(null, address, 4),
        // Accept-Encoding は送らない（圧縮されずに返ってくる）
        headers: { accept, 'user-agent': USER_AGENT, ...extraHeaders },
      }, response => {
        const status = response.statusCode ?? 0;
        const contentType = response.headers['content-type'] ?? '';
        const location = response.headers.location;
        if (status >= 300 && status < 400) {
          response.destroy(); resolve({ status, contentType, body: Buffer.alloc(0), ...(location ? { location } : {}) }); return;
        }
        if (status !== 200 || !types.test(contentType) || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          response.destroy();
          reject(status !== 200
            ? failure(status === 404 ? 'not_found' : [401, 403, 429].includes(status) ? 'refused' : 'http_failure', 'fetch.http_status', { status }, status)
            : failure('invalid_response', 'fetch.type', { type: contentType || toolText('ja', 'fetch.type_unknown') }, status));
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
      });
      request.on('error', reject);
    }),
  };
}

export const searchNetwork = networkFor('*/*', PAGE_TYPES, MAX_BYTES, {});

export const defaultNetwork = networkFor('text/html,application/xhtml+xml,text/plain,text/markdown,text/csv,application/json,application/xml,application/rss+xml,application/atom+xml,text/xml', PAGE_TYPES);

export async function publicAddress(host: string, signal: AbortSignal, resolveHost: PageNetwork['resolve']): Promise<string> {
  signal.throwIfAborted();
  const addresses = await new Promise<string[]>((resolve, reject) => {
    const abort = () => reject(failure('aborted', 'fetch.aborted'));
    signal.addEventListener('abort', abort, { once: true });
    resolveHost(host).then(resolve, error => reject(failure('not_found', 'fetch.dns', { host, detail: (error as Error).message })))
      .finally(() => signal.removeEventListener('abort', abort));
  });
  signal.throwIfAborted();
  if (!addresses.length || !addresses.every(publicIPv4)) throw failure('policy_blocked', 'fetch.not_public', { host });
  return addresses[0]!;
}

export interface FetchedPage { url: string; contentType: string; body: Buffer; truncated: boolean }

export async function fetchPublic(input: string, signal: AbortSignal | undefined, transport: PageNetwork = defaultNetwork, timeoutMs = 20_000): Promise<FetchedPage> {
  const cancellation = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  let url = pageUrl(input);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      cancellation.throwIfAborted();
      const address = await publicAddress(url.hostname, cancellation, transport.resolve);
      const response = await transport.get(url, address, cancellation);
      cancellation.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
        if (redirects === 5) throw failure('invalid_response', 'fetch.redirects');
        const next = pageUrl(new URL(response.location, url).href);
        if (url.protocol === 'https:' && next.protocol === 'http:') throw failure('policy_blocked', 'fetch.redirect_downgrade');
        url = next;
        continue;
      }
      if (response.status !== 200) throw failure(response.status === 404 ? 'not_found' : 'http_failure', 'fetch.http_status', { status: response.status }, response.status);
      if (!PAGE_TYPES.test(response.contentType) || /[\r\n]/u.test(response.contentType)) throw failure('invalid_response', 'fetch.type', { type: response.contentType });
      return { url: url.href, contentType: response.contentType, body: response.body, truncated: Boolean(response.truncated) };
    }
  } catch (error) {
    if (error instanceof RetrievalFailure) throw error;
    if (cancellation.aborted) throw signal?.aborted ? failure('aborted', 'fetch.aborted') : failure('aborted', 'fetch.timeout', { seconds: timeoutMs / 1000 });
    throw failure('http_failure', 'fetch.connect', { detail: (error as Error).message });
  }
  throw failure('invalid_response', 'fetch.redirects');
}

const CHARSET_META = /<meta\s[^>]*?charset\s*=\s*["']?\s*([\w:.-]+)/iu;

export function decodeText(body: Buffer, contentType: string): string {
  const html = /^text\/html(?:;|$)/iu.test(contentType);
  const label = /charset\s*=\s*["']?\s*([\w:.-]+)/iu.exec(contentType)?.[1] ?? (html ? CHARSET_META.exec(body.subarray(0, 2048).toString('latin1'))?.[1] : undefined);
  if (label && !/^utf-?8$/iu.test(label)) {
    try { return new TextDecoder(label).decode(body); } catch { }
  }
  return body.toString('utf8');
}
