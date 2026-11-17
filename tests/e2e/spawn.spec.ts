import { expect, test, type Page } from '@playwright/test';
import { createMockWorld, useMockWorld } from './support/world';

// A new tab session starts at the server's entry hint (near live drawing);
// a reload keeps its own camera, and a visitor who moves first is not moved.
test.use({ locale: 'en-US', viewport: { width: 1000, height: 700 } });

const camera = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('endless-drawing.camera.v1') ?? 'null') as { x: number; y: number; zoom: number } | null);
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.locator('canvas').evaluate((canvas: HTMLCanvasElement, point) => {
    const scale = canvas.width / canvas.clientWidth;
    return Array.from(canvas.getContext('2d')!.getImageData(Math.round(point.x * scale), Math.round(point.y * scale), 1, 1).data);
  }, { x, y });
}

test('a new session lands at the entry hint next to existing drawing; reload keeps the place', async ({ page, context }) => {
  const world = createMockWorld();
  world.seed({ id: '00000000-0000-4000-8000-0000000000aa', points: [[4900, 7000], [5100, 7000]], brush: 'round', width: 12, color: '#202020', opacity: 1 });
  world.spawn = { x: 5000, y: 7000 };
  await useMockWorld(context, world);
  await page.goto('/');
  await expect.poll(() => camera(page)).toEqual({ x: 5000, y: 7000, zoom: 1 });
  await expect.poll(() => pixel(page, 500, 350)).toEqual([32, 32, 32, 255]);
  // The first subscription already covers the hint, not the old random center.
  const first = world.messages.find((m) => m.type === 'viewport.subscribe')!.bounds as { min_x: number; max_x: number };
  expect(first.min_x).toBeLessThan(5000);
  expect(first.max_x).toBeGreaterThan(5000);
  world.spawn = { x: -90_000, y: 3 };
  await page.reload();
  await expect.poll(() => world.messages.filter((m) => m.type === 'hello').length).toBe(2);
  await page.waitForTimeout(200);
  expect(await camera(page)).toEqual({ x: 5000, y: 7000, zoom: 1 });
});

test('without a hint the session keeps the local random start', async ({ page, context }) => {
  await useMockWorld(context, createMockWorld());
  await page.goto('/');
  await expect.poll(async () => (await camera(page))?.zoom).toBe(1);
  const { x, y } = (await camera(page))!;
  expect(Math.abs(x)).toBeLessThanOrEqual(250);
  expect(Math.abs(y)).toBeLessThanOrEqual(250);
});

test('a visitor who navigates before the hint arrives is not moved', async ({ page, context }) => {
  const world = createMockWorld();
  world.spawn = { x: 5000, y: 7000 };
  world.helloDelay = 800;
  await useMockWorld(context, world);
  await page.goto('/');
  // hello is sent, its ack (with the hint) is still on the way.
  await expect.poll(() => world.messages.some((m) => m.type === 'hello')).toBe(true);
  const before = (await camera(page))!;
  await page.mouse.move(500, 350);
  await page.mouse.wheel(120, 0);
  await expect.poll(async () => (await camera(page))!.x).not.toBe(before.x);
  await expect.poll(() => world.messages.some((m) => m.type === 'viewport.subscribe'), { timeout: 5000 }).toBe(true);
  const { x, y } = (await camera(page))!;
  expect(Math.abs(x - 5000)).toBeGreaterThan(1000);
  expect(Math.abs(y - 7000)).toBeGreaterThan(1000);
});
