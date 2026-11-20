import { expect, test, type Page } from '@playwright/test';
import { canvasPixels } from '../support/pixels';
import { createMockWorld, useMockWorld, type MockWorld } from './support/world';

// Palette parity with the iPad app (header, ⋯ menu, recent colors, dragging)
// and the report flow (protocol v5) against the in-memory mock server.
test.use({ locale: 'en-US', viewport: { width: 1000, height: 700 } });

const INK = [32, 32, 32, 255];
const WHITE = [255, 255, 255, 255];
const FOREIGN = '00000000-0000-4000-8000-0000000000f1';

async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.locator('canvas').evaluate(canvasPixels, { op: 'pixel', x, y }) as Promise<number[]>;
}

async function draw(page: Page, from = [250, 500], to = [450, 500]): Promise<void> {
  await page.mouse.move(from[0]!, from[1]!);
  await page.mouse.down();
  await page.mouse.move(to[0]!, to[1]!, { steps: 10 });
  await page.mouse.up();
}

async function openMenu(page: Page): Promise<void> {
  await page.mouse.click(900, 600, { button: 'right' });
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
}

let world: MockWorld;

test.beforeEach(async ({ page, context }) => {
  world = createMockWorld();
  // Someone else's stroke across the centre of the screen (camera at the origin).
  world.seed({ id: FOREIGN, points: [[-100, 0], [100, 0]], brush: 'round', width: 10, color: '#202020', opacity: 1 });
  await useMockWorld(context, world);
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('endless-drawing.camera.v1')) sessionStorage.setItem('endless-drawing.camera.v1', '{"x":0,"y":0,"zoom":1}');
  });
  await page.goto('/');
  await expect.poll(() => pixel(page, 500, 350)).toEqual(INK);
});

test('the ⋯ menu offers report, terms and support like the iPad app', async ({ page }) => {
  await openMenu(page);
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Report drawing…' })).toBeFocused();
  await expect(menu.getByRole('menuitem', { name: 'Terms of Use' })).toHaveAttribute('href', '/terms');
  await expect(menu.getByRole('menuitem', { name: 'Contact support' })).toHaveAttribute('href', 'mailto:support@endlessdrawing.com');
  // Nothing hidden yet, and no touch screen: those items stay out of the way.
  await expect(menu.getByRole('menuitem', { name: 'Show hidden drawings' })).toBeHidden();
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Draw with finger' })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeFocused();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('a report selects the stroke, sends reason and block, hides it here and survives a reload', async ({ page }) => {
  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Report drawing…' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const bar = page.getByRole('toolbar', { name: 'Report' });
  await expect(bar).toContainText('Tap drawings to report');
  await expect(bar.getByRole('button', { name: 'Report', exact: true })).toBeDisabled();
  // A drag still pans; only a tap selects.
  await page.mouse.click(500, 352);
  await expect(bar).toContainText('Selected: 1');
  await expect(page.locator('.report-outlines rect')).toHaveCount(1);
  await bar.getByRole('button', { name: 'Report', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Report' });
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(dialog.getByLabel('Hide everything from this author')).toBeChecked();
  await dialog.getByLabel('Hate or harassment').check();
  expect(await pixel(page, 500, 350)).toEqual(INK); // nothing is hidden before Send
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(bar).toBeHidden();
  await expect(page.getByRole('status')).toHaveText('Thanks. Hidden for you — we review reports within 24 hours.');
  await expect.poll(() => pixel(page, 500, 350)).toEqual(WHITE);
  await expect.poll(() => world.reports).toEqual([
    { reporter: expect.any(String), stroke_ids: [FOREIGN], reason: 'hate', block_author: true },
  ]);

  await page.reload();
  await expect.poll(() => world.messages.filter((m) => m.type === 'viewport.subscribe').length).toBeGreaterThan(1);
  await page.waitForTimeout(300);
  expect(await pixel(page, 500, 350)).toEqual(WHITE);

  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Show hidden drawings' }).click();
  await expect.poll(() => pixel(page, 500, 350)).toEqual(INK);
});

test('own strokes cannot be reported and Escape leaves report mode', async ({ page }) => {
  await draw(page);
  await expect.poll(() => world.messages.filter((m) => m.type === 'stroke.create').length).toBe(1);
  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Report drawing…' }).click();
  const bar = page.getByRole('toolbar', { name: 'Report' });
  await page.mouse.click(350, 500);
  await expect(bar).toContainText('Tap drawings to report');
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
  expect(world.reports).toEqual([]);
});

test('a custom color joins the recent row after drawing with it', async ({ page }) => {
  await page.mouse.click(900, 600, { button: 'right' });
  const recent = page.getByRole('group', { name: 'Recent colors' });
  await expect(recent).toBeHidden();
  await page.getByLabel('HEX color', { exact: true }).fill('#12AB34');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await draw(page);
  await page.mouse.click(900, 600, { button: 'right' });
  await expect(recent.getByRole('button', { name: 'Color #12AB34' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Color #E46C60', exact: true }).click();
  await expect(recent.getByRole('button', { name: 'Color #12AB34' })).toHaveAttribute('aria-pressed', 'false');
});

test('the palette is moved by its header and closed by its button', async ({ page }) => {
  // Opened low: it is clamped to the bottom edge, so there is room to move it up.
  await page.mouse.click(300, 650, { button: 'right' });
  const palette = page.getByRole('dialog');
  const before = (await palette.boundingBox())!;
  const title = page.getByRole('heading', { name: 'Brush' });
  const grip = (await title.boundingBox())!;
  await page.mouse.move(grip.x + 10, grip.y + 5);
  await page.mouse.down();
  await page.mouse.move(grip.x + 210, grip.y - 35, { steps: 5 });
  await page.mouse.up();
  const after = (await palette.boundingBox())!;
  expect(after.x - before.x).toBeCloseTo(200, 0);
  expect(after.y - before.y).toBeCloseTo(-40, 0);
  await page.getByRole('button', { name: 'Close tools', exact: true }).click();
  await expect(palette).toBeHidden();
  await expect(page.locator('canvas')).toBeFocused();
});

test.describe('touch screen', () => {
  test.use({ hasTouch: true });

  test('Draw with finger can be switched off in the menu: one finger then pans', async ({ page }) => {
    // Firefox/WebKit touch emulation leaves maxTouchPoints at 0; a real iPad reports 5.
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 }));
    await page.reload();
    await expect.poll(() => pixel(page, 500, 350)).toEqual(INK);
    await openMenu(page);
    const toggle = page.getByRole('menuitemcheckbox', { name: 'Draw with finger' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await page.keyboard.press('Escape');
    const before = await page.evaluate(() => sessionStorage.getItem('endless-drawing.camera.v1'));
    const canvas = page.locator('canvas');
    const event = (type: string, x: number) => canvas.dispatchEvent(type, {
      pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: 600,
      button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
    });
    await event('pointerdown', 300);
    for (let x = 320; x <= 400; x += 20) await event('pointermove', x);
    await event('pointerup', 400);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('endless-drawing.camera.v1'))).not.toBe(before);
    expect(world.messages.filter((m) => m.type === 'stroke.create')).toHaveLength(0);
    await openMenu(page);
    await expect(page.getByRole('menuitemcheckbox', { name: 'Draw with finger' })).toHaveAttribute('aria-checked', 'false');
  });
});
