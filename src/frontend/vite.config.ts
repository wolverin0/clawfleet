import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Vite config for theorchestra v3.0 frontend.
// Dev server proxies /api and /ws/pty to the backend on :4300.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://localhost:4300',
        changeOrigin: true,
      },
      '/ws/pty': {
        target: 'http://localhost:4300',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../../dist/frontend'),
    emptyOutDir: true,
  },
});
