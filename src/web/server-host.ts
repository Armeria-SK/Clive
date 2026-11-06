import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AppConfig } from '../config/schema.ts';
import { serverHostProblem } from '../shared/url.ts';
import { defaultOrigins, WebAuth, type AuthResult } from './auth.ts';

type ServerConfig = AppConfig['server'];

// 待ち受け（host・port）と認証（origins・tailscaleLogins）のどちらが、いま動いているものと違うか。
// どちらも JSON の文字で比べる（App.restartRequired と同じ決め。順番だけの違いも「違う」ので、反映すれば帯が消える）
export function serverChange(running: ServerConfig, next: ServerConfig): { listen: boolean; auth: boolean } {
  return {
    listen: running.host !== next.host || running.port !== next.port,
    auth: JSON.stringify(running.origins) !== JSON.stringify(next.origins) || JSON.stringify(running.tailscaleLogins) !== JSON.stringify(next.tailscaleLogins),
  };
}

const buildAuth = (server: ServerConfig): WebAuth => new WebAuth(defaultOrigins(server.port, server.origins), server.tailscaleLogins);

export type LockOutReason = 'port' | 'address' | 'origin' | 'login';

export type ApplyFailure =
  | { code: 'nothing_to_apply' }
  | { code: 'busy' }
  | { code: 'host_not_loopback'; host: string }
  | { code: 'bad_server' }
  | { code: 'would_lock_out'; reason: LockOutReason; params: Record<string, string> }
  | { code: 'listen_failed'; host: string; port: number; errno: string };

export type ApplyOutcome =
  | { ok: true; changed: { listen: boolean; auth: boolean }; server: ServerConfig; url: string | null; who: string; retire: () => void }
  | { ok: false; failure: ApplyFailure };

interface Requester { headers: IncomingHttpHeaders }

const hostnameOf = (hostHeader: string | undefined): string => { try { return new URL(`http://${hostHeader ?? ''}`).hostname; } catch { return ''; } };
const bare = (host: string): string => host.replace(/^\[|\]$/gu, '').toLowerCase();

// 新しい設定で、この要求を出した人が入れなくなるか。入れなくなるなら、その理由
function lockOut(request: Requester, who: Extract<AuthResult, { ok: true }> | undefined, running: ServerConfig, next: ServerConfig, newAuth: WebAuth): { reason: LockOutReason; params: Record<string, string> } | undefined {
  const moves = running.host !== next.host || running.port !== next.port;
  const post = (headers: IncomingHttpHeaders) => newAuth.check({ headers, method: 'POST' } as IncomingMessage);
  if (!who || !who.local) {
    // Tailscale から来た要求: Tailscale Serve の転送先は Clive からは変えられないので、待ち受ける場所が変われば、もう届かない
    if (moves) return { reason: 'port', params: {} };
    const verdict = post(request.headers);
    if (verdict.ok) return undefined;
    return verdict.reason === 'tailnet' || verdict.reason === 'tailnet_login'
      ? { reason: 'login', params: { login: String(who?.login ?? request.headers['tailscale-user-login'] ?? '') } }
      : { reason: 'origin', params: { origin: String(request.headers.origin ?? `https://${request.headers.host ?? ''}`) } };
  }
  // 手元（ループバック）の要求: ポートが変わるなら、新しいポートの同じ形の Host と Origin に置き換えて試す（そうしないと、手元から押してもいつも締め出しになる）
  const hostname = hostnameOf(request.headers.host);
  if (running.host !== next.host && bare(hostname) !== bare(next.host)) return { reason: 'address', params: { address: hostname } };
  const origin = `${new URL(who.origin).protocol}//${hostname}:${next.port}`;
  const verdict = post({ host: `${hostname}:${next.port}`, origin, 'sec-fetch-site': 'same-origin' });
  return verdict.ok ? undefined : { reason: 'origin', params: { origin } };
}

