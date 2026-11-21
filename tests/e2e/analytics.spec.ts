import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext } from '@playwright/test';
import { useMockWorld } from './support/world';

const origin = 'https://endlessdrawing.com';
const beacon = 'https://static.cloudflareinsights.com/beacon.min.js';

// Serve the actual production build at its production origin, but intercept ALL HTTP traffic.
// The provider script is a local stub: these tests never send real analytics or touch production.
async function productionPages(context: BrowserContext, blockBeacon = false) {
  let beaconRequests = 0;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.href === beacon) {
      beaconRequests++;
      if (blockBeacon) await route.abort();
      else await route.fulfill({ contentType: 'text/javascript', body: 'window.testBeaconLoaded = true;' });
      return;
    }
    if (url.origin !== origin) { await route.abort(); return; }
    if (url.pathname.startsWith('/api/')) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"admin_disabled"}}' });
      return;
    }
    const path = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
    const contentType = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css'
      : path.endsWith('.png') ? 'image/png' : 'text/html';
    const body = readFileSync(new URL(`../../dist${path}`, import.meta.url));
    await route.fulfill({ contentType, body });
  });
  const world = await useMockWorld(context);
  return { world, beaconRequests: () => beaconRequests };
}

test('production build loads one counter per public page but none on admin', async ({ context, page }) => {
  const server = await productionPages(context);
  for (const [index, path] of ['/', '/about/', '/privacy/', '/terms/'].entries()) {
    await page.goto(`${origin}${path}`);
    await expect(page.locator('script[data-cf-beacon]')).toHaveCount(1);
    await expect.poll(server.beaconRequests).toBe(index + 1);
    const script = page.locator('script[data-cf-beacon]');
    await expect(script).toHaveAttribute('src', beacon);
    expect(JSON.parse((await script.getAttribute('data-cf-beacon'))!)).toEqual({ token: 'd2e7f285f827487798c6d9782b926321', spa: false });
  }
  await page.goto(`${origin}/admin/`);
  await expect(page.getByRole('heading', { name: 'Administrator sign in' })).toBeVisible();
  await expect(page.locator('script[data-cf-beacon]')).toHaveCount(0);
  expect(server.beaconRequests()).toBe(4);
});

test('blocking analytics does not prevent drawing in the production build', async ({ context, page }) => {
  const server = await productionPages(context, true);
  await page.goto(`${origin}/`);
  await expect(page.locator('canvas')).toBeVisible();
  await expect.poll(server.beaconRequests).toBe(1);
  await page.mouse.move(250, 250); await page.mouse.down();
  await page.mouse.move(350, 250, { steps: 5 }); await page.mouse.up();
  await expect.poll(() => server.world.strokes.size).toBe(1);
  expect(server.beaconRequests()).toBe(1); // drawing actions are not analytics events
});

for (const ru of [false, true]) test.describe(ru ? 'Russian analytics disclosure' : 'English analytics disclosure', () => {
  test.use({ locale: ru ? 'ru-RU' : 'en-US' });
  test('privacy explains public website analytics separately from the native app', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => { if (request.url().includes('cloudflareinsights.com')) requests.push(request.url()); });
    await page.goto('/privacy/');
    await expect(page.getByRole('heading', { name: ru ? 'Аналитика сайта' : 'Website analytics' })).toBeVisible();
    await expect(page.locator('[data-copy="analyticsBody"]')).toContainText('Cloudflare Web Analytics');
    await expect(page.locator('[data-copy="updated"]')).toHaveText(ru ? 'Обновлено: 21 ноября 2026 года' : 'Last updated: November 21, 2026');
    await expect(page.locator('[data-copy="analyticsLink"]')).toHaveAttribute('href', 'https://www.cloudflare.com/privacypolicy/');
    await expect(page.locator('[data-copy="sharingBody"]')).toContainText(ru ? 'Нативное приложение для iPad' : 'The native iPad app');
    expect(requests).toEqual([]); // local/dev traffic must not pollute the counter
  });
});

test('analytics disclosure remains available without JavaScript', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  try {
    const page = await context.newPage();
    await page.goto('/privacy/');
    await expect(page.getByRole('heading', { name: 'Website analytics' })).toBeVisible();
    await expect(page.locator('[data-copy="analyticsBody"]')).toContainText('Cloudflare Web Analytics');
    await expect(page.locator('[data-copy="sharingBody"]')).not.toContainText('or third-party analytics SDKs in the app or on the website');
  } finally { await context.close(); }
});
