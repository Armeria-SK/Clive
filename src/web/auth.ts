import type { IncomingMessage } from 'node:http';
import { isLoopbackHost } from '../shared/url.ts';

const LOGIN = /^[^\s,]{1,256}$/;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// local: この PC（ループバック）から来た要求か。login: Tailscale から来た要求のログイン名
export type AuthResult = { ok: true; origin: string; local: boolean; login?: string } | { ok: false; reason: string };

// 同じサイトの別のポートの画面（ポートを変えて反映したあと、古い画面が新しいアドレスへ移るとき）からの、最上位の移動。
// 画面の部品（静的なファイル）を取る GET だけで、API・埋め込み（iframe。CSP の frame-ancestors で別に断る）・fetch・書き込みは通さない。Host の確かめは、これも通る
function isSameSiteNavigation(req: IncomingMessage): boolean {
  return req.method === 'GET' && req.headers['sec-fetch-site'] === 'same-site' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document'
    && !(req.url ?? '').toLowerCase().startsWith('/api');
}

export class WebAuth {
  readonly origins: readonly string[];
  readonly #byHost = new Map<string, { origin: string; local: boolean }>();
  readonly #logins: ReadonlySet<string>;

  constructor(origins: readonly string[], logins: readonly string[] = []) {
    for (const origin of origins) {
      const url = new URL(origin);
      if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error(`origin の形式が正しくありません: ${origin}`);
      const local = isLoopbackHost(url.hostname);
      if (url.protocol !== 'https:' && !local) throw new Error(`この PC 以外から開く origin は https にしてください: ${origin}`);
      this.#byHost.set(url.host, { origin, local });
    }
    if (logins.some(login => !LOGIN.test(login))) throw new Error('Tailscale のログイン名の形式が正しくありません');
    this.origins = [...origins];
    this.#logins = new Set(logins.map(l => l.toLowerCase()));
  }

  check(req: IncomingMessage): AuthResult {
    const entry = this.#byHost.get(req.headers.host ?? '');
    if (!entry) return { ok: false, reason: 'host' };
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== entry.origin) return { ok: false, reason: 'origin' };
    if (WRITE_METHODS.has(req.method ?? '') && origin !== entry.origin) return { ok: false, reason: 'origin_required' };
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none' && !isSameSiteNavigation(req)) return { ok: false, reason: 'cross_site' };
    if (!entry.local) {
      const login = req.headers['tailscale-user-login'];
      if (typeof login !== 'string' || !LOGIN.test(login)) return { ok: false, reason: 'tailnet' };
      if (this.#logins.size && !this.#logins.has(login.toLowerCase())) return { ok: false, reason: 'tailnet_login' };
    }
    const login = req.headers['tailscale-user-login'];
    return { ok: true, origin: entry.origin, local: entry.local, ...(!entry.local && typeof login === 'string' ? { login } : {}) };
  }
}

export function defaultOrigins(port: number, extra: readonly string[]): string[] {
  return [...new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extra])];
}
