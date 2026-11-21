import { expect, test, type Page } from '@playwright/test';
import { canvasPixels } from '../support/pixels';
import { coordinateText } from '../../src/coordinates';
import { createMockWorld, useMockWorld, type MockWorld } from './support/world';

// Pointer sequences are dispatched as synthetic PointerEvents so the input
// state machine is exercised identically in Chromium, Firefox and WebKit.
// This does NOT replace testing on a real iPhone/iPad with Apple Pencil:
// palm rejection and OS gesture interplay cannot be emulated.
test.use({ locale: 'en-US' });

const INK = [32, 32, 32, 255];
const WHITE = [255, 255, 255, 255];

async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.locator('canvas').evaluate(canvasPixels, { op: 'pixel', x, y }) as Promise<number[]>;
}

type Kind = 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';
async function pointer(page: Page, type: Kind, id: number, x: number, y: number, pointerType = 'touch'): Promise<void> {
  await page.locator('canvas').dispatchEvent(type, {
    pointerId: id, pointerType, isPrimary: id === 1, clientX: x, clientY: y,
    button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    bubbles: true, cancelable: true, composed: true,
  });
}
async function drag(page: Page, id: number, from: [number, number], to: [number, number], pointerType = 'touch', steps = 6): Promise<void> {
  await pointer(page, 'pointerdown', id, from[0], from[1], pointerType);
  for (let i = 1; i <= steps; i++) {
    await pointer(page, 'pointermove', id, from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, pointerType);
  }
  await pointer(page, 'pointerup', id, to[0], to[1], pointerType);
}

let world: MockWorld;
const creates = () => world.messages.filter((m) => m.type === 'stroke.create').length;
const cam = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('endless-drawing.camera.v1')!) as { x: number; y: number; zoom: number });

test.beforeEach(async ({ page, context }) => {
  world = createMockWorld();
  await useMockWorld(context, world);
  await page.addInitScript(() => sessionStorage.setItem('endless-drawing.camera.v1', '{"x":0,"y":0,"zoom":1}'));
  await page.goto('/');
  await expect.poll(() => world.messages.some((m) => m.type === 'viewport.subscribe')).toBe(true);
});

test('one finger draws with the selected brush', async ({ page }) => {
  await drag(page, 1, [300, 300], [500, 300]);
  await expect.poll(() => pixel(page, 400, 300)).toEqual(INK);
  await expect.poll(creates).toBe(1);
});

test('a second finger cancels the unfinished stroke and pinch-zooms; the leftover finger never draws', async ({ page }) => {
  await pointer(page, 'pointerdown', 1, 400, 300);
  await pointer(page, 'pointermove', 1, 440, 300);
  await expect.poll(() => pixel(page, 420, 300)).toEqual(INK); // preview
  await pointer(page, 'pointerdown', 2, 600, 300);
  await expect.poll(() => pixel(page, 420, 300)).toEqual(WHITE);
  // Spread the fingers: 200px → 400px apart around the same midpoint.
  for (let i = 1; i <= 5; i++) {
    await pointer(page, 'pointermove', 1, 440 - i * 20, 300);
    await pointer(page, 'pointermove', 2, 600 + i * 20, 300);
  }
  await expect.poll(async () => (await cam(page)).zoom).toBeCloseTo(2.25, 3);
  await expect(page.locator('.canvas-coordinates')).toHaveText(coordinateText(await cam(page)));
  await pointer(page, 'pointerup', 2, 700, 300);
  // The remaining finger moves but must not start a stroke.
  await pointer(page, 'pointermove', 1, 300, 400);
  await pointer(page, 'pointermove', 1, 250, 450);
  await pointer(page, 'pointerup', 1, 250, 450);
  await page.waitForTimeout(150);
  expect(creates()).toBe(0);
  await expect.poll(() => pixel(page, 280, 420)).toEqual(WHITE);
  // A fresh, independent touch draws again.
  await drag(page, 3, [200, 200], [300, 200]);
  await expect.poll(creates).toBe(1);
});

test('two-finger pan without spreading keeps the zoom', async ({ page }) => {
  await pointer(page, 'pointerdown', 1, 400, 300);
  await pointer(page, 'pointerdown', 2, 500, 300);
  for (let i = 1; i <= 4; i++) {
    await pointer(page, 'pointermove', 1, 400 - i * 10, 300 - i * 5);
    await pointer(page, 'pointermove', 2, 500 - i * 10, 300 - i * 5);
  }
  await pointer(page, 'pointerup', 1, 360, 280);
  await pointer(page, 'pointerup', 2, 460, 280);
  await expect.poll(() => cam(page)).toEqual({ x: 40, y: 20, zoom: 1 });
  await expect(page.locator('.canvas-coordinates')).toHaveText('x: 40  y: 20');
  expect(creates()).toBe(0);
});

