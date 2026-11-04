export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(host);
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
