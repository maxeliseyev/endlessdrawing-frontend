import { defineConfig } from 'vite';

// The backend address is a local development default, not an agreed API port.
const backend = process.env.BACKEND_DEV_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/ws': { target: backend, ws: true },
      '/healthz': { target: backend },
      '/readyz': { target: backend },
    },
  },
});
