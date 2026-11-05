import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import type { ModelRequest, ProbeResult, ProviderAdapter, StreamEvent } from '../src/providers/types.ts';

export function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'clive-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface FakeServer { url: string; requests: Array<{ method: string; path: string; body: any; headers: IncomingMessage['headers'] }>; close: () => Promise<void> }

export async function fakeServer(handler: (req: IncomingMessage, body: any, res: ServerResponse) => void | Promise<void>): Promise<FakeServer> {
  const requests: FakeServer['requests'] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: any = raw;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { }
    requests.push({ method: req.method ?? 'GET', path: req.url ?? '/', body, headers: req.headers });
    await handler(req, body, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`, requests,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export function sse(res: ServerResponse, chunks: unknown[], options: { done?: boolean; event?: (c: any) => string | undefined } = {}): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const c of chunks) {
    const name = options.event?.(c);
    res.write(`${name ? `event: ${name}\n` : ''}data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
  }
  if (options.done ?? true) res.write('data: [DONE]\n\n');
  res.end();
}

export type Script = (req: ModelRequest) => AsyncGenerator<StreamEvent>;

export class FakeAdapter implements ProviderAdapter {
  readonly provider: ProviderConfig;
  readonly calls: ModelRequest[] = [];
  scripts: Script[];
  probeResult: Partial<ProbeResult> = {};
  readonly probeLanguages: Array<string | undefined> = [];
  constructor(provider: ProviderConfig, scripts: Script[] = []) { this.provider = provider; this.scripts = scripts; }
  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    this.calls.push(req);
    const script = this.scripts.shift() ?? reply('（台本なし）');
    yield* script(req);
  }
  async probe(model: ModelConfig, required: number, language?: string): Promise<ProbeResult> {
    this.probeLanguages.push(language);
    const effective = model.contextLength ?? 200_000;
    return { modelId: model.id, server: 'fake', required, declared: model.contextLength, effective, status: effective >= required ? 'ok' : 'too_small', message: 'fake', checkedAt: Date.now(), ...this.probeResult };
  }
}

export function reply(text: string, usage: { inputTokens?: number; outputTokens?: number } = {}): Script {
  return async function* () {
    for (const part of text.match(/.{1,5}/gsu) ?? []) yield { type: 'text', delta: part };
    if (Object.keys(usage).length) yield { type: 'usage', usage };
    yield { type: 'done', stop: 'end_turn' };
  };
}

export function fail(error: Error, partial = ''): Script {
  return async function* () {
    if (partial) yield { type: 'text', delta: partial };
    throw error;
  };
}
