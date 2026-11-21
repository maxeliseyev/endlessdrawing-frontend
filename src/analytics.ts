// Public identifier embedded in Cloudflare's website beacon. Never import this module from admin.
export const PUBLIC_ANALYTICS_SITE_ID = 'd2e7f285f827487798c6d9782b926321';
const PUBLIC_PAGES = new Set([
  '/', '/index.html',
  '/about', '/about/', '/about/index.html',
  '/privacy', '/privacy/', '/privacy/index.html',
  '/terms', '/terms/', '/terms/index.html',
]);

/** Optional page analytics only: no canvas events, ownership keys, coordinates or custom payloads. */
export function startWebAnalytics(): void {
  if (!import.meta.env.PROD || location.origin !== 'https://endlessdrawing.com' || !PUBLIC_PAGES.has(location.pathname)) return;
  try {
    // Avoid a second counter if already installed. Keep Cloudflare automatic injection disabled.
    if (document.querySelector('script[data-cf-beacon]')) return;
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    script.dataset.cfBeacon = JSON.stringify({ token: PUBLIC_ANALYTICS_SITE_ID, spa: false });
    document.head.append(script);
  } catch {
    // Analytics is optional: DOM restrictions or blockers must never prevent drawing or reading a page.
  }
}
