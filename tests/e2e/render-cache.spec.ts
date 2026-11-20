import { expect, test } from '@playwright/test';

for (const dpr of [1, 2]) test.describe(`WebGL tile reuse at DPR ${dpr}`, () => {
  test.use({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: dpr });

  test('settled zoom copies only the current tiles; idle and warm pan do not redraw strokes', async ({ page }) => {
    await page.goto('/about/');
    const result = await page.evaluate(async () => {
      const path = '/src/scene-renderer.ts';
      const { createSceneRenderer } = await import(path) as typeof import('../../src/scene-renderer');
      const viewport = { width: 1000, height: 700 };
      const stroke = { id: '00000000-0000-4000-8000-000000000001', seq: 1, own: false,
        brush: 'square' as const, width: 64, color: '#202020', opacity: 1,
        points: [[-1000, 0], [1000, 0]] as [number, number][] };
      document.body.style.cssText = 'margin:0;padding:0';
      const make = (zoom: number) => {
        const canvas = document.createElement('canvas');
        canvas.style.width = '1000px'; canvas.style.height = '700px';
        document.body.append(canvas);
        const gl = canvas.getContext('webgl2', { alpha: false, antialias: true,
          premultipliedAlpha: true, preserveDrawingBuffer: true })!;
        let target: WebGLFramebuffer | null = null;
        const counts = { screen: 0, offscreen: 0, staticUploads: 0, frames: 0 };
        const bind = gl.bindFramebuffer.bind(gl), draw = gl.drawArrays.bind(gl);
        const instances = gl.drawArraysInstanced.bind(gl), upload = gl.bufferData.bind(gl);
        gl.bindFramebuffer = (kind, value) => { target = value; bind(kind, value); };
        gl.drawArrays = (mode, first, count) => {
          if (target) counts.offscreen++; else counts.screen++;
          draw(mode, first, count);
        };
        gl.drawArraysInstanced = (mode, first, count, instancesCount) => {
          if (target) counts.offscreen++; else counts.screen++;
          instances(mode, first, count, instancesCount);
        };
        gl.bufferData = ((...args: unknown[]) => {
          if (args[2] === gl.STATIC_DRAW) counts.staticUploads++;
          Reflect.apply(upload, gl, args);
        }) as typeof gl.bufferData;
        const camera = { x: 0, y: 0, zoom };
        let last = performance.now(), done: (() => void) | undefined;
        const renderer = createSceneRenderer(canvas, { camera: () => camera, viewport: () => viewport,
          scene: { strokes: () => [stroke], isHidden: () => false }, overlays: () => [],
          painted: () => { last = performance.now(); counts.frames++; done?.(); done = undefined; },
        });
        renderer.added(stroke); renderer.resize(viewport, devicePixelRatio);
        const idle = async () => {
          const start = performance.now();
          while (performance.now() - last < 260) {
            if (performance.now() - start > 10_000) throw new Error('Renderer did not become idle');
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        };
        const frame = async () => {
          const next = new Promise<void>((resolve) => { done = resolve; });
          renderer.invalidate(); await next;
        };
        const hash = async () => {
          const pixels = new Uint8Array(canvas.width * canvas.height * 4);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)),
            (value) => value.toString(16).padStart(2, '0')).join('');
        };
        return { canvas, gl, camera, renderer, counts, idle, frame, hash };
      };
      const history = make(1);
      await history.idle();
      for (const zoom of [0.8, 0.6, 0.9]) {
        history.camera.zoom = zoom; await history.frame(); await history.idle();
      }
      const fresh = make(0.9);
      await fresh.idle();
      const freshBefore = fresh.counts.screen;
      await fresh.frame();
      const expectedCopies = fresh.counts.screen - freshBefore;
      const before = { ...history.counts };
      await history.frame();
      const actualCopies = history.counts.screen - before.screen;
      const samePixels = await history.hash() === await fresh.hash();
      for (const x of [2, -2, 4, -4, 0]) { history.camera.x = x; await history.frame(); }
      const warm = { offscreen: history.counts.offscreen - before.offscreen,
        uploads: history.counts.staticUploads - before.staticUploads };
      await history.idle();
      const idleStart = history.counts.frames;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const idleFrames = history.counts.frames - idleStart;
      // Force the first frame at a new scale to exhaust its tile budget after
      // one tile. The previous scale must still cover the missing tiles.
      const clock = performance.now.bind(performance);
      let ticks = 0;
      performance.now = () => clock() + ++ticks * 10;
      try { history.camera.zoom = 0.4; await history.frame(); }
      finally { performance.now = clock; }
      const fallbackInk = [400, 600].map((x) => {
        const pixel = new Uint8Array(4);
        history.gl.readPixels(x * devicePixelRatio, history.canvas.height - 1 - 350 * devicePixelRatio,
          1, 1, history.gl.RGBA, history.gl.UNSIGNED_BYTE, pixel);
        return pixel[0]! < 64 && pixel[3] === 255;
      });
      history.renderer.dispose(); fresh.renderer.dispose();
      return { expectedCopies, actualCopies, samePixels, warm, idleFrames, fallbackInk };
    });
    expect(result.actualCopies).toBe(result.expectedCopies);
    expect(result.samePixels).toBe(true);
    expect(result.warm).toEqual({ offscreen: 0, uploads: 0 });
    expect(result.idleFrames).toBe(0);
    expect(result.fallbackInk).toEqual([true, true]);
  });
});