test('long press opens the palette at the finger and discards the initial dot', async ({ page }) => {
  await pointer(page, 'pointerdown', 1, 300, 300);
  await page.waitForTimeout(700);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await pointer(page, 'pointerup', 1, 300, 300);
  expect(creates()).toBe(0);
  await expect.poll(() => pixel(page, 300, 300)).not.toEqual(INK);
  // Undo lives inside the palette for touch users.
  await expect(dialog.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  // A tap on the canvas closes the palette without drawing.
  await pointer(page, 'pointerdown', 2, 800, 600);
  await pointer(page, 'pointerup', 2, 800, 600);
  await expect(dialog).toBeHidden();
  expect(creates()).toBe(0);
});

test('a finger lifted over the just-opened palette is forgotten: long press works again (e.g. with Hand)', async ({ page }) => {
  await pointer(page, 'pointerdown', 1, 300, 300);
  await page.waitForTimeout(700);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Capture was released when the palette opened, so the lift lands on the palette.
  await dialog.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 300, button: 0, buttons: 0, bubbles: true });
  await dialog.getByRole('button', { name: 'Hand', exact: true }).click();
  await expect(dialog).toBeHidden();
  await pointer(page, 'pointerdown', 2, 400, 300);
  await page.waitForTimeout(700);
  await expect(dialog).toBeVisible();
  await pointer(page, 'pointerup', 2, 400, 300);
});

test('a new first touch clears a finger whose lift was never delivered', async ({ page }) => {
  await pointer(page, 'pointerdown', 5, 300, 300);
  await pointer(page, 'pointermove', 5, 340, 300);
  // No pointerup for 5 at all; the next sequence starts with a primary touch.
  await page.locator('canvas').dispatchEvent('pointerdown', { pointerId: 6, pointerType: 'touch', isPrimary: true,
    clientX: 500, clientY: 400, button: 0, buttons: 1, bubbles: true, cancelable: true });
  await page.waitForTimeout(700);
  await expect(page.getByRole('dialog')).toBeVisible(); // a single touch, not a pinch
  expect((await cam(page)).zoom).toBe(1);
  expect(creates()).toBe(0); // the stale finger's unfinished stroke was discarded
});

test('movement beyond the slop cancels the long press and keeps drawing', async ({ page }) => {
  await pointer(page, 'pointerdown', 1, 300, 300);
  await pointer(page, 'pointermove', 1, 330, 300);
  await page.waitForTimeout(700);
  await expect(page.getByRole('dialog')).toBeHidden();
  await pointer(page, 'pointerup', 1, 360, 300);
  await expect.poll(creates).toBe(1);
});

test('pencil draws; after a pen is seen, a finger pans instead of drawing', async ({ page }) => {
  await drag(page, 10, [300, 200], [500, 200], 'pen');
  await expect.poll(creates).toBe(1);
  await drag(page, 1, [500, 400], [450, 380]);
  await expect.poll(() => cam(page)).toEqual({ x: 50, y: 20, zoom: 1 });
  expect(creates()).toBe(1);
  // A palm/finger landing during a pen stroke is ignored.
  await pointer(page, 'pointerdown', 11, 300, 500, 'pen');
  await pointer(page, 'pointerdown', 2, 700, 600);
  await pointer(page, 'pointermove', 2, 650, 550);
  await pointer(page, 'pointermove', 11, 400, 500, 'pen');
  await pointer(page, 'pointerup', 11, 400, 500, 'pen');
  await pointer(page, 'pointerup', 2, 650, 550);
  await expect.poll(creates).toBe(2);
  expect((await cam(page)).x).toBe(50);
});

test('touch eraser erases on tap/drag, never on the long-press hold', async ({ page }) => {
  await drag(page, 1, [300, 300], [500, 300]);
  await expect.poll(creates).toBe(1);
  await page.mouse.click(700, 500, { button: 'right' });
  await page.getByRole('button', { name: 'Eraser', exact: true }).click();
  await pointer(page, 'pointerdown', 2, 400, 300);
  await page.waitForTimeout(700);
  await expect(page.getByRole('dialog')).toBeVisible();
  await pointer(page, 'pointerup', 2, 400, 300);
  expect(world.messages.filter((m) => m.type === 'stroke.delete')).toHaveLength(0);
  await page.keyboard.press('Escape');
  await pointer(page, 'pointerdown', 3, 400, 300);
  await pointer(page, 'pointerup', 3, 400, 300);
  await expect.poll(() => world.messages.filter((m) => m.type === 'stroke.delete').length).toBe(1);
  await expect.poll(() => pixel(page, 400, 300)).toEqual(WHITE);
});

test('pointercancel from the OS discards the stroke', async ({ page }) => {
  await pointer(page, 'pointerdown', 1, 300, 300);
  await pointer(page, 'pointermove', 1, 400, 300);
  await pointer(page, 'pointercancel', 1, 400, 300);
  await page.waitForTimeout(100);
  expect(creates()).toBe(0);
  await expect.poll(() => pixel(page, 350, 300)).toEqual(WHITE);
});

test.describe('phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('palette is a bottom sheet with 44px targets and a 16px HEX field', async ({ page, browserName }) => {
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    test.skip(!coarse, `${browserName} does not emulate a coarse pointer`);
    await pointer(page, 'pointerdown', 1, 200, 400);
    await page.waitForTimeout(700);
    await pointer(page, 'pointerup', 1, 200, 400);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveClass(/sheet/);
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.width).toBe(390);
    expect(Math.round(box.y + box.height)).toBe(844);
    for (const name of ['Brush', 'Hand', 'Eraser', 'Undo', 'Zoom in', 'Zoom out']) {
      const button = (await dialog.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(button.height).toBeGreaterThanOrEqual(44);
    }
    const font = await dialog.getByRole('textbox', { name: 'HEX color' }).evaluate((el) => getComputedStyle(el).fontSize);
    expect(font).toBe('16px');
    await expect(dialog.locator('.hint-touch')).toBeVisible();
    await expect(dialog.locator('.hint-desktop')).toBeHidden();
  });
});
