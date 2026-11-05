import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Language } from '../config/schema.ts';
import type { LocalizedError, MessageParams } from '../shared/messages/define.ts';
import { httpText, type HttpMessageKey } from '../shared/messages/http.ts';

export class HttpProblem extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly localize: ((language: Language) => string) | undefined;
  constructor(status: number, body: Record<string, unknown>, localize?: (language: Language) => string) {
    super(String(body.error ?? status));
    this.status = status;
    this.body = body;
    this.localize = localize;
  }

  render(language: Language): Record<string, unknown> {
    return this.localize ? { ...this.body, message: this.localize(language) } : this.body;
  }
}

export function problem(status: number, error: string, key: HttpMessageKey, options: { field?: string; params?: MessageParams } = {}): HttpProblem {
  const params = options.params ?? {};
  const body = { error, ...(options.field ? { field: options.field } : {}), message: httpText('ja', key, params), code: `http.${key}`, ...(Object.keys(params).length ? { params } : {}) };
  return new HttpProblem(status, body, language => httpText(language, key, params));
}

export function domainProblem<K extends string>(status: number, kind: string, error: LocalizedError<K>): HttpProblem {
  return new HttpProblem(status, { error: kind, message: error.message, code: error.fullCode, ...(Object.keys(error.params).length ? { params: error.params } : {}) }, language => error.text(language));
}

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, API_HEADERS);
  res.end(JSON.stringify(data));
}

export async function readJson(req: IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(type)) throw problem(415, 'unsupported_media_type', 'unsupported_media_type');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw problem(413, 'too_large', 'too_large_body', { params: { kb: Math.round(maxBytes / 1024) } });
    chunks.push(chunk as Buffer);
  }
  if (!total) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw problem(400, 'invalid_json', 'invalid_json'); }
}

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (declared > maxBytes) throw problem(413, 'too_large', 'too_large_file', { params: { mb: Math.round(maxBytes / 1024 / 1024) } });
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw problem(413, 'too_large', 'too_large_file', { params: { mb: Math.round(maxBytes / 1024 / 1024) } });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem(400, 'invalid_body', 'invalid_body');
  return value as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, key: string, options: { max?: number; optional?: boolean } = {}): string | undefined {
  const value = body[key];
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw problem(400, 'invalid_field', 'required', { field: key, params: { field: key } });
  if (options.max && value.length > options.max) throw problem(400, 'invalid_field', 'too_long', { field: key, params: { field: key, max: options.max } });
  return value;
}

export type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: string[]; url: URL }) => Promise<void> | void;

export class Router {
  #routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
  add(method: string, path: string, handler: Handler): this {
    const pattern = new RegExp(`^${path.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`);
    this.#routes.push({ method, pattern, handler });
    return this;
  }
  match(method: string, pathname: string): { handler: Handler; params: string[] } | 'method_not_allowed' | undefined {
    let pathMatched = false;
    for (const route of this.#routes) {
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method === method) return { handler: route.handler, params: m.slice(1).map(decodeURIComponent) };
    }
    return pathMatched ? 'method_not_allowed' : undefined;
  }
}
