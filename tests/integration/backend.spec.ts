import { decodeMessagePack } from '../../src/transport/msgpack';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { canvasPixels } from '../support/pixels';

// Real backend + PostgreSQL. Each run draws in a fresh random area so a shared
// dev database does not affect results.
const WHITE = [255, 255, 255, 255];

async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  await page.bringToFront();
  return page.locator('canvas').evaluate(canvasPixels, { op: 'pixel', x, y }) as Promise<number[]>;
}

// Sparse brushes (spray) do not guarantee a solid pixel at one coordinate,
// so acceptance checks a small region instead of a single sample point.
async function regionInk(page: Page, cx: number, cy: number, halfWidth: number, halfHeight: number): Promise<boolean> {
  await page.bringToFront();
  return page.locator('canvas').evaluate(canvasPixels, { op: 'region', cx, cy, halfWidth, halfHeight }) as Promise<boolean>;
}

const frames = new WeakMap<Page, Record<string, unknown>[]>();
const binaryFrames = new WeakMap<Page, number>();
const wireBytes = new WeakMap<Record<string, unknown>, number>();

test.afterEach(async ({ browser }, info) => {
  if (info.status === info.expectedStatus) return;
  let index = 0;
  for (const context of browser.contexts()) for (const page of context.pages()) {
    // Only public server messages and non-secret camera/preferences; never hello secrets.
    const state = await page.evaluate(() => ({ camera: sessionStorage.getItem('endless-drawing.camera.v1'),
      preferences: localStorage.getItem('endless-drawing.preferences.v1'), visibility: document.visibilityState,
      renderer: document.querySelector('canvas')?.dataset.renderer }));
    await info.attach(`public-state-${index++}`, { body: JSON.stringify({ ...state, messages: frames.get(page) }), contentType: 'application/json' });
  }
});

async function open(browser: Browser, camera: { x: number; y: number }): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, locale: 'en-US' });
  await context.addInitScript((value) => {
    if (!sessionStorage.getItem('endless-drawing.camera.v1')) sessionStorage.setItem('endless-drawing.camera.v1', value);
  }, JSON.stringify({ ...camera, zoom: 1 }));
  const page = await context.newPage();
  const received: Record<string, unknown>[] = [];
  frames.set(page, received);
  binaryFrames.set(page, 0);
  page.on('websocket', (socket) => socket.on('framereceived', (frame) => {
    if (typeof frame.payload !== 'string') binaryFrames.set(page, binaryFrames.get(page)! + 1);
    const message = typeof frame.payload === 'string' ? JSON.parse(frame.payload) as Record<string, unknown> : decodeMessagePack(frame.payload);
    wireBytes.set(message, typeof frame.payload === 'string' ? new TextEncoder().encode(frame.payload).length : frame.payload.length);
    received.push(message);
  }));
  await page.goto(process.env.E2E_RENDERER === 'canvas2d' ? '/?renderer=canvas2d' : '/');
  // HTML load is not WebSocket/snapshot readiness, especially over staging WAN TLS.
  await expect.poll(() => received.some((frame) => frame.type === 'viewport.snapshot.end'),
    { timeout: 30_000 }).toBe(true);
  if (process.env.E2E_WS_PROFILE === 'json') expect(binaryFrames.get(page)).toBe(0);
  else expect(binaryFrames.get(page)).toBeGreaterThan(0);
  return page;
}

