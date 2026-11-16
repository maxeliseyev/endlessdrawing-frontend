import { expect, test, type Page } from '@playwright/test';

async function image(page: Page): Promise<string> {
  return page.locator('canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL());
}

async function ink(page: Page): Promise<{ count: number; first: { x: number; y: number } | null }> {
  return page.locator('canvas').evaluate((c: HTMLCanvasElement) => {
    const scale = c.width / c.clientWidth;
    const size = Math.round(80 * scale);
    const pixels = c.getContext('2d')!.getImageData(Math.round(260 * scale), Math.round(260 * scale), size, size).data;
    let count = 0;
    let first = null;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i]! < 230) {
        count++;
        first ??= { x: 260 + ((i / 4) % size) / scale, y: 260 + Math.floor(i / 4 / size) / scale };
      }
    }
    return { count, first };
  });
}

for (const locale of ['en-US', 'ru-RU']) {
  for (const brush of ['chisel', 'spray'] as const) {
    test.describe(`${locale}: ${brush}`, () => {
      test.use({ locale });
      test('supports preview, deterministic redraw, undo, eraser and preference restore', async ({ page }) => {
        const ru = locale === 'ru-RU';
        const name = brush === 'chisel' ? (ru ? 'Косое перо' : 'Chisel pen') : (ru ? 'Спрей' : 'Spray');
        await page.goto('/');
        await page.mouse.click(600, 350, { button: 'right' });
        await page.getByRole('button', { name, exact: true }).click();
        await page.getByRole('slider', { name: ru ? 'Толщина' : 'Width' }).evaluate((input: HTMLInputElement) => {
          input.value = '48'; input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.getByRole('slider', { name: ru ? 'Непрозрачность' : 'Opacity' }).evaluate((input: HTMLInputElement) => {
          input.value = '0.5'; input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.keyboard.press('Escape');
        await page.mouse.move(300, 300);
        await page.mouse.down();
        await expect.poll(async () => (await ink(page)).count).toBeGreaterThan(20);
        const preview = await image(page);
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expect.poll(async () => (await ink(page)).count).toBe(0);
        await page.mouse.down();
        await expect.poll(async () => (await ink(page)).count).toBeGreaterThan(20);
        // New strokes get new UUIDs: a spray cloud may differ from the canceled one.
        const completedPreview = await image(page);
        await page.mouse.up();
        await expect.poll(() => image(page)).toBe(completedPreview);
        if (brush === 'chisel') expect(completedPreview).toBe(preview);
        const selected = (await ink(page)).first!;
        await page.mouse.wheel(40, 20);
        await expect.poll(() => image(page)).not.toBe(completedPreview);
        await page.mouse.wheel(-40, -20);
        await expect.poll(() => image(page)).toBe(completedPreview);

        await page.mouse.move(350, 400);
        await page.mouse.down();
        await page.mouse.move(450, 400, { steps: 8 });
        await page.mouse.up();
        await expect.poll(() => image(page)).not.toBe(completedPreview);
        await page.keyboard.press('ControlOrMeta+z');
        await expect.poll(() => image(page)).toBe(completedPreview);
        await page.mouse.click(600, 350, { button: 'right' });
        await page.getByRole('button', { name: ru ? 'Ластик' : 'Eraser', exact: true }).click();
        await page.mouse.click(selected.x, selected.y);
        await expect.poll(async () => (await ink(page)).count).toBe(0);
        await page.reload();
        await page.mouse.click(600, 350, { button: 'right' });
        await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByRole('slider', { name: ru ? 'Толщина' : 'Width' })).toHaveValue('48');
        await expect(page.getByRole('slider', { name: ru ? 'Непрозрачность' : 'Opacity' })).toHaveValue('0.5');
      });
    });
  }
}

test('effect renderer composites overlap once, preserves alpha, and scales the same geometry at DPR 2', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const rendererPath = '/src/renderer.ts';
    const { drawStroke } = await import(rendererPath);
    return ['chisel', 'spray'].map((brush) => {
      const render = (dpr: number, opacity: number, twice = false) => {
        const c = document.createElement('canvas');
        c.width = c.height = 200 * dpr;
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.scale(dpr, dpr);
        const stroke = { id: '87a122fa-7537-4b88-9b77-b45d24a29714', brush, width: 48, color: '#000000', opacity,
          points: [[-40, -40], [40, 40], [40, -40], [-40, 40]] };
        drawStroke(ctx, stroke, { x: 0, y: 0 }, { width: 200, height: 200 });
        if (twice) drawStroke(ctx, stroke, { x: 0, y: 0 }, { width: 200, height: 200 });
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      return [1, 2].map((dpr) => {
        const solid = render(dpr, 1);
        const half = render(dpr, 0.5);
        const overlap = render(dpr, 0.5, true);
        let covered = 0;
        let correctAlpha = true;
        for (let i = 0; i < solid.length; i += 4) {
          if (solid[i] === 0) {
            covered++;
            correctAlpha &&= half[i]! >= 127 && half[i]! <= 128 && overlap[i]! < half[i]!;
          }
          correctAlpha &&= half[i + 3] === 255 && half[i]! >= 127;
        }
        return { covered, correctAlpha };
      });
    });
  });
  for (const [normal, retina] of results) {
    expect(normal!.covered).toBeGreaterThan(50);
    expect(retina!.covered).toBeGreaterThan(normal!.covered);
    expect(normal!.correctAlpha).toBe(true);
    expect(retina!.correctAlpha).toBe(true);
  }
});

test('effect hit-testing follows nib and individual spray particles, including tolerance and world edges', async ({ page }) => {
  await page.goto('/');
  const hits = await page.evaluate(async () => {
    const rendererPath = '/src/renderer.ts';
    const geometryPath = '/src/brush-geometry.ts';
    const { hitTest } = await import(rendererPath);
    const { sprayParticles } = await import(geometryPath);
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.scale(2, 2);
    const base = { id: '87a122fa-7537-4b88-9b77-b45d24a29714', width: 48, color: '#202020', opacity: 1,
      points: [[1e9 - 30, -1e9 + 30]] };
    const camera = { x: 0, y: 0 };
    const viewport = { width: 200, height: 200 };
    const testAt = (brush: string, dx: number, dy: number, tolerance = 0) =>
      hitTest(ctx, { ...base, brush }, [base.points[0]![0]! + dx, base.points[0]![1]! + dy], camera, viewport, tolerance);
    const particle = sprayParticles(base).next().value!;
    return [testAt('chisel', 12, -12), testAt('chisel', 12, 12),
      testAt('spray', particle.x, particle.y), testAt('spray', 24, 24),
      testAt('spray', particle.x + particle.radius + 1, particle.y, 4),
      testAt('spray', 40, 40, 4)];
  });
  expect(hits).toEqual([true, false, true, false, true, false]);
});
