import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import { defaultConfig } from '../src/config/store.ts';
import type { ModelRequest, ProbeResult, ProviderAdapter, StreamEvent } from '../src/providers/types.ts';

export function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'clive-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 初期値（defaultConfig）はモデルを持たないので、モデルが要るテストはこの設定から始める。
export function testConfig(): AppConfig {
  return {
    ...defaultConfig(),
    models: [
      { id: 'claude-sonnet', label: 'Claude Sonnet 5.5', provider: 'anthropic', model: 'claude-sonnet-5-5', minContext: 65536, maxOutputTokens: 8192, toolMode: 'native', vision: true },
      { id: 'claude-haiku', label: 'Claude Haiku 5.5', provider: 'anthropic', model: 'claude-haiku-5-5', minContext: 65536, maxOutputTokens: 8192, toolMode: 'native', vision: true },
      { id: 'local', label: 'ローカル（Ollama）', provider: 'ollama', model: 'qwen3:32b', contextLength: 65536, minContext: 65536, maxOutputTokens: 8192, toolMode: 'native', vision: false },
    ],
    routing: { chat: ['claude-sonnet'], background: ['claude-haiku'], retriesPerModel: 2 },
  };
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

// PowerShell の書くコマンドレット（別名つき）は、パスが決まっていても常に今回だけ（security-self-api.md §11.13）。
// 書き込み先のパスの調べ（守る場所・禁止・外・ワイルドカード）だけを確かめるテストは、持ち主が tools.shell.allow に書いたものとして渡す。パイプを受けるものとリダイレクトは、書いていても今回だけ
export const PS_WRITER_ALLOW: readonly string[] = [
  'New-Item', 'ni', 'mkdir', 'md', 'Set-Content', 'Add-Content', 'ac', 'Clear-Content', 'clc', 'Out-File', 'Tee-Object', 'tee', 'Copy-Item', 'copy', 'cp', 'cpi',
  'Move-Item', 'move', 'mv', 'mi', 'Rename-Item', 'ren', 'rni', 'Remove-Item', 'rm', 'del', 'erase', 'rd', 'rmdir', 'ri', 'Compress-Archive',
  // ファイルに保存するダウンロードも、保存先の調べだけを確かめるテストでは、持ち主が書いたものとして渡す
  'Invoke-WebRequest', 'iwr', 'Invoke-RestMethod', 'irm', 'curl.exe',
];
