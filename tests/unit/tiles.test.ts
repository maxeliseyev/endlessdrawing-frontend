import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stroke } from '../../src/model';
import { SETTLE_MS, TILE_SIZE, TileCache, zoomLevel, type TileSurface } from '../../src/tiles';

// Canvas is not available in Node: a recording fake is enough to check which
// tiles are (re)rendered, painted incrementally and copied where.
class FakeContext {
  fills = 0;
  strokes = 0;
  images: { x: number; y: number; w: number; h: number }[] = [];
  globalAlpha = 1; globalCompositeOperation = 'source-over'; fillStyle = ''; strokeStyle = '';
  lineWidth = 1; lineCap = 'butt'; lineJoin = 'miter';
  setTransform() {} save() {} restore() {} translate() {} scale() {}
  fillRect() { this.fills++; }
  fill() {}
  stroke() { this.strokes++; }
  drawImage(_: unknown, x: number, y: number, w: number, h: number) { this.images.push({ x, y, w, h }); }
}

function stroke(id: number, seq: number, x: number, y: number, length = 10): Stroke {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, seq, own: false,
    points: Object.freeze([[x, y], [x + length, y]]) as unknown as Stroke['points'],
    brush: 'round', width: 4, color: '#202020', opacity: 1,
  };
}

function setup(initial: Stroke[] = []) {
  const strokes = [...initial];
  const hidden = new Set<string>();
  const surfaces: FakeContext[] = [];
  const cache = new TileCache({ strokes: () => [...strokes].sort((a, b) => a.seq - b.seq), hidden }, () => {
    const context = new FakeContext();
    surfaces.push(context);
    return { canvas: { width: TILE_SIZE, height: TILE_SIZE }, context } as unknown as TileSurface;
  });
  const target = new FakeContext();
  const draw = (camera = { x: 0, y: 0, zoom: 1 }, now = 1000, viewport = { width: 1000, height: 700 }) =>
    cache.draw(target as unknown as CanvasRenderingContext2D, camera, viewport, 1, now);
  return { cache, strokes, hidden, surfaces, target, draw };
}

beforeEach(() => { vi.stubGlobal('Path2D', class { moveTo() {} lineTo() {} arc() {} rect() {} closePath() {} }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('TileCache', () => {
  it('renders each tile once; later frames only copy them at whole pixels', () => {
    const { cache, draw, target } = setup([stroke(1, 1, 0, 0)]);
    let frame = draw();
    while (frame.busy) frame = draw();
    const first = cache.renders;
    // View 1000×700 around 0: 2×2 visible tiles, plus the prefetched ring.
    expect(first).toBe(4 * 4);
    target.images.length = 0;
    frame = draw();
    expect(cache.renders).toBe(first);
    expect(target.images).toHaveLength(4);
    for (const image of target.images) {
      expect(Number.isInteger(image.x) && Number.isInteger(image.y)).toBe(true);
      expect(image.w).toBe(TILE_SIZE);
    }
    // Fractional camera: overlays get the snapped camera matching the copies.
    frame = draw({ x: 0.3, y: -0.2, zoom: 1 });
    expect(frame.camera).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('a pan renders only the newly exposed tiles', () => {
    const { cache, draw } = setup();
    let frame = draw();
    while (frame.busy) frame = draw();
    const before = cache.renders;
    for (let x = 0; x <= 512; x += 64) draw({ x, y: 0, zoom: 1 });
    // One new column of 4 ring tiles: everything else was already there.
    expect(cache.renders - before).toBe(4);
  });

  it('a stroke on top is painted incrementally; an older one or a removal re-renders only touched tiles', () => {
    const { cache, strokes, hidden, draw, surfaces } = setup([stroke(1, 5, 10, 10)]);
    let frame = draw();
    while (frame.busy) frame = draw();
    const renders = cache.renders;
    const strokesBefore = surfaces.reduce((n, s) => n + s.strokes, 0);
    const top = stroke(2, 9, 100, 100);
    strokes.push(top); cache.added(top); draw();
    expect(cache.renders).toBe(renders);
    expect(surfaces.reduce((n, s) => n + s.strokes, 0)).toBe(strokesBefore + 1);
    const older = stroke(3, 2, 200, 200);
    strokes.push(older); cache.added(older); draw();
    expect(cache.renders).toBe(renders + 1);
    hidden.add(top.id); cache.removed(top); draw();
    expect(cache.renders).toBe(renders + 2);
  });

  it('zoom gestures use √2 levels and settle at the exact scale', () => {
    expect(zoomLevel(1)).toBe(1);
    expect(zoomLevel(4)).toBe(4);
    expect(zoomLevel(0.8)).toBe(1);
    expect(zoomLevel(0.6)).toBeCloseTo(Math.SQRT1_2, 9);
    expect(zoomLevel(1.2)).toBeCloseTo(Math.SQRT2, 9);
    const { draw, target } = setup();
    draw({ x: 0, y: 0, zoom: 1 }, 0);
    const moving = draw({ x: 0, y: 0, zoom: 0.9 }, 100);
    expect(moving.settleIn).toBe(SETTLE_MS);
    target.images.length = 0;
    // Level-1 tiles stretched by 0.9 while the gesture lasts.
    draw({ x: 0, y: 0, zoom: 0.9 }, 150);
    expect(target.images.length).toBeGreaterThan(0);
    for (const image of target.images) expect(Math.abs(image.w - TILE_SIZE * 0.9)).toBeLessThan(1);
    const settled = draw({ x: 0, y: 0, zoom: 0.9 }, 100 + SETTLE_MS);
    expect(settled.settleIn).toBeUndefined();
    target.images.length = 0;
    let frame = draw({ x: 0, y: 0, zoom: 0.9 }, 400);
    while (frame.busy) frame = draw({ x: 0, y: 0, zoom: 0.9 }, 400);
    target.images.length = 0;
    draw({ x: 0, y: 0, zoom: 0.9 }, 500);
    expect(target.images.every((image) => image.w === TILE_SIZE)).toBe(true);
  });

  it('keeps tile memory bounded and falls back to direct drawing when canvases run out', () => {
    const { cache, draw } = setup();
    for (let x = 0; x < 40_000; x += 400) {
      let frame = draw({ x, y: 0, zoom: 1 });
      while (frame.busy) frame = draw({ x, y: 0, zoom: 1 });
    }
    expect(cache.size).toBeLessThanOrEqual(48);
    let count = 0;
    const starved = new TileCache({ strokes: () => [], hidden: new Set() }, () => {
      if (++count > 3) return undefined;
      return { canvas: { width: TILE_SIZE, height: TILE_SIZE }, context: new FakeContext() } as unknown as TileSurface;
    });
    const frame = starved.draw(new FakeContext() as unknown as CanvasRenderingContext2D, { x: 0, y: 0, zoom: 1 }, { width: 1000, height: 700 }, 1, 0);
    expect(frame.direct).toBe(true);
    expect(starved.size).toBe(0);
  });
});
