import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // WSL 访问 /mnt/* Windows 盘时需要轮询才能收到文件变更
    watch: { usePolling: true },
    // 开发期把 /api 代理到后端（默认 4173）；保持 changeOrigin: false 以通过服务端的 Host/Origin 一致性校验
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:4173',
        changeOrigin: false,
      },
    },
  },
  // mathjax3 产物含 top-level await，默认 target(es2020) 编译不过，需 es2022+
  build: { outDir: 'dist', target: 'es2022' },
});
