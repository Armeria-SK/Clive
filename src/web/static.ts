import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

// 画面（HTML）には Cross-Origin-Opener-Policy も付ける: ほかのページが window.open で Clive を開いても、開いたページから Clive の window を操作できない
const HEADERS = (type: string) => ({
  'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache',
  'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  ...(type.startsWith('text/html') ? { 'Cross-Origin-Opener-Policy': 'same-origin' } : {}),
});

export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!existsSync(join(root, 'index.html'))) {
    res.writeHead(200, HEADERS('text/html; charset=utf-8'));
    res.end('<!doctype html><meta charset="utf-8"><title>Clive</title><p>画面がまだビルドされていません。<code>npm run build:web</code> を実行してから開き直してください。</p>');
    return true;
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const base = realpathSync(root);
    let file = resolve(base, `.${pathname === '/' ? '/index.html' : pathname}`);
    // 画面内のページ（/settings など）は index.html を返す
    if (!existsSync(file) && !extname(pathname)) file = join(base, 'index.html');
    file = realpathSync(file);
    const within = relative(base, file);
    const type = MIME[extname(file)];
    if (isAbsolute(within) || within.startsWith(`..${sep}`) || within === '..' || !type || !statSync(file).isFile()) return false;
    res.writeHead(200, HEADERS(type));
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
    return true;
  } catch { return false; }
}
