import { expect, test, type Browser, type Page } from '@playwright/test';
import { createMockWorld, useMockWorld, type MockWorld } from './support/world';

test.use({ locale: 'en-US' });

const INK = [32, 32, 32, 255];
const WHITE = [255, 255, 255, 255];

async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.locator('canvas').evaluate((canvas: HTMLCanvasElement, point) => {
    const scale = canvas.width / canvas.clientWidth;
    return Array.from(canvas.getContext('2d')!.getImageData(Math.round(point.x * scale), Math.round(point.y * scale), 1, 1).data);
  }, { x, y });
}

async function draw(page: Page, from = [250, 250], to = [450, 250]): Promise<void> {
  await page.mouse.move(from[0]!, from[1]!);
  await page.mouse.down();
  await page.mouse.move(to[0]!, to[1]!, { steps: 10 });
  await page.mouse.up();
}

async function open(browser: Browser, world: MockWorld): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, locale: 'en-US' });
  await useMockWorld(context, world);
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('endless-drawing.camera.v1')) sessionStorage.setItem('endless-drawing.camera.v1', '{"x":0,"y":0,"zoom":1}');
  });
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

const creates = (world: MockWorld) => world.messages.filter((m) => m.type === 'stroke.create');

test('two visitors share one world; only the author can erase or undo a stroke', async ({ browser }) => {
  const world = createMockWorld();
  const author = await open(browser, world);
  const visitor = await open(browser, world);
  await draw(author);
  await expect.poll(() => pixel(visitor, 350, 250)).toEqual(INK);

  // The visitor's eraser ignores a foreign stroke: nothing is even sent.
  await visitor.mouse.click(500, 350, { button: 'right' });
  await visitor.getByRole('button', { name: 'Eraser', exact: true }).click();
  await visitor.mouse.click(350, 250);
  await visitor.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pixel(visitor, 350, 250)).toEqual(INK);
  expect(world.messages.filter((m) => m.type === 'stroke.delete')).toHaveLength(0);

  // Ownership survives a reload of the same tab session (secret in sessionStorage).
  await author.reload();
  await expect.poll(() => pixel(author, 350, 250)).toEqual(INK);
  await author.locator('canvas').focus();
  await author.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pixel(author, 350, 250)).toEqual(WHITE);
  await expect.poll(() => pixel(visitor, 350, 250)).toEqual(WHITE);
  const hello = world.messages.filter((m) => m.type === 'hello');
  expect(new Set(hello.map((m) => m.session_secret)).size).toBe(2);
  for (const m of hello) expect(m.session_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // The secret never appears in the URL or the stroke payload.
  expect(author.url()).not.toContain(String(hello[0]!.session_secret));
  for (const m of creates(world)) expect(JSON.stringify(m)).not.toContain('session_secret');
  await author.context().close();
  await visitor.context().close();
});

test('the eraser deletes the newest own stroke, not a foreign one on top', async ({ browser }) => {
  const world = createMockWorld();
  const page = await open(browser, world);
  await draw(page, [250, 250], [450, 250]);
  await expect.poll(() => creates(world).length).toBe(1);
  // A foreign stroke with a higher seq crossing ours.
  world.seed({ id: '00000000-0000-4000-8000-0000000000f0', points: [[-150, -200], [-150, 0]], brush: 'round', width: 12, color: '#E46C60', opacity: 1 });
  await page.reload();
  await expect.poll(() => pixel(page, 350, 200)).not.toEqual(WHITE);
  await page.mouse.click(500, 350, { button: 'right' });
  await page.getByRole('button', { name: 'Eraser', exact: true }).click();
  await page.mouse.click(350, 250);
  await expect.poll(() => pixel(page, 300, 250)).toEqual(WHITE);
  await expect.poll(() => pixel(page, 350, 200)).not.toEqual(WHITE);
  await page.context().close();
});