async function choose(page: Page, label: string): Promise<void> {
  await page.mouse.click(900, 600, { button: 'right' });
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

test('shared world through the real backend: sync, ownership, undo, reload, new brushes', async ({ browser }) => {
  test.setTimeout(120_000); // Several real WAN navigations/WS handshakes, not a single local interaction.
  const camera = process.env.E2E_CAMERA ? JSON.parse(process.env.E2E_CAMERA) as { x: number; y: number }
    : { x: Math.round(Math.random() * 1e8), y: Math.round(Math.random() * 1e8) };
  const author = await open(browser, camera);
  const visitor = await open(browser, camera);
  const ws = frames.get(author)!;

  // Round stroke.
  await author.mouse.move(250, 250); await author.mouse.down();
  await author.mouse.move(450, 250, { steps: 10 }); await author.mouse.up();
  await expect.poll(() => pixel(visitor, 350, 250), { timeout: 10_000 }).toEqual([32, 32, 32, 255]);
  await expect.poll(() => ws.some((f) => f.operation === 'stroke.create')).toBe(true);

  if (ws.find((m) => m.type === 'hello.ack')?.protocol_version === 3) await test.step('M2 partial overlap and warm return do not resend cached geometry', async () => {
    const far = await open(browser, { x: camera.x + 1850, y: camera.y });
    await far.mouse.move(250, 250); await far.mouse.down();
    await far.mouse.move(450, 250, { steps: 10 }); await far.mouse.up();
    const farFrames = frames.get(far)!;
    await expect.poll(() => farFrames.some((m) => m.operation === 'stroke.create')).toBe(true);
    const farId = (farFrames.find((m) => m.operation === 'stroke.create')!.stroke as { id: string }).id;
    const visitorFrames = frames.get(visitor)!;
    expect(visitorFrames.some((m) => (m.stroke as { id?: string } | undefined)?.id === farId)).toBe(false);
    const pan = async (dx: number) => {
      const start = visitorFrames.length;
      await visitor.bringToFront(); await visitor.mouse.move(500, 350); await visitor.mouse.wheel(dx, 0);
      await expect.poll(() => visitorFrames.slice(start).some((m) => m.type === 'viewport.snapshot.end'), { timeout: 30_000 }).toBe(true);
      const messages = visitorFrames.slice(start);
      expect(messages.some((m) => m.type === 'viewport.manifest.end')).toBe(true);
      return messages;
    };
    const partial = await pan(600);
    const geometry = partial.filter((m) => m.type === 'viewport.snapshot.chunk')
      .flatMap((m) => m.strokes as { id: string }[]);
    expect(geometry.map((s) => s.id)).toEqual([farId]);
    const warm = await pan(-600);
    expect(warm.filter((m) => m.type === 'viewport.snapshot.chunk')).toEqual([]);
    await test.info().attach('M2 transfer counts', { contentType: 'application/json', body: JSON.stringify({
      partialStrokes: geometry.length, warmGeometryBytes: 0,
      warmTotalBytes: warm.reduce((sum, m) => sum + (wireBytes.get(m) ?? 0), 0),
    }) });
    await expect.poll(() => pixel(visitor, 350, 250)).toEqual([32, 32, 32, 255]);
    await far.locator('canvas').focus(); await far.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => visitorFrames.some((m) => m.type === 'stroke.deleted' && m.stroke_id === farId)).toBe(true);
    await far.context().close();
  });

  // chisel and spray are accepted end to end (backend migration 0003).
  for (const [label, y, brush] of [['Chisel pen', 350, 'chisel'], ['Spray', 450, 'spray']] as const) {
    await author.mouse.click(900, 600, { button: 'right' });
    await author.getByRole('button', { name: label, exact: true }).click();
    await author.keyboard.press('Escape');
    await author.mouse.move(250, y); await author.mouse.down();
    await author.mouse.move(450, y, { steps: 10 }); await author.mouse.up();
    // Deterministic: the server acknowledged this exact brush, then the visitor rendered ink in the area.
    await expect.poll(() => ws.some((f) => f.operation === 'stroke.create' && (f.stroke as { brush?: string } | undefined)?.brush === brush),
      { timeout: 10_000 }).toBe(true);
    await expect.poll(() => regionInk(visitor, 350, y, 40, 20), { timeout: 10_000 }).toBe(true);
  }
  expect(ws.filter((f) => f.type === 'error')).toEqual([]);

  // The visitor cannot erase the author's stroke.
  await choose(visitor, 'Eraser');
  await visitor.mouse.click(350, 250);
  await visitor.waitForTimeout(500);
  await expect.poll(() => pixel(visitor, 350, 250)).toEqual([32, 32, 32, 255]);

  // After reload the author still owns the strokes (same tab session) and undo removes them for everyone.
  ws.length = 0;
  await author.reload();
  await expect.poll(() => ws.some((frame) => frame.type === 'viewport.snapshot.end'),
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
