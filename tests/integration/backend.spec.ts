import { expect, test, type Browser, type Page } from '@playwright/test';

// Real backend + PostgreSQL. Each run draws in a fresh random area so a shared
// dev database does not affect results.
const WHITE = [255, 255, 255, 255];

async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.locator('canvas').evaluate((canvas: HTMLCanvasElement, point) => {
    const scale = canvas.width / canvas.clientWidth;
    return Array.from(canvas.getContext('2d')!.getImageData(Math.round(point.x * scale), Math.round(point.y * scale), 1, 1).data);
  }, { x, y });
}

// Sparse brushes (spray) do not guarantee a solid pixel at one coordinate,
// so acceptance checks a small region instead of a single sample point.
async function regionInk(page: Page, cx: number, cy: number, halfWidth: number, halfHeight: number): Promise<boolean> {
  return page.locator('canvas').evaluate((canvas: HTMLCanvasElement, area) => {
    const scale = canvas.width / canvas.clientWidth;
    const x0 = Math.max(0, Math.round((area.cx - area.halfWidth) * scale));
    const y0 = Math.max(0, Math.round((area.cy - area.halfHeight) * scale));
    const x1 = Math.min(canvas.width, Math.round((area.cx + area.halfWidth) * scale));
    const y1 = Math.min(canvas.height, Math.round((area.cy + area.halfHeight) * scale));
    const data = canvas.getContext('2d')!.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255 || data[i + 3] !== 255) return true;
    }
    return false;
  }, { cx, cy, halfWidth, halfHeight });
}

const frames = new WeakMap<Page, string[]>();

async function open(browser: Browser, camera: { x: number; y: number }): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, locale: 'en-US' });
  await context.addInitScript((value) => {
    if (!sessionStorage.getItem('endless-drawing.camera.v1')) sessionStorage.setItem('endless-drawing.camera.v1', value);
  }, JSON.stringify({ ...camera, zoom: 1 }));
  const page = await context.newPage();
  const received: string[] = [];
  frames.set(page, received);
  page.on('websocket', (socket) => socket.on('framereceived', (frame) => received.push(String(frame.payload))));
  await page.goto('/');
  // HTML load is not WebSocket/snapshot readiness, especially over staging WAN TLS.
  await expect.poll(() => received.some((frame) => frame.includes('"type":"viewport.snapshot.end"')),
    { timeout: 30_000 }).toBe(true);
  return page;
}

async function choose(page: Page, label: string): Promise<void> {
  await page.mouse.click(900, 600, { button: 'right' });
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

test('shared world through the real backend: sync, ownership, undo, reload, new brushes', async ({ browser }) => {
  test.setTimeout(120_000); // Several real WAN navigations/WS handshakes, not a single local interaction.
  const camera = { x: Math.round(Math.random() * 1e8), y: Math.round(Math.random() * 1e8) };
  const author = await open(browser, camera);
  const visitor = await open(browser, camera);
  const ws = frames.get(author)!;

  // Round stroke.
  await author.mouse.move(250, 250); await author.mouse.down();
  await author.mouse.move(450, 250, { steps: 10 }); await author.mouse.up();
  await expect.poll(() => pixel(visitor, 350, 250), { timeout: 10_000 }).toEqual([32, 32, 32, 255]);
  await expect.poll(() => ws.some((f) => f.includes('"operation":"stroke.create"'))).toBe(true);

  // chisel and spray are accepted end to end (backend migration 0003).
  for (const [label, y, brush] of [['Chisel pen', 350, 'chisel'], ['Spray', 450, 'spray']] as const) {
    await author.mouse.click(900, 600, { button: 'right' });
    await author.getByRole('button', { name: label, exact: true }).click();
    await author.keyboard.press('Escape');
    await author.mouse.move(250, y); await author.mouse.down();
    await author.mouse.move(450, y, { steps: 10 }); await author.mouse.up();
    // Deterministic: the server acknowledged this exact brush, then the visitor rendered ink in the area.
    await expect.poll(() => ws.some((f) => f.includes('"operation":"stroke.create"') && f.includes(`"brush":"${brush}"`)),
      { timeout: 10_000 }).toBe(true);
    await expect.poll(() => regionInk(visitor, 350, y, 40, 20), { timeout: 10_000 }).toBe(true);
  }
  expect(ws.filter((f) => f.includes('"type":"error"'))).toEqual([]);

  // The visitor cannot erase the author's stroke.
  await choose(visitor, 'Eraser');
  await visitor.mouse.click(350, 250);
  await visitor.waitForTimeout(500);
  await expect.poll(() => pixel(visitor, 350, 250)).toEqual([32, 32, 32, 255]);

  // After reload the author still owns the strokes (same tab session) and undo removes them for everyone.
  ws.length = 0;
  await author.reload();
  await expect.poll(() => ws.some((frame) => frame.includes('"type":"viewport.snapshot.end"')),
    { timeout: 30_000 }).toBe(true);
  await expect.poll(() => pixel(author, 350, 250), { timeout: 10_000 }).toEqual([32, 32, 32, 255]);
  await author.locator('canvas').focus();
  for (let i = 0; i < 3; i++) await author.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pixel(visitor, 350, 250), { timeout: 10_000 }).toEqual(WHITE);
  await expect.poll(() => pixel(visitor, 350, 350), { timeout: 10_000 }).toEqual(WHITE);

  // A fresh visitor sees nothing left in this area.
  const late = await open(browser, camera);
  await late.waitForTimeout(800);
  for (const y of [250, 350, 450]) expect(await pixel(late, 350, y)).toEqual(WHITE);
  await expect(late.getByRole('status')).toBeHidden();
  for (const page of [author, visitor, late]) await page.context().close();
});
