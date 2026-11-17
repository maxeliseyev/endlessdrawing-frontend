import { describe, expect, it } from 'vitest';
import { backingSize, MAX_SUBSCRIPTION_SPAN, MAX_ZOOM, MIN_ZOOM, needsResubscribe, pan, panScreen, pinch, screenToWorld, subscriptionBounds, visibleBounds, wheelPixels, wheelZoomFactor, worldToScreen, zoomAt } from '../../src/camera';
import { WORLD_LIMIT } from '../../src/model';

const viewport = { width: 1200, height: 800 };
const camera = { x: -182.125, y: 249.5 };

describe('camera coordinates (CSS pixels at zoom 1)', () => {
  it('round-trips world and screen including fractional coordinates', () => {
    const point = [-400.25, 12.5] as const;
    expect(screenToWorld(worldToScreen(point, camera, viewport), camera, viewport)).toEqual(point);
    expect(worldToScreen([camera.x, camera.y], camera, viewport)).toEqual([600, 400]);
  });

  it('preserves world geometry and camera center on resize / DPR change', () => {
    const point = [10, 20] as const;
    expect(backingSize(viewport, 2)).toEqual({ width: 2400, height: 1600 });
    expect(backingSize({ width: 101, height: 51 }, 1.25)).toEqual({ width: 126, height: 64 });
    const resized = { width: 600, height: 400 };
    expect(screenToWorld(worldToScreen(point, camera, resized), camera, resized)).toEqual(point);
    expect(camera).toEqual({ x: -182.125, y: 249.5 });
  });

  it('pans the camera and clamps to the world, not the geometry', () => {
    expect(pan(camera, 20, -30)).toEqual({ x: -162.125, y: 219.5 });
    expect(pan({ x: WORLD_LIMIT - 2, y: -WORLD_LIMIT + 3 }, 20, -30))
      .toEqual({ x: WORLD_LIMIT, y: -WORLD_LIMIT });
  });

  it('prefetches one screen in each direction and clips to world bounds', () => {
    expect(subscriptionBounds({ x: 0, y: 0 }, viewport))
      .toEqual({ min_x: -1800, max_x: 1800, min_y: -1200, max_y: 1200 });
    const bounds = subscriptionBounds({ x: WORLD_LIMIT, y: -WORLD_LIMIT }, viewport);
    expect(bounds.max_x).toBe(WORLD_LIMIT);
    expect(bounds.min_y).toBe(-WORLD_LIMIT);
    expect(bounds.min_x).toBeLessThan(bounds.max_x);
    expect(bounds.min_y).toBeLessThan(bounds.max_y);
  });

  it('normalizes both wheel axes in pixel, line and page modes', () => {
    expect(wheelPixels(2, -3, 0, viewport)).toEqual([2, -3]);
    expect(wheelPixels(2, -3, 1, viewport)).toEqual([32, -48]);
    expect(wheelPixels(2, -3, 2, viewport)).toEqual([2400, -2400]);
  });
});

