import { describe, expect, it } from 'vitest';
import { drawSpans, orderBySeq, packMesh, STROKE_COLUMNS, strokeTable } from '../../src/webgl/batch';
import { prepareStroke } from '../../src/webgl/stroke';

const id = '87a122fa-7537-4b88-9b77-b45d24a29714';

describe('prepared stroke', () => {
  it('stores a float32 origin pair and byte color without baking the camera', () => {
    const stroke = prepareStroke({
      id, brush: 'round', width: 4, color: '#202020', opacity: 1,
      points: [[1e9, -1e9], [1e9 + 20, -1e9]],
    }, 7);
    const local = prepareStroke({
      id, brush: 'round', width: 4, color: '#202020', opacity: 1,
      points: [[0, 0], [20, 0]],
    });
    expect(stroke.seq).toBe(7);
    expect(stroke.origin[0]).toBe(Math.fround(1e9));
    expect(stroke.origin[1]).toBe(Math.fround(1e9 - Math.fround(1e9)));
    expect(stroke.origin[2]).toBe(Math.fround(-1e9));
    expect(stroke.color[0]).toBe(32 / 255);
    expect(stroke.color[3]).toBe(1);
    expect(Array.from(stroke.triangles)).toEqual(Array.from(local.triangles));
  });

  it('keeps an empty stroke at the origin and falls back to the default ink', () => {
    const stroke = prepareStroke({ id, brush: 'round', width: 4, color: 'nope', opacity: 0.5, points: [] });
    expect(stroke.triangles.length).toBe(0);
    expect(stroke.circles.length).toBe(0);
    expect(stroke.origin).toEqual([0, 0, 0, 0]);
    expect(stroke.color[0]).toBe(32 / 255);
    expect(stroke.color[3]).toBe(0.5);
  });
});

describe('frame batch', () => {
  it('orders by seq then id and leaves the input alone', () => {
    const input = [{ seq: 2, id: 'b' }, { seq: 1, id: 'c' }, { seq: 1, id: 'a' }];
    expect(orderBySeq(input).map((stroke) => stroke.id)).toEqual(['a', 'c', 'b']);
    expect(input.map((stroke) => stroke.id)).toEqual(['b', 'c', 'a']);
  });

  it('groups opaque neighbours and keeps each translucent stroke alone', () => {
    expect(drawSpans([])).toEqual([]);
    expect(drawSpans([1, 1, 0.5, 1, 0.4].map((opacity) => ({ opacity })))).toEqual([
      { start: 0, end: 2, translucent: false },
      { start: 2, end: 3, translucent: true },
      { start: 3, end: 4, translucent: false },
      { start: 4, end: 5, translucent: true },
    ]);
  });

  it('packs vertex ranges with the stroke index', () => {
    const packed = packMesh([
      { triangles: new Float32Array([0, 1, 2, 3]), circles: new Float32Array([4, 5, 6]), index: 3 },
      { triangles: new Float32Array([7, 8]), circles: new Float32Array([]), index: 4 },
    ]);
    expect(Array.from(packed.triangles)).toEqual([0, 1, 3, 2, 3, 3, 7, 8, 4]);
    expect(Array.from(packed.circles)).toEqual([4, 5, 6, 3]);
    expect(packed.ranges).toEqual([
      { triFirst: 0, triCount: 2, circleFirst: 0, circleCount: 1 },
      { triFirst: 2, triCount: 1, circleFirst: 1, circleCount: 0 },
    ]);
  });

  it('lays the stroke table out in rows of two texels', () => {
    const records = Array.from({ length: STROKE_COLUMNS + 1 }, (_, index) => ({
      origin: index === 0 ? [1, 2, 3, 4] : index === STROKE_COLUMNS ? [9, 8, 7, 6] : [0, 0, 0, 0],
      color: index === 0 ? [5, 6, 7, 8] : index === STROKE_COLUMNS ? [1, 1, 1, 1] : [0, 0, 0, 0],
    }));
    const table = strokeTable(records);
    expect(table.width).toBe(STROKE_COLUMNS * 2);
    expect(table.height).toBe(2);
    expect(Array.from(table.texels.slice(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const far = (1 * table.width) * 4;
    expect(Array.from(table.texels.slice(far, far + 8))).toEqual([9, 8, 7, 6, 1, 1, 1, 1]);
    const empty = strokeTable([]);
    expect(empty.height).toBe(1);
    expect(empty.texels.length).toBe(STROKE_COLUMNS * 2 * 4);
  });
});
