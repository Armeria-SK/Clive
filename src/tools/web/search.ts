import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import type { Language } from '../../config/schema.ts';
import type { MessageParams } from '../../shared/messages/define.ts';
import { toolText, type ToolMessageKey } from '../../shared/messages/tools.ts';
import { checkBaseUrl } from '../../shared/url.ts';
import { attribute } from './html-text.ts';
import { decodeText, fetchPublic, RetrievalFailure, searchNetwork, type PageNetwork } from './public-page.ts';

export interface SearchHit { title: string; url: string; snippet: string }

export class SearchFailure extends Error {
  readonly key: ToolMessageKey | undefined;
  readonly params: MessageParams;
  constructor(message: string, key?: ToolMessageKey, params: MessageParams = {}) { super(message); this.key = key; this.params = params; }

  text(language: Language): string { return this.key ? toolText(language, this.key, this.params) : this.message; }
}

function searchFailure(key: ToolMessageKey, params: MessageParams = {}): SearchFailure {
  return new SearchFailure(toolText('ja', key, params), key, params);
}

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
    throw searchFailure('search.blocked');
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
      throw searchFailure('search.blocked');
    }
    throw error;
  }
}

const ISO_639_1 = new Set('aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(' '));
// DuckDuckGo の地域は「国-言語」。言語の部分が ISO 639-1 と違う書き方（null は言語を決めない）
const DDG_LANGUAGE = new Map<string, string | null>([['jp', 'ja'], ['kr', 'ko'], ['tzh', 'zh'], ['wt', null]]);
// 言語の部分が無い・読めないときに、国の部分から言語を決める
const COUNTRY_LANGUAGE = new Map<string, string>([['jp', 'ja'], ['kr', 'ko'], ['cn', 'zh'], ['tw', 'zh'], ['hk', 'zh'], ['uk', 'en'], ['us', 'en']]);

// 設定の地域（DuckDuckGo の書き方: jp-jp・us-en・br-pt など）を、SearXNG が受け取る言語のコード（ISO 639-1 の 2 文字）にする。
// 言語の部分（後ろ）を先に読み、読めなければ国の部分（前）から探す。直せないものは undefined（渡さない）
export function searxngLanguage(region: string): string | undefined {
  const [country = '', language = ''] = region.toLowerCase().split('-');
  if (DDG_LANGUAGE.has(language)) return DDG_LANGUAGE.get(language) ?? undefined;
  if (ISO_639_1.has(language)) return language;
  return COUNTRY_LANGUAGE.get(country) ?? (ISO_639_1.has(country) ? country : undefined);
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
  catch (error) { throw searchFailure('search.searx_connect', { origin: url.origin, detail: (error as Error).message }); }
  if (response.status === 403) throw searchFailure('search.searx_json');
  if (!response.ok) throw searchFailure('search.searx_http', { status: response.status });
  const body = await response.json().catch(() => undefined) as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> } | undefined;
  if (!Array.isArray(body?.results)) throw searchFailure('search.searx_bad');
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
    if (this.#times.length >= maxPerHour) throw searchFailure('search.limit', { max: maxPerHour });
    const last = this.#times.at(-1);
    const wait = last === undefined ? 0 : Math.max(0, minIntervalMs - (now - last));
    this.#times.push(now + wait);
    return wait;
  }
}
