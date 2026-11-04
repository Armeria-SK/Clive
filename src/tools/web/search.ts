import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import { checkBaseUrl } from '../../shared/url.ts';
import { attribute } from './html-text.ts';
import { decodeText, fetchPublic, RetrievalFailure, searchNetwork, type PageNetwork } from './public-page.ts';

export interface SearchHit { title: string; url: string; snippet: string }

export class SearchFailure extends Error {}

export type SearchProvider = 'duckduckgo' | 'searxng' | 'off';

function textOf(node: Tree.Node): string {
  const out: string[] = [];
  const stack: Tree.Node[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if ('value' in n) out.push(n.value);
    else if ('childNodes' in n) for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i]!);
  }
  return out.join('').replace(/\s+/gu, ' ').trim();
}

const hasClass = (node: Tree.Element, name: string) => (attribute(node, 'class') ?? '').split(/\s+/u).includes(name);

function resolveDuckLink(href: string): string | undefined {
  try {
    const url = new URL(href, 'https://duckduckgo.com/');
    const target = url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/' ? url.searchParams.get('uddg') : url.href;
    if (!target) return undefined;
    const parsed = new URL(target);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : undefined;
  } catch { return undefined; }
}

export function parseDuckDuckGo(html: string, limit: number): SearchHit[] {
  const document = parse(html);
  const hits: SearchHit[] = [];
  const stack: Tree.Node[] = [document];
  let sawChallenge = false;
  while (stack.length && hits.length < limit) {
    const node = stack.pop()!;
    if (!('tagName' in node)) { if ('childNodes' in node) for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!); continue; }
    if (node.tagName === 'form' && /challenge/iu.test(attribute(node, 'id') ?? '')) sawChallenge = true;
    if (node.tagName === 'div' && hasClass(node, 'result') && !hasClass(node, 'result--ad')) {
      let title = ''; let url: string | undefined; let snippet = '';
      const inner: Tree.Node[] = [node];
      while (inner.length) {
        const n = inner.pop()!;
        if ('tagName' in n) {
          if (n.tagName === 'a' && hasClass(n, 'result__a')) { title = textOf(n); url = resolveDuckLink(attribute(n, 'href') ?? ''); continue; }
          if (hasClass(n, 'result__snippet')) { snippet = textOf(n); continue; }
        }
        if ('childNodes' in n) for (let i = n.childNodes.length - 1; i >= 0; i--) inner.push(n.childNodes[i]!);
      }
      if (title && url && !url.includes('duckduckgo.com/y.js')) hits.push({ title: title.slice(0, 300), url, snippet: snippet.slice(0, 500) });
      continue;
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
  }
  if (!hits.length && (sawChallenge || /anomaly|unusual traffic|bots use DuckDuckGo/iu.test(html))) {
    throw new SearchFailure('DuckDuckGo に自動アクセスと判断され、結果を返してもらえませんでした。しばらく待つか、SearXNG（tools.web.searxngUrl）に切り替えてください');
  }
  return hits;
}

export async function searchDuckDuckGo(query: string, options: { limit: number; region: string; signal?: AbortSignal | undefined; network?: PageNetwork | undefined }): Promise<SearchHit[]> {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);
  if (options.region) url.searchParams.set('kl', options.region);
  try {
    const page = await fetchPublic(url.href, options.signal, options.network ?? searchNetwork, 15_000);
    return parseDuckDuckGo(decodeText(page.body, page.contentType), options.limit);
  } catch (error) {
    // 202 は DuckDuckGo の「自動アクセスの確認」。回避はせずに知らせる
    if (error instanceof RetrievalFailure && (error.code === 'refused' || error.status === 202)) {
      throw new SearchFailure('DuckDuckGo に自動アクセスと判断され、結果を返してもらえませんでした。しばらく待つか、SearXNG（tools.web.searxngUrl）に切り替えてください');
    }
    throw error;
  }
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export async function searchSearxng(baseUrl: string, query: string, options: { limit: number; language: string; signal?: AbortSignal | undefined; fetch?: FetchLike | undefined }): Promise<SearchHit[]> {
  const checked = checkBaseUrl(baseUrl, false);
  if ('problem' in checked) throw new SearchFailure(`tools.web.searxngUrl: ${checked.problem}`);
  const url = new URL('search', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  if (options.language) url.searchParams.set('language', options.language);
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])]);
  let response: Response;
  try { response = await (options.fetch ?? fetch)(url, { signal, redirect: 'error', headers: { accept: 'application/json' } }); }
  catch (error) { throw new SearchFailure(`SearXNG（${url.origin}）につなげませんでした: ${(error as Error).message}`); }
  if (response.status === 403) throw new SearchFailure('SearXNG が JSON を返しません。settings.yml の search.formats に json を足してください');
  if (!response.ok) throw new SearchFailure(`SearXNG がエラーを返しました（HTTP ${response.status}）`);
  const body = await response.json().catch(() => undefined) as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> } | undefined;
  if (!Array.isArray(body?.results)) throw new SearchFailure('SearXNG の返事が読めませんでした');
  return body.results
    .filter(r => typeof r.title === 'string' && typeof r.url === 'string' && /^https?:\/\//u.test(r.url))
    .slice(0, options.limit)
    .map(r => ({ title: String(r.title).slice(0, 300), url: String(r.url), snippet: typeof r.content === 'string' ? r.content.slice(0, 500) : '' }));
}

export class SearchThrottle {
  #times: number[] = [];
  readonly #now: () => number;
  constructor(now: () => number = Date.now) { this.#now = now; }
  take(maxPerHour: number, minIntervalMs = 1500): number {
    const now = this.#now();
    this.#times = this.#times.filter(t => now - t < 3_600_000);
    if (this.#times.length >= maxPerHour) throw new SearchFailure(`検索は 1 時間に ${maxPerHour} 回までです（tools.web.maxSearchesPerHour）`);
    const last = this.#times.at(-1);
    const wait = last === undefined ? 0 : Math.max(0, minIntervalMs - (now - last));
    this.#times.push(now + wait);
    return wait;
  }
}