describe('limited zoom', () => {
  const c = { x: 100, y: -50, zoom: 2 };
  it('round-trips world/screen at non-unit zoom', () => {
    const point = [123.25, -7.5] as const;
    const [sx, sy] = worldToScreen(point, c, viewport);
    const [wx, wy] = screenToWorld([sx, sy], c, viewport);
    expect(wx).toBeCloseTo(point[0], 9);
    expect(wy).toBeCloseTo(point[1], 9);
    expect(worldToScreen([101, -50], c, viewport)).toEqual([602, 400]);
  });

  it('keeps the world point under the cursor fixed and clamps the range', () => {
    const anchor = [900, 100] as const;
    const before = screenToWorld(anchor, c, viewport);
    const zoomed = zoomAt(c, 3, anchor, viewport);
    expect(zoomed.zoom).toBe(3);
    const after = screenToWorld(anchor, zoomed, viewport);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
    expect(zoomAt(c, 100, anchor, viewport).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(c, 0, anchor, viewport).zoom).toBe(MIN_ZOOM);
    expect(zoomAt(c, Number.NaN, anchor, viewport).zoom).toBe(1);
  });

  it('pans by screen distance divided by zoom', () => {
    expect(panScreen(c, 20, -10)).toEqual({ x: 110, y: -55, zoom: 2 });
    expect(pan({ x: 0, y: 0 }, 1, 1)).toEqual({ x: 1, y: 1 });
  });

  it('pinch: midpoint follows the fingers and distance ratio scales zoom', () => {
    const start = { x: 0, y: 0, zoom: 1 };
    const a0 = [500, 400] as const, b0 = [700, 400] as const;
    const anchored = screenToWorld([600, 400], start, viewport);
    // Fingers spread to twice the distance and the midpoint moves right by 50.
    const result = pinch(start, a0, b0, [450, 400], [850, 400], viewport);
    expect(result.zoom).toBe(2);
    const moved = screenToWorld([650, 400], result, viewport);
    expect(moved[0]).toBeCloseTo(anchored[0], 9);
    expect(moved[1]).toBeCloseTo(anchored[1], 9);
    // Pure two-finger pan without scaling.
    expect(pinch(start, a0, b0, [520, 430], [720, 430], viewport)).toEqual({ x: -20, y: -30, zoom: 1 });
    // Degenerate (coincident) fingers do not divide by zero.
    expect(pinch(start, a0, a0, a0, b0, viewport).zoom).toBe(1);
  });

  it('wheel zoom factor is monotonic and capped per event', () => {
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10)).toBeLessThan(1);
    expect(wheelZoomFactor(10_000)).toBe(wheelZoomFactor(50));
  });

  it('subscription is 3× the visible world area and never exceeds the server span', () => {
    const zoomedOut = { x: 0, y: 0, zoom: MIN_ZOOM };
    const bounds = subscriptionBounds(zoomedOut, { width: 3000, height: 2000 });
    expect(bounds.max_x - bounds.min_x).toBe(MAX_SUBSCRIPTION_SPAN);
    expect(bounds.max_y - bounds.min_y).toBe(24_000);
    const visible = visibleBounds(zoomedOut, { width: 3000, height: 2000 });
    expect(bounds.min_x).toBeLessThanOrEqual(visible.min_x);
    expect(bounds.max_x).toBeGreaterThanOrEqual(visible.max_x);
    const zoomedIn = subscriptionBounds({ x: 0, y: 0, zoom: 4 }, viewport);
    expect(zoomedIn).toEqual({ min_x: -450, max_x: 450, min_y: -300, max_y: 300 });
  });

  it('shifts the prefetch ahead of the pan and resubscribes while loaded ground remains', () => {
    const base = { x: 0, y: 0, zoom: 1 };
    const ahead = subscriptionBounds(base, viewport, [1, 0]);
    // Width stays 3× the view; 35% of the one-screen slack moves ahead.
    expect(ahead).toEqual({ min_x: -1380, max_x: 2220, min_y: -1200, max_y: 1200 });
    // A fresh biased subscription never re-triggers itself.
    expect(needsResubscribe(ahead, base, viewport)).toBe(false);
    // After 0.85 screens of travel, half a screen of loaded ground is still ahead.
    expect(needsResubscribe(ahead, { ...base, x: 1000 }, viewport)).toBe(false);
    expect(needsResubscribe(ahead, { ...base, x: 1030 }, viewport)).toBe(true);
    // The same holds when the server span cap leaves less slack (deep zoom-out, wide screen).
    for (const width of [3000, 3840, 6000]) {
      const wide = { width, height: 1000 };
      const out = { x: 0, y: 0, zoom: MIN_ZOOM };
      for (const heading of [[1, 0], [-0.6, 0.8], [0, 0]] as const) {
        expect(needsResubscribe(subscriptionBounds(out, wide, heading), out, wide)).toBe(false);
      }
    }
  });

  it('resubscribes only when the view leaves the prefetched area or zooming in makes it wasteful', () => {
    const base = { x: 0, y: 0, zoom: 1 };
    const area = subscriptionBounds(base, viewport);
    expect(needsResubscribe(undefined, base, viewport)).toBe(true);
    expect(needsResubscribe(area, base, viewport)).toBe(false);
    expect(needsResubscribe(area, { ...base, x: 300 }, viewport)).toBe(false);
    expect(needsResubscribe(area, { ...base, x: 1000 }, viewport)).toBe(true);
    expect(needsResubscribe(area, { ...base, zoom: 0.8 }, viewport)).toBe(false);
    expect(needsResubscribe(area, { ...base, zoom: 0.5 }, viewport)).toBe(true);
    expect(needsResubscribe(area, { ...base, zoom: 2.5 }, viewport)).toBe(true);
    expect(needsResubscribe(area, { ...base, zoom: 1.5 }, viewport)).toBe(false);
  });
});
