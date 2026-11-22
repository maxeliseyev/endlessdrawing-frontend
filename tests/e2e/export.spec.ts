import { readFile } from 'node:fs/promises';
import { expect, test, type Download, type Page } from '@playwright/test';
import { createMockWorld, useMockWorld, type MockWorld } from './support/world';

// Save image: a PNG of the chosen authors only, even where two authors touch.
test.use({ locale: 'en-US', viewport: { width: 1000, height: 700 } });

const RED = '#E46C60';
const BLUE = '#7195D0';
const ALICE = '00000000-0000-4000-8000-0000000000a1';
const BOB = '00000000-0000-4000-8000-0000000000b1';

let world: MockWorld;

test.beforeEach(async ({ page, context }) => {
  world = createMockWorld();
  // Two other authors side by side across the centre (camera at the origin, zoom 1):
  // Alice ends at x = −10, Bob starts at x = 0, both width 10, so their caps overlap.
  world.seed({ id: ALICE, points: [[-100, 0], [-10, 0]], brush: 'round', width: 10, color: RED, opacity: 1 }, 'alice');
  world.seed({ id: BOB, points: [[0, 0], [100, 0]], brush: 'round', width: 10, color: BLUE, opacity: 1 }, 'bob');
  await useMockWorld(context, world);
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('endless-drawing.camera.v1')) sessionStorage.setItem('endless-drawing.camera.v1', '{"x":0,"y":0,"zoom":1}');
  });
  await page.goto('/');
  await expect.poll(() => world.messages.filter((m) => m.type === 'viewport.subscribe').length).toBeGreaterThan(0);
});

async function openSaveImage(page: Page): Promise<void> {
  await page.mouse.click(900, 600, { button: 'right' });
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Save image…' }).click();
}

async function draw(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 10 });
  await page.mouse.up();
}

interface Decoded { width: number; height: number; pixels: number[][] }

/** Decodes the downloaded PNG in the page and samples pixels (image coordinates). */
async function decode(page: Page, download: Download, points: [number, number][]): Promise<Decoded> {
  const path = await download.path();
  const base64 = (await readFile(path)).toString('base64');
  return page.evaluate(async ({ base64, points }) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const image = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data));
    return { width: image.width, height: image.height, pixels };
  }, { base64, points });
}

const near = (pixel: number[] | undefined, rgb: [number, number, number]) =>
  pixel !== undefined && pixel[3] === 255 && rgb.every((value, index) => Math.abs(pixel[index]! - value) <= 3);

test('only the chosen author goes into the PNG, even where a neighbour touches it', async ({ page }) => {
  // Above the centre: the panel covers the bottom of the screen.
  await draw(page, [250, 200], [450, 200]);
  await expect.poll(() => world.messages.filter((m) => m.type === 'stroke.create').length).toBe(1);
  await openSaveImage(page);
  const panel = page.getByRole('dialog', { name: 'Save image' });
  await expect(panel).toBeVisible();
  await expect(panel.locator('.export-summary')).toHaveText('My drawings');
  await expect(page.locator('.export-frame rect')).toBeVisible();

  // Tap Alice (adds her), tap my stroke (removes mine): only Alice remains.
  await page.mouse.click(445, 350);
  await expect(panel.locator('.export-summary')).toHaveText('My drawings + 1 author');
  await page.mouse.click(350, 200);
  await expect(panel.locator('.export-summary')).toHaveText('1 author');

  await panel.getByRole('button', { name: '1×' }).click();
  await panel.getByRole('button', { name: 'White' }).click();
  // Alice's extent x −106…−4, y −6…6, plus the 16 unit margin: 134 × 44 world units.
  await expect(panel.locator('.export-size')).toHaveText('134 × 44 px');
  const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Save PNG' }).click()]);
  expect(download.suggestedFilename()).toBe('endless-drawing_-55_0.png');
  // Image x = world x + 122, y = world y + 22.
  const png = await decode(page, download, [[72, 22], [130, 22], [2, 2], [115, 22]]);
  expect([png.width, png.height]).toEqual([134, 44]);
  expect(near(png.pixels[0], [0xE4, 0x6C, 0x60])).toBe(true); // Alice
  expect(png.pixels[1]).toEqual([255, 255, 255, 255]); // Bob's cap is right there on the canvas, not in the file
  expect(png.pixels[2]).toEqual([255, 255, 255, 255]); // white background
  expect(near(png.pixels[3], [0xE4, 0x6C, 0x60])).toBe(true); // Alice's round cap at x = −7, next to Bob's at −5
});

test('2× and a transparent background, then a hand-adjusted frame and Escape', async ({ page }) => {
  await openSaveImage(page);
  const panel = page.getByRole('dialog', { name: 'Save image' });
  // Nothing of mine yet: nothing to save.
  await expect(panel.getByRole('button', { name: 'Save PNG' })).toBeDisabled();
  await page.mouse.click(550, 350); // Bob
  await page.mouse.click(900, 100); // empty canvas: nothing changes
  await expect(panel.locator('.export-summary')).toHaveText('My drawings + 1 author');
  await panel.getByRole('button', { name: '2×' }).click();
  await panel.getByRole('button', { name: 'Transparent' }).click();
  await expect(panel.locator('.export-size')).toHaveText('288 × 88 px');
  const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Save PNG' }).click()]);
  // Bob's extent x −6…106 + margin: image x = (world x + 22) × 2.
  const png = await decode(page, download, [[(50 + 22) * 2, 44], [(-8 + 22) * 2, 44], [2, 2]]);
  expect(near(png.pixels[0], [0x71, 0x95, 0xD0])).toBe(true); // Bob
  expect(png.pixels[1]![3]).toBe(0); // Alice's cap at x = −8 is on the canvas, not in the file
  expect(png.pixels[2]![3]).toBe(0);

  // Dragging the top-left handle fixes the frame by hand; "Fit to drawings" brings the automatic one back.
  const handle = page.locator('.export-frame circle[data-corner="0"]');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 10, { steps: 4 });
  await page.mouse.up();
  await expect(panel.getByRole('button', { name: 'Fit to drawings' })).toBeVisible();
  await expect(panel.locator('.export-size')).not.toHaveText('288 × 88 px');
  await panel.getByRole('button', { name: 'Fit to drawings' }).click();
  await expect(panel.locator('.export-size')).toHaveText('288 × 88 px');
  await expect(panel.getByRole('button', { name: 'Fit to drawings' })).toBeHidden();

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.locator('.export-frame')).toBeHidden();
  // Drawing works again right away.
  await draw(page, [250, 200], [450, 200]);
  await expect.poll(() => world.messages.filter((m) => m.type === 'stroke.create').length).toBe(1);
});
