import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BusEvent, RunBus } from '../engine/bus.ts';

export const MAX_STREAMS = 32;
const MAX_BUFFERED = 1024 * 1024;
const HEARTBEAT_MS = 15_000;

export class LiveStreams {
  readonly #bus: RunBus;
  #streams = new Set<ServerResponse>();
  #unsubscribe: (() => void) | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(bus: RunBus) { this.#bus = bus; }

  get size(): number { return this.#streams.size; }

  open(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (this.#streams.size >= MAX_STREAMS) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'too_many_streams' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no', Connection: 'keep-alive',
    });
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true, HEARTBEAT_MS);
    this.#streams.add(res);
    this.#start();
    const done = () => this.#remove(res);
    req.once('close', done); res.once('close', done); res.once('error', done);

    this.#write(res, 'retry: 3000\n\n');
    const lastHeader = req.headers['last-event-id'];
    const lastParam = url.searchParams.get('after');
    const boot = url.searchParams.get('boot');
    const after = Number(typeof lastHeader === 'string' ? lastHeader : lastParam ?? NaN);
    this.#named(res, 'hello', { bootId: this.#bus.bootId, lastSeq: this.#bus.lastSeq, drafts: this.#bus.drafts() });
    if (Number.isFinite(after) && (!boot || boot === this.#bus.bootId)) {
      const missed = this.#bus.since(after);
      if (missed === undefined) this.#named(res, 'resync', { reason: 'too_old' });
      else for (const e of missed) this.#event(res, e);
    } else if (boot && boot !== this.#bus.bootId) {
      this.#named(res, 'resync', { reason: 'restarted' });
    }
  }

  close(): void { for (const res of [...this.#streams]) { res.end(); this.#remove(res); } }

  #start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#bus.subscribe(e => { for (const res of [...this.#streams]) this.#event(res, e); });
    this.#heartbeat = setInterval(() => { for (const res of [...this.#streams]) this.#write(res, ': ping\n\n'); }, HEARTBEAT_MS);
    this.#heartbeat.unref();
  }

  #remove(res: ServerResponse): void {
    if (!this.#streams.delete(res)) return;
    if (!res.writableEnded) res.end();
    if (!this.#streams.size) {
      this.#unsubscribe?.(); this.#unsubscribe = undefined;
      clearInterval(this.#heartbeat); this.#heartbeat = undefined;
    }
  }

  #event(res: ServerResponse, e: BusEvent): void {
    this.#write(res, `id: ${e.seq}\nevent: run\ndata: ${JSON.stringify(e.event)}\n\n`);
  }

  #named(res: ServerResponse, name: string, data: unknown): void {
    this.#write(res, `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  #write(res: ServerResponse, text: string): void {
    if (res.writableEnded || res.destroyed) { this.#remove(res); return; }
    // 受け取れていない画面のためにいつまでも溜めない。切られた画面は再接続して取り直す
    if (res.writableLength > MAX_BUFFERED) { res.destroy(); this.#remove(res); return; }
    res.write(text);
  }
}
