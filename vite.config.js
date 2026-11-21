import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // WSL 访问 /mnt/* Windows 盘时需要轮询才能收到文件变更
    watch: { usePolling: true },
  },
  build: { outDir: 'dist' },
});
