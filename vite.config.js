import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: 'renderer/src',
  base: process.env.NODE_ENV === 'production' ? './' : '/',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main:  path.resolve(__dirname, 'renderer/src/index.html'),
        setup: path.resolve(__dirname, 'renderer/src/setup/index.html')
      }
    }
  },
  server: {
    hmr: { overlay: false },
    port: 5173,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'renderer/src')
    }
  }
});
