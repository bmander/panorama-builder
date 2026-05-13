import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      // One Rollup entry per HTML page. Each HTML file's <script type="module">
      // points at the corresponding TS source under src/, which Vite resolves
      // in dev and bundles to a hashed asset in build.
      input: {
        main: resolve(__dirname, 'index.html'),
        cp: resolve(__dirname, 'cp.html'),
        cpIndex: resolve(__dirname, 'cp-index.html'),
        history: resolve(__dirname, 'history.html'),
        photosIndex: resolve(__dirname, 'photos-index.html'),
        stationsIndex: resolve(__dirname, 'stations-index.html'),
      },
    },
  },
  server: {
    port: 5173,
    // Proxy API calls to the Go backend so the frontend served by Vite in dev
    // can hit /api/* without CORS (and so the backend's own /healthz isn't
    // shadowed by the dev server).
    proxy: { '/api': 'http://localhost:8080' },
  },
});
