import { describe, expect, it } from 'vitest';
import { backingSize, pan, screenToWorld, subscriptionBounds, wheelPixels, worldToScreen } from '../../src/camera';
import { WORLD_LIMIT } from '../../src/model';

const viewport = { width: 1200, height: 800 };
const camera = { x: -182.125, y: 249.5 };

describe('camera coordinates (CSS pixels, no zoom)', () => {
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
