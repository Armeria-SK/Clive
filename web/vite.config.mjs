import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = `http://127.0.0.1:${process.env.CLIVE_PORT ?? 4777}`;

const woff2Only = {
  name: 'clive-woff2-only',
  enforce: 'pre',
  transform(code, id) {
    if (!/[\\/]node_modules[\\/]@fontsource[\\/].+\.css$/.test(id)) return null;
    return code.replace(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g, '');
  },
};

// 画面だけを開発するときは `npm run dev:web`（API は npm start のサーバーへ転送する）。
// 転送するとき Origin を書き換えないと、サーバー側の認証（ほかのサイトからの書き込みを断る）で弾かれる。
export default defineConfig({
  root: 'web',
  plugins: [woff2Only, react()],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    proxy: {
      '/api': {
        target, changeOrigin: true,
        configure: proxy => { proxy.on('proxyReq', req => { if (req.getHeader('origin')) req.setHeader('origin', target); }); },
      },
    },
  },
});
