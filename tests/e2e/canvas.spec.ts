import { expect, test, type Page } from '@playwright/test';
import { canvasPixels } from '../support/pixels';
import { useMockWorld } from './support/world';

// Keep the original interaction suite explicitly Russian; i18n.spec.ts covers
// English, regional locales, browser preference order and unsupported languages.
test.use({ locale: 'ru-RU' });

async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.locator('canvas').evaluate(canvasPixels, { op: 'pixel', x, y }) as Promise<number[]>;
}

async function draw(page: Page, from = [250, 250], to = [450, 250]): Promise<void> {
  await page.mouse.move(from[0]!, from[1]!);
  await page.mouse.down();
  await page.mouse.move(to[0]!, to[1]!, { steps: 12 });
  await page.mouse.up();
}

async function palette(page: Page, x = 600, y = 350): Promise<void> {
  await page.mouse.click(x, y, { button: 'right' });
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function camera(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('endless-drawing.camera.v1') ?? 'null') as { x: number; y: number });
}

test.beforeEach(async ({ page, context }) => {
  await useMockWorld(context);
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('endless-drawing.camera.v1')) {
        sessionStorage.setItem('endless-drawing.camera.v1', '{"x":0,"y":0}');
      }
    } catch { /* This suite also checks blocked Storage. */ }
  });
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
});

test('opens directly on a white canvas: brand metadata, no welcome/banner/panel', async ({ page }) => {
  await expect(page).toHaveTitle('Endless Drawing');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'One drawing. Everyone. Forever.');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://endlessdrawing.com/');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.png');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('type', 'image/png');
  const icon = await page.request.get('/favicon.png');
  expect(icon.ok()).toBe(true);
  expect(icon.headers()['content-type']).toContain('image/png');
  const png = await icon.body();
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([64, 64]);
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('status')).toBeHidden();
  expect(await page.locator('body').innerText()).toBe('');
  await expect(page.locator('canvas')).toHaveAttribute('data-renderer', 'webgl');
  await expect.poll(() => pixel(page, 50, 50)).toEqual([255, 255, 255, 255]);
  const rect = await page.locator('canvas').boundingBox();
  expect(rect).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
});

test('preview is immediate; Escape cancels; completed strokes support local undo', async ({ page }) => {
  await page.mouse.move(250, 250);
  await page.mouse.down();
  await page.mouse.move(450, 250, { steps: 6 });
  await expect.poll(() => pixel(page, 350, 250)).toEqual([32, 32, 32, 255]);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => pixel(page, 350, 250)).toEqual([255, 255, 255, 255]);
  await draw(page);
  await expect.poll(() => pixel(page, 350, 250)).toEqual([32, 32, 32, 255]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pixel(page, 350, 250)).toEqual([255, 255, 255, 255]);
});

