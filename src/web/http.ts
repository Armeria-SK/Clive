import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpProblem extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error ?? status));
    this.status = status;
    this.body = body;
  }
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
  if (!/^application\/json\b/i.test(type)) throw new HttpProblem(415, { error: 'unsupported_media_type', message: 'Content-Type は application/json にしてください' });
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw new HttpProblem(413, { error: 'too_large', message: `本文が大きすぎます（上限 ${Math.round(maxBytes / 1024)}KB）` });
    chunks.push(chunk as Buffer);
  }
  if (!total) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpProblem(400, { error: 'invalid_json', message: 'JSON として読めません' }); }
}

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (declared > maxBytes) throw new HttpProblem(413, { error: 'too_large', message: `ファイルが大きすぎます（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）` });
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw new HttpProblem(413, { error: 'too_large', message: `ファイルが大きすぎます（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）` });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpProblem(400, { error: 'invalid_body', message: '本文はオブジェクトにしてください' });
  return value as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, key: string, options: { max?: number; optional?: boolean } = {}): string | undefined {
  const value = body[key];
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new HttpProblem(400, { error: 'invalid_field', field: key, message: `${key} を入力してください` });
  if (options.max && value.length > options.max) throw new HttpProblem(400, { error: 'invalid_field', field: key, message: `${key} が長すぎます（上限 ${options.max} 文字）` });
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
