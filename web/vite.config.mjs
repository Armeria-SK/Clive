import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = `http://127.0.0.1:${process.env.CLIVE_PORT ?? 4777}`;

// 画面だけを開発するときは `npm run dev:web`（API は npm start のサーバーへ転送する）。
// 転送するとき Origin を書き換えないと、サーバー側の認証（ほかのサイトからの書き込みを断る）で弾かれる。
export default defineConfig({
  root: 'web',
  plugins: [react()],
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