test('palette stays inside viewport and is operable by keyboard, then closes on selection/outside/Escape', async ({ page }) => {
  const size = page.viewportSize()!;
  await palette(page, size.width - 2, size.height - 2);
  const box = (await page.getByRole('dialog').boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(size.width - 7);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height - 7);
  await expect(page.getByRole('button', { name: 'Кисть', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Увеличить', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Кисть', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Рука', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('canvas')).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await palette(page);
  await page.mouse.click(30, 30);
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect.poll(() => pixel(page, 30, 30)).toEqual([255, 255, 255, 255]);
});

test('brush controls survive tool changes/reload and text fields do not trigger canvas shortcuts', async ({ page }) => {
  await palette(page);
  await page.getByRole('button', { name: 'Квадратная кисть' }).click();
  await page.getByRole('slider', { name: 'Толщина' }).evaluate((input: HTMLInputElement) => {
    input.value = '24'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('slider', { name: 'Непрозрачность' }).evaluate((input: HTMLInputElement) => {
    input.value = '0.5'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('textbox', { name: 'Цвет HEX' }).fill('#E46C60');
  await page.getByRole('textbox', { name: 'Цвет HEX' }).press('Space');
  await expect(page.getByRole('textbox', { name: 'Цвет HEX' })).toHaveValue('#E46C60'); // maxlength=7
  await page.getByRole('button', { name: 'Рука', exact: true }).click();
  await page.reload();
  await palette(page);
  await expect(page.getByRole('button', { name: 'Рука', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Квадратная кисть' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('slider', { name: 'Толщина' })).toHaveValue('24');
  await expect(page.getByRole('slider', { name: 'Непрозрачность' })).toHaveValue('0.5');
  await expect(page.getByRole('textbox', { name: 'Цвет HEX' })).toHaveValue('#E46C60');
  await page.getByRole('button', { name: 'Кисть', exact: true }).click();
  await page.mouse.click(250, 250);
  await expect.poll(() => pixel(page, 259, 259)).not.toEqual([255, 255, 255, 255]); // square corner
});

test('Space drag, middle drag and wheel move camera, not stored world geometry; camera restores', async ({ page }) => {
  await draw(page);
  await page.mouse.move(500, 400);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(550, 420);
  await page.mouse.up();
  await page.keyboard.up('Space');
  await expect.poll(() => camera(page)).toEqual({ x: -50, y: -20, zoom: 1 });
  await expect.poll(() => pixel(page, 400, 270)).toEqual([32, 32, 32, 255]);
  await page.mouse.move(500, 400);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(520, 430);
  await page.mouse.up({ button: 'middle' });
  await expect.poll(() => camera(page)).toEqual({ x: -70, y: -50, zoom: 1 });
  await page.mouse.wheel(70, 50);
  await expect.poll(() => camera(page)).toEqual({ x: 0, y: 0, zoom: 1 });
  await expect.poll(() => pixel(page, 350, 250)).toEqual([32, 32, 32, 255]);
  await page.mouse.wheel(40, -80);
  await expect.poll(() => camera(page)).toEqual({ x: 40, y: -80, zoom: 1 });
  await page.reload();
  expect(await camera(page)).toEqual({ x: 40, y: -80, zoom: 1 });
  // The stroke comes back from the server snapshot at its world position.
  await expect.poll(() => pixel(page, 350, 330)).toEqual([32, 32, 32, 255]);
  await expect.poll(() => pixel(page, 350, 250)).toEqual([255, 255, 255, 255]);
});

test('holding Space pans with plain mouse movement and releasing it restores the tool', async ({ page }) => {
  await draw(page);
  const canvas = page.locator('canvas');
  await page.mouse.move(300, 300);
  await page.keyboard.down('Space');
  await expect(canvas).toHaveCSS('cursor', 'grab');
  await page.mouse.move(360, 330, { steps: 5 }); // no button pressed
  await expect.poll(() => camera(page)).toEqual({ x: -60, y: -30, zoom: 1 });
  await expect.poll(() => pixel(page, 400, 280)).toEqual([32, 32, 32, 255]); // the stroke moved with the cursor
  await expect.poll(() => pixel(page, 350, 250)).toEqual([255, 255, 255, 255]);
  // Space + drag still works and hover-pan resumes afterwards without a jump.
  await page.mouse.down();
  await page.mouse.move(380, 340);
  await page.mouse.up();
  await page.mouse.move(390, 340);
  await expect.poll(() => camera(page)).toEqual({ x: -90, y: -40, zoom: 1 });
  await page.keyboard.up('Space');
  await expect(canvas).toHaveCSS('cursor', 'crosshair');
  await page.mouse.move(500, 500, { steps: 5 });
  await expect.poll(() => camera(page)).toEqual({ x: -90, y: -40, zoom: 1 });
  // Nothing was drawn by any of these movements.
  await expect.poll(() => pixel(page, 600, 500)).toEqual([255, 255, 255, 255]);
});

test('local eraser removes the top intersecting draft as a whole, undo then finds the remaining stroke', async ({ page }) => {
  await draw(page, [250, 250], [450, 250]);
  await draw(page, [350, 180], [350, 320]);
  await palette(page);
  await page.getByRole('button', { name: 'Ластик', exact: true }).click();
  await page.mouse.click(350, 250);
  await expect.poll(() => pixel(page, 350, 200)).toEqual([255, 255, 255, 255]);
  await expect.poll(() => pixel(page, 280, 250)).toEqual([32, 32, 32, 255]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pixel(page, 280, 250)).toEqual([255, 255, 255, 255]);
});

test('pointercancel, lost capture and blur discard unfinished drawings', async ({ page }) => {
  await page.locator('canvas').evaluate((canvas) => {
    canvas.addEventListener('pointerdown', (event) => {
      canvas.setAttribute('data-test-pointer-id', String((event as PointerEvent).pointerId));
    });
  });
  for (const reason of ['pointercancel', 'lostpointercapture', 'blur']) {
    await page.mouse.move(250, 250);
    await page.mouse.down();
    await page.mouse.move(450, 250, { steps: 4 });
    await expect.poll(() => pixel(page, 350, 250)).toEqual([32, 32, 32, 255]);
    await page.locator('canvas').evaluate((canvas, reason) => {
      if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      else {
        // Firefox can allocate pointer IDs beyond 9 across browser contexts.
        // Use the real event ID rather than guessing a small numeric range.
        const pointerId = Number(canvas.getAttribute('data-test-pointer-id'));
        canvas.dispatchEvent(new PointerEvent(reason, { pointerId }));
      }
    }, reason);
    await page.mouse.up();
    await expect.poll(() => pixel(page, 350, 250)).toEqual([255, 255, 255, 255]);
  }
});

test('Canvas renderer composites a self-intersecting stroke once; separate strokes still overlap', async ({ page }) => {
  const pixels = await page.evaluate(async () => {
    const modulePath = '/src/renderer.ts';
    const { drawStroke } = await import(modulePath);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 200;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 200, 200);
    const stroke = { points: [[-50, -50], [50, 50], [50, -50], [-50, 50]], brush: 'round', width: 10, color: '#000000', opacity: 0.5 };
    drawStroke(ctx, stroke, { x: 0, y: 0 }, { width: 200, height: 200 });
    const center = ctx.getImageData(100, 100, 1, 1).data[0];
    const arm = ctx.getImageData(70, 70, 1, 1).data[0];
    drawStroke(ctx, stroke, { x: 0, y: 0 }, { width: 200, height: 200 });
    return { center, arm, overlap: ctx.getImageData(100, 100, 1, 1).data[0] };
  });
  expect(pixels.center).toBe(pixels.arm);
  expect(pixels.center).toBeGreaterThanOrEqual(127);
  expect(pixels.center).toBeLessThanOrEqual(128);
  expect(pixels.overlap).toBeLessThan(pixels.center!);
});

test('Canvas hit-test respects round/square, line thickness, tolerance and DPR-independent coordinates', async ({ page }) => {
  const hits = await page.evaluate(async () => {
    const modulePath = '/src/renderer.ts';
    const { hitTest } = await import(modulePath);
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.scale(2, 2);
    const base = { points: [[0, 0]], brush: 'round', width: 20, color: '#000000', opacity: 1 };
    const camera = { x: 0, y: 0 };
    const viewport = { width: 200, height: 200 };
    return [
      hitTest(ctx, base, [9, 9], camera, viewport, 0),
      hitTest(ctx, { ...base, brush: 'square' }, [9, 9], camera, viewport, 0),
      hitTest(ctx, base, [14, 0], camera, viewport),
      hitTest(ctx, base, [15, 0], camera, viewport),
      hitTest(ctx, { ...base, points: [[-50, 0], [50, 0]] }, [0, 9], camera, viewport, 0),
      hitTest(ctx, { ...base, points: [[-50, 0], [50, 0]] }, [0, 15], camera, viewport),
    ];
  });
  expect(hits).toEqual([false, true, true, false, true, false]);
});

test('resizing preserves camera and recenters the same world stroke', async ({ page }) => {
  await draw(page);
  const before = await camera(page);
  await page.setViewportSize({ width: 1000, height: 600 });
  expect(await camera(page)).toEqual(before);
  // Desktop device defaults to 1280x720, so center moved by (-140,-60).
  await expect.poll(() => pixel(page, 210, 190)).toEqual([32, 32, 32, 255]);
});

test('high-DPR backing canvas keeps input in CSS pixels', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
  await useMockWorld(context);
  const page = await context.newPage();
  await page.goto('/');
  await draw(page);
  expect(await page.locator('canvas').evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([1600, 1200]);
  await expect.poll(() => pixel(page, 350, 250)).toEqual([32, 32, 32, 255]);
  await context.close();
});

test('blocked browser storage does not prevent drawing', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
    Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('blocked'); } });
  });
  await page.reload();
  await draw(page);
  await expect.poll(() => pixel(page, 350, 250)).toEqual([32, 32, 32, 255]);
});

test('a translucent stroke is blended once where it covers itself', async ({ page }) => {
  await palette(page);
  await page.getByRole('slider', { name: 'Непрозрачность' }).evaluate((input: HTMLInputElement) => {
    input.value = '0.5'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('textbox', { name: 'Цвет HEX' }).fill('#000000');
  await page.keyboard.press('Escape');
  await page.mouse.click(300, 300);
  await expect.poll(async () => (await pixel(page, 300, 300))[0]).toBeLessThan(160);
  const dot = await pixel(page, 300, 300);
  expect(dot[0]).toBeGreaterThan(100);
  await page.mouse.move(420, 400);
  await page.mouse.down();
  await page.mouse.move(520, 400, { steps: 6 });
  await page.mouse.move(420, 400, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await pixel(page, 470, 400))[0]).toBeLessThan(160);
  const retraced = await pixel(page, 470, 400);
  expect(Math.abs(retraced[0]! - dot[0]!)).toBeLessThanOrEqual(8);
  expect(retraced[3]).toBe(255);
});