test('unconfirmed strokes stay visible, undo hides them, and the delete follows the ack', async ({ browser }) => {
  const world = createMockWorld();
  const page = await open(browser, world);
  world.holdAcks = true;
  await draw(page);
  await expect.poll(() => pixel(page, 350, 250)).toEqual(INK);
  await expect.poll(() => creates(world).length).toBe(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pixel(page, 350, 250)).toEqual(WHITE);
  expect(world.messages.filter((m) => m.type === 'stroke.delete')).toHaveLength(0);
  world.releaseAcks();
  await expect.poll(() => world.messages.filter((m) => m.type === 'stroke.delete').length).toBe(1);
  await expect.poll(() => [...world.strokes.values()].every((s) => s.deleted)).toBe(true);
  await expect.poll(() => pixel(page, 350, 250)).toEqual(WHITE);
  await page.context().close();
});

test('a dropped connection resends the same UUID and payload after a fresh hello', async ({ browser }) => {
  const world = createMockWorld();
  const page = await open(browser, world);
  await expect.poll(() => world.messages.filter((m) => m.type === 'viewport.subscribe').length).toBeGreaterThan(0);
  world.holdAcks = true;
  await draw(page);
  await expect.poll(() => creates(world).length).toBe(1);
  world.held.length = 0; // The ack is lost with the connection.
  world.holdAcks = false;
  world.dropSockets();
  await expect.poll(() => creates(world).length, { timeout: 10_000 }).toBe(2);
  const [first, retry] = creates(world) as { request_id: string; stroke: unknown }[];
  expect(retry!.stroke).toEqual(first!.stroke);
  expect(retry!.request_id).not.toBe(first!.request_id);
  expect(world.messages.filter((m) => m.type === 'hello').length).toBe(2);
  expect(world.strokes.size).toBe(1);
  await expect.poll(() => pixel(page, 350, 250)).toEqual(INK);
  await page.context().close();
});

test('limited zoom: Ctrl+wheel around the cursor, keyboard and palette, scaled geometry and tolerance', async ({ browser }) => {
  const world = createMockWorld();
  const page = await open(browser, world);
  await draw(page, [400, 350], [600, 350]); // world y = 0, x = -100..100
  await expect.poll(() => creates(world).length).toBe(1);
  const cam = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('endless-drawing.camera.v1')!) as { x: number; y: number; zoom: number });
  await page.mouse.move(500, 350);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -50);
    await page.keyboard.up('Control');
  }
  await expect.poll(async () => (await cam()).zoom).toBeGreaterThan(3.9);
  expect((await cam()).zoom).toBeLessThanOrEqual(4);
  // Width 6 at 4× is 24 CSS px thick around the anchored center.
  await expect.poll(() => pixel(page, 500, 360)).toEqual(INK);
  await expect.poll(() => pixel(page, 500, 375)).toEqual(WHITE);
  await page.locator('canvas').focus();
  await page.keyboard.press('ControlOrMeta+0');
  await expect.poll(async () => (await cam()).zoom).toBe(1);
  await page.mouse.click(500, 350, { button: 'right' });
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await dialog.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(dialog.locator('#zoom-reset')).toHaveText('64%');
  for (let i = 0; i < 10; i++) await dialog.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(dialog.locator('#zoom-reset')).toHaveText('16%');
  await dialog.getByRole('button', { name: /Reset to 100%/ }).click();
  await expect(dialog.locator('#zoom-reset')).toHaveText('100%');
  // The eraser tolerance stays 4 screen px at 16%: just outside it nothing is removed.
  for (let i = 0; i < 9; i++) await dialog.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(dialog.locator('#zoom-reset')).toHaveText('16%');
  await dialog.getByRole('button', { name: 'Eraser', exact: true }).click();
  // Width 6 at 16% is 0.96 CSS px: half of it is 0.48.
  await page.mouse.click(500, 350 + 0.48 + 4 + 2);
  expect(world.messages.filter((m) => m.type === 'stroke.delete')).toHaveLength(0);
  await page.mouse.click(500, 350 + 0.48 + 3);
  await expect.poll(() => world.messages.filter((m) => m.type === 'stroke.delete').length).toBe(1);
  // Subscriptions follow the zoomed-out view and never exceed the server span.
  for (const m of world.messages.filter((m) => m.type === 'viewport.subscribe')) {
    const b = m.bounds as { min_x: number; max_x: number; min_y: number; max_y: number };
    expect(b.max_x - b.min_x).toBeLessThanOrEqual(30_000);
    expect(b.max_y - b.min_y).toBeLessThanOrEqual(30_000);
  }
  await page.context().close();
});
