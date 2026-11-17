import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '../../src/tiles';
import { planView, strokeDepth, tilePlacement, tileUpdates, type ZoomClock } from '../../src/webgl/tile-plan';

const still: ZoomClock = { zoom: undefined, zoomedAt: -Infinity };
const view = { width: 1000, height: 700 };

describe('WebGL tile plan', () => {
  it('covers the view once and keeps a one-tile ring', () => {
    const plan = planView({ x: 0, y: 0, zoom: 1 }, view, 1, 1000, still);
    expect(plan.needed).toHaveLength(4);
    expect(plan.ring).toHaveLength(16);
    expect(plan.scale).toBe(1);
    expect(plan.settleIn).toBeUndefined();
  });

  it('snaps a fractional camera to whole backing pixels', () => {
    const plan = planView({ x: 0.3, y: -0.2, zoom: 1 }, view, 1, 1000, still);
    expect(plan.snapped).toEqual({ x: 0, y: 0, zoom: 1 });
    const place = tilePlacement(0, 0, plan.scale, plan.exact, plan.ox, plan.oy);
    expect(place.x1 - place.x0).toBe(TILE_SIZE);
    expect(Number.isInteger(place.x0) && Number.isInteger(place.y0)).toBe(true);
  });

  it('a pan asks only for the newly exposed column', () => {
    const before = new Set(planView({ x: 0, y: 0, zoom: 1 }, view, 1, 1000, still).ring.map((tile) => tile.key));
    const after = planView({ x: TILE_SIZE, y: 0, zoom: 1 }, view, 1, 1000, still).ring;
    expect(after.filter((tile) => !before.has(tile.key))).toHaveLength(4);
  });

  it('appends a newer stroke and spoils a removal or an older one', () => {
    const tiles = [{
      key: '1|0|0', dirty: false, maxSeq: 5, adds: 0,
      bounds: { min_x: -1, min_y: -1, max_x: 10, max_y: 10 },
    }];
    const inside = { min_x: 0, min_y: 0, max_x: 4, max_y: 4 };
    expect(tileUpdates(tiles, inside, 6, false)).toEqual([{ key: '1|0|0', spoil: false }]);
    expect(tileUpdates(tiles, inside, 4, false)).toEqual([{ key: '1|0|0', spoil: true }]);
    expect(tileUpdates(tiles, inside, 6, true)).toEqual([{ key: '1|0|0', spoil: true }]);
    expect(tileUpdates(tiles, { min_x: 100, min_y: 100, max_x: 110, max_y: 110 }, 9, false)).toEqual([]);
  });

  it('puts the oldest stroke farther than the newest', () => {
    expect(strokeDepth(0, 3)).toBeGreaterThan(strokeDepth(2, 3));
    expect(strokeDepth(0, 3)).toBeLessThanOrEqual(1);
    expect(strokeDepth(2, 3)).toBeGreaterThan(0.5);
  });
});
