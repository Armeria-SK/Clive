export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

// server.host の検査。この PC の外には待ち受けない（ほかの端末からは Tailscale Serve 経由）。問題が無ければ undefined。起動（main.ts）と、画面からの反映（src/web/server-host.ts）が同じ検査を使う
export function serverHostProblem(host: string): string | undefined {
  return isLoopbackHost(host) ? undefined : `server.host は 127.0.0.1 などのループバックにしてください（今は ${host}）。ほかの端末からは Tailscale Serve 経由で開きます（README の「ほかの端末から使う」）`;
}

export function checkBaseUrl(value: string, usesApiKey: boolean): { url: string } | { problem: string } {
  let url: URL;
  try { url = new URL(value); } catch { return { problem: 'URL として読めません' }; }
  if (url.username || url.password || url.search || url.hash) return { problem: '認証情報・クエリ・# を含めないでください' };
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { problem: 'http か https にしてください' };
  if (url.protocol === 'http:' && usesApiKey && !isLoopbackHost(url.hostname)) {
    return { problem: 'API キーを使う接続は https にしてください（http はこの PC のサーバーだけ）' };
  }
  return { url: url.href.replace(/\/+$/u, '') };
}
