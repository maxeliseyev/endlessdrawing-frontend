import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

function privateHeaders(request: IncomingMessage, response: ServerResponse, next: () => void): void {
  const path = request.url?.split('?')[0] ?? '';
  if (path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/admin/') || path.startsWith('/src/admin/')) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  }
  next();
}

// Match ServeDir's directory URLs in development and preview. Without this,
// Vite's SPA fallback serves the canvas for the clean /about and /privacy URLs.
function informationPageRedirect(request: IncomingMessage, response: ServerResponse, next: () => void): void {
  const url = request.url ?? '';
  const queryAt = url.indexOf('?');
  const path = queryAt < 0 ? url : url.slice(0, queryAt);
  if (path === '/about' || path === '/privacy') {
    response.writeHead(308, { Location: `${path}/${queryAt < 0 ? '' : url.slice(queryAt)}` });
    response.end();
    return;
  }
  next();
}

// The backend address is a local development default, not an agreed API port.
const backend = process.env.BACKEND_DEV_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [{ name: 'private-admin-headers',
    configureServer(server) { server.middlewares.use(privateHeaders).use(informationPageRedirect); },
    configurePreviewServer(server) { server.middlewares.use(privateHeaders).use(informationPageRedirect); },
  }],
  build: { rollupOptions: { input: {
    canvas: fileURLToPath(new URL('./index.html', import.meta.url)),
    admin: fileURLToPath(new URL('./admin/index.html', import.meta.url)),
    about: fileURLToPath(new URL('./about/index.html', import.meta.url)),
    privacy: fileURLToPath(new URL('./privacy/index.html', import.meta.url)),
  } } },
  // Vite's HTML/asset middleware otherwise overwrites earlier Cache-Control.
  // Development/preview responses are intentionally uncached; production uses backend headers.
  preview: { headers: { 'Cache-Control': 'no-store' } },
  server: {
    headers: { 'Cache-Control': 'no-store' },
    port: 5173,
    strictPort: true,
    proxy: {
      '/ws': { target: backend, ws: true },
      '/api/admin': { target: backend },
      '/healthz': { target: backend },
      '/readyz': { target: backend },
    },
  },
});