function listenOn(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// 入れ替えたあとの古い待ち受けを、使い終わっていない接続（応答の途中など）があっても閉じ切るまでの猶予
const RETIRE_GRACE_MS = 5000;

export interface ServerHostDeps {
  // いま動いているサーバーの設定（起動したときの値）
  running: ServerConfig;
  create: () => Server;
  // 開いている SSE を全部閉じる。認証が変わるとき（待ち受けの入れ替えでも、認証だけの入れ替えでも）呼ぶ。繋ぎ直せば、新しい認証で確かめ直される
  closeStreams: () => void;
  // 入れ替えたあとの設定を、「いま動いているもの」として覚える（再起動が要るかの比べ先）
  accept: (server: ServerConfig) => void;
  log: (line: string) => void;
}

// Web サーバーの待ち受けと認証の持ち主。プロセスは止めずに、設定の server の変更だけを入れ替える（会話の実行・ワーカー・承認待ちは止まらない）。
// 外部のコマンドもプロセスの起動もしない。反映する設定は、要求を受けたときに 1 回だけ読んだ値（呼ぶ側が渡す）で、試し・入れ替え・「いま動いているもの」の更新までを行う
export class ServerHost {
  readonly #deps: ServerHostDeps;
  #server: Server;
  #auth: WebAuth;
  #running: ServerConfig;
  #busy = false;
  readonly #retiring = new Set<Server>();

  constructor(deps: ServerHostDeps) {
    this.#deps = deps;
    this.#running = structuredClone(deps.running);
    this.#auth = buildAuth(this.#running);
    this.#server = deps.create();
  }

  get server(): Server { return this.#server; }
  get auth(): WebAuth { return this.#auth; }

  // 試験用: 待ち受けの場所は変えず、許す origin だけを入れ替える
  setOrigins(origins: readonly string[]): void { this.#auth = new WebAuth(origins, this.#running.tailscaleLogins); }

  async listen(host: string, port: number): Promise<void> {
    await listenOn(this.#server, host, port);
    this.#server.on('error', error => this.#deps.log(`[ERROR] 待ち受けのエラー: ${error.message}`));
  }

  async apply(request: Requester, next: ServerConfig, force: boolean): Promise<ApplyOutcome> {
    const fail = (failure: ApplyFailure): ApplyOutcome => ({ ok: false, failure });
    const running = this.#running;
    if (this.#busy) return fail({ code: 'busy' });
    const change = serverChange(running, next);
    if (!change.listen && !change.auth) return fail({ code: 'nothing_to_apply' });
    this.#busy = true;
    try {
      if (serverHostProblem(next.host)) return fail({ code: 'host_not_loopback', host: next.host });
      let newAuth: WebAuth;
      try { newAuth = buildAuth(next); } catch { return fail({ code: 'bad_server' }); }
      const verdict = this.#auth.check({ headers: request.headers, method: 'POST' } as IncomingMessage);
      const who = verdict.ok ? verdict : undefined;
      if (!force) {
        const locked = lockOut(request, who, running, next, newAuth);
        if (locked) return fail({ code: 'would_lock_out', ...locked });
      }
      let newServer = this.#server;
      if (change.listen) {
        newServer = this.#deps.create();
        try { await listenOn(newServer, next.host, next.port); }
        catch (error) {
          newServer.close();
          return fail({ code: 'listen_failed', host: next.host, port: next.port, errno: (error as NodeJS.ErrnoException).code ?? (error as Error).message });
        }
        newServer.on('error', error => this.#deps.log(`[ERROR] 待ち受けのエラー: ${error.message}`));
      }
      // ここから先は await しない（入れ替えの途中に別の要求が割り込んで、新旧が混ざらないように）
      const old = this.#server;
      this.#auth = newAuth;
      this.#server = newServer;
      this.#running = structuredClone(next);
      this.#deps.accept(structuredClone(next));
      this.#deps.closeStreams();
      const where = who ? (who.local ? 'この PC' : `Tailscale: ${who.login ?? '?'}`) : '不明';
      this.#deps.log(`[INFO] サーバーの設定を反映しました（待ち受け: ${change.listen ? `${running.host}:${running.port} → ${next.host}:${next.port}` : '変更なし'}、認証: ${change.auth ? '入れ替え' : '変更なし'}。押した人: ${where}）`);
      let retired = false;
      const retire = () => {
        if (retired || !change.listen) return;
        retired = true;
        this.#retiring.add(old);
        // 応答を返し終えた接続も、少し遅れて「使っていない」になるので、閉じ終わるまで何度か掃く（使っている接続は閉じない）
        const sweep = setInterval(() => old.closeIdleConnections(), 100);
        sweep.unref();
        old.close(() => { clearInterval(sweep); this.#retiring.delete(old); });
        old.closeIdleConnections();
        setTimeout(() => old.closeAllConnections(), RETIRE_GRACE_MS).unref();
      };
      const url = change.listen && who?.local ? `${new URL(who.origin).protocol}//${hostnameOf(request.headers.host)}:${next.port}/` : null;
      return { ok: true, changed: change, server: structuredClone(next), url, who: where, retire };
    } finally { this.#busy = false; }
  }

  // 終了: いまの待ち受けと、閉じている途中の古い待ち受けも、開いている流れごと閉じる
  close(): void {
    this.#deps.closeStreams();
    for (const server of [this.#server, ...this.#retiring]) {
      server.close();
      server.closeAllConnections();
    }
  }
}

export const createListener = (handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>): (() => Server) => () => createServer((req, res) => { void handle(req, res); });
