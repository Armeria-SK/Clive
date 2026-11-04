export type HttpErrorKind = 'network' | 'timeout' | 'aborted' | 'status' | 'invalid';

export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly status: number | undefined;
  constructor(kind: HttpErrorKind, status?: number) {
    super(`HTTP request ${kind}${status === undefined ? '' : ` (${status})`}`);
    this.kind = kind;
    this.status = status;
  }
}

export async function httpJson(url: URL, options: {
  body?: unknown; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; fetch?: typeof fetch; headers?: Record<string, string>;
} = {}): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new HttpError('invalid');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new HttpError(timedOut ? 'timeout' : 'aborted'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  const work = async () => {
    controller.signal.throwIfAborted();
    const response = await (options.fetch ?? fetch)(url, {
      method: options.body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new HttpError('status', response.status); }
    const reader = response.body?.getReader();
    if (!reader) throw new HttpError('invalid');
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), cancelled]);
        if (done) break;
        total += value.length;
        if (total > maxBytes) throw new HttpError('invalid');
        chunks.push(value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
      catch { throw new HttpError('invalid'); }
    } finally { void reader.cancel().catch(() => undefined); }
  };
  try { return await Promise.race([work(), cancelled]); }
  catch (error) { throw error instanceof HttpError ? error : new HttpError('network'); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort); }
}
