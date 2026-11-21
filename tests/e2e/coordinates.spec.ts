import { expect, test } from '@playwright/test';
import { createMockWorld, useMockWorld } from './support/world';

test.use({ viewport: { width: 1000, height: 700 }, locale: 'en-US' });

for (const renderer of ['default', 'canvas2d']) test.describe(`${renderer} center coordinates`, () => {
  test.beforeEach(async ({ context }) => {
    await useMockWorld(context);
    await context.addInitScript(() => {
      if (!sessionStorage.getItem('endless-drawing.camera.v1')) {
        sessionStorage.setItem('endless-drawing.camera.v1', JSON.stringify({ x: -1240, y: 580, zoom: 1 }));
      }
    });
  });
  const url = renderer === 'canvas2d' ? '/?renderer=canvas2d' : '/';

  test('shows the center rather than the cursor and tracks pan, anchored zoom, resize and reload', async ({ page }) => {
    await page.goto(url);
    const coordinates = page.getByRole('group', { name: 'Canvas center coordinates' });
    await expect(coordinates).toHaveText('x: −1240  y: 580');
    await expect(coordinates).toHaveAttribute('aria-live', 'off');
    await expect(coordinates).not.toHaveAttribute('tabindex');
    await page.mouse.move(10, 10);
    await expect(coordinates).toHaveText('x: −1240  y: 580');
    await page.mouse.move(500, 350); await page.mouse.wheel(120, -80);
    await expect(coordinates).toHaveText('x: −1120  y: 500');
    // Zoom around an off-center cursor: the new camera center differs from the old one.
    await page.mouse.move(750, 250); await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
    await expect.poll(() => coordinates.innerText()).not.toBe('x: −1120  y: 500');
    const camera = await page.evaluate(() => JSON.parse(sessionStorage.getItem('endless-drawing.camera.v1')!) as { x: number; y: number });
    const integer = (value: number) => { const n = Math.round(Math.abs(value)); return value < 0 && n !== 0 ? `−${n}` : String(n); };
    const text = `x: ${integer(camera.x)}  y: ${integer(camera.y)}`;
    await expect(coordinates).toHaveText(text);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(coordinates).toHaveText(text);
    const box = (await coordinates.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(12);
    expect(box.x + box.width).toBeLessThanOrEqual(390 - 12);
    expect(box.y + box.height).toBeLessThanOrEqual(844 - 12);
    await page.reload();
    await expect(coordinates).toHaveText(text);
  });

  test('stays visually quiet and passes pointer input through to the canvas', async ({ context, page }) => {
    const world = createMockWorld();
    await useMockWorld(context, world);
    await page.goto(url);
    const coordinates = page.locator('.canvas-coordinates');
    await expect(coordinates).toBeVisible();
    const style = await coordinates.evaluate((element) => {
      const css = getComputedStyle(element), box = element.getBoundingClientRect();
      return { pointerEvents: css.pointerEvents, background: css.backgroundColor, fontSize: css.fontSize,
        font: css.fontFamily, border: css.borderWidth, below: document.elementFromPoint(box.left + 2, box.top + 2)?.tagName };
    });
    expect(style).toMatchObject({ pointerEvents: 'none', background: 'rgba(0, 0, 0, 0)', fontSize: '11px', border: '0px', below: 'CANVAS' });
    expect(style.font).toContain('monospace');
    const box = (await coordinates.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + 102, box.y + box.height / 2, { steps: 4 }); await page.mouse.up();
    await expect.poll(() => world.strokes.size).toBe(1);
    await expect(coordinates).toHaveText('x: −1240  y: 580');
    await page.goto('/about/');
    await expect(page.locator('.canvas-coordinates')).toHaveCount(0);
  });
});

test('updates after a new-session spawn hint', async ({ context, page }) => {
  const world = createMockWorld();
  world.spawn = { x: 123.6, y: -456.6 };
  await useMockWorld(context, world);
  await page.goto('/');
  await expect(page.locator('.canvas-coordinates')).toHaveText('x: 124  y: −457');
});

test('world-edge coordinates fit a narrow touch viewport without scientific notation', async ({ context, page }) => {
  await useMockWorld(context);
  await context.addInitScript(() => sessionStorage.setItem('endless-drawing.camera.v1', JSON.stringify({ x: -1e9, y: 1e9, zoom: 4 })));
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  const coordinates = page.locator('.canvas-coordinates');
  await expect(coordinates).toHaveText('x: −1000000000  y: 1000000000');
  const box = (await coordinates.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(320 - 12);
  expect(await coordinates.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
});
