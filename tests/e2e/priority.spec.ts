import { expect, test, type WebSocketRoute } from '@playwright/test';
import { decodeMessagePack, encodeMessagePack, SERVER_MESSAGE_BYTES } from '../../src/transport/msgpack';
import { canvasPixels } from '../support/pixels';

test.use({ viewport: { width: 1000, height: 700 } });

for (const renderer of ['default', 'canvas2d']) test(`${renderer}: visible-first chunks preserve seq when older paint arrives later`, async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('endless-drawing.camera.v1', JSON.stringify({ x: 0, y: 0, zoom: 1 })));
  let socket: WebSocketRoute | undefined;
  let subscription: unknown;
  let request: Record<string, unknown> | undefined;
  const send = (message: unknown) => socket!.send(Buffer.from(encodeMessagePack(message, SERVER_MESSAGE_BYTES)));
  const stroke = (seq: number, width: number, color: string) => ({ id: `00000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`,
    seq, own: false, points: [[-100, 0], [100, 0]], brush: 'round', width, color, opacity: 1 });
  await page.routeWebSocket('**/ws', (route) => {
    socket = route;
    route.onMessage((raw) => {
      const message = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : decodeMessagePack(raw);
      if (message.type === 'hello') send({ type: 'hello.ack', protocol_version: 5 });
      if (message.type === 'viewport.subscribe') {
        request = message; subscription = message.subscription_id;
        send({ type: 'viewport.snapshot.begin', subscription_id: subscription });
        send({ type: 'viewport.snapshot.chunk', subscription_id: subscription, strokes: [stroke(2, 16, '#0000FF')] });
      }
    });
  });
  await page.goto(renderer === 'canvas2d' ? '/?renderer=canvas2d' : '/');
  const pixel = (x: number, y: number) => page.locator('canvas').evaluate(canvasPixels, { op: 'pixel', x, y });
  await expect.poll(() => pixel(500, 350)).toEqual([0, 0, 255, 255]);
  expect(request!.visible_bounds).toEqual({ min_x: -500, min_y: -350, max_x: 500, max_y: 350 });
  send({ type: 'viewport.snapshot.chunk', subscription_id: subscription, strokes: [stroke(1, 30, '#FF0000')] });
  await expect.poll(() => pixel(500, 362)).toEqual([255, 0, 0, 255]);
  expect(await pixel(500, 350)).toEqual([0, 0, 255, 255]);
  send({ type: 'viewport.snapshot.end', subscription_id: subscription });
  await page.mouse.wheel(10, 0); await page.mouse.wheel(-10, 0);
  await expect.poll(() => pixel(500, 350)).toEqual([0, 0, 255, 255]);
});
