import type { IncomingMessage } from 'node:http';
import { isLoopbackHost } from '../shared/url.ts';

const LOGIN = /^[^\s,]{1,256}$/;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type AuthResult = { ok: true; origin: string } | { ok: false; reason: string };

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
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return { ok: false, reason: 'cross_site' };
    if (!entry.local) {
      const login = req.headers['tailscale-user-login'];
      if (typeof login !== 'string' || !LOGIN.test(login)) return { ok: false, reason: 'tailnet' };
      if (this.#logins.size && !this.#logins.has(login.toLowerCase())) return { ok: false, reason: 'tailnet_login' };
    }
    return { ok: true, origin: entry.origin };
  }
}

export function defaultOrigins(port: number, extra: readonly string[]): string[] {
  return [...new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extra])];
}
