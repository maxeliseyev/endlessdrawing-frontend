import { describe, expect, it } from 'vitest';
import { appendPoint, DEFAULT_PREFERENCES, fitsCreateMessage, isPoint, MAX_POINTS, type Point } from '../../src/model';
import { topmostOwned } from '../../src/renderer';

describe('stroke sampling / wire bounds', () => {
  it('keeps a single click as one point, removes subpixel noise, preserves final endpoint', () => {
    const points: Point[] = [[0, 0]];
    appendPoint(points, [0, 0], true);
    appendPoint(points, [0.1, 0.1]);
    expect(points).toEqual([[0, 0]]);
    appendPoint(points, [0.1, 0.1], true);
    expect(points).toEqual([[0, 0], [0.1, 0.1]]);
  });

  it('limits points but continues the full gesture instead of dropping its tail', () => {
    const points: Point[] = [];
    for (let i = 0; i < 10_000; i++) appendPoint(points, [i, i % 20]);
    expect(points.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(points[0]).toEqual([0, 0]);
    expect(points.at(-1)).toEqual([9999, 19]);
  });

  it('accepts valid points only within finite world bounds', () => {
    expect(isPoint([-1e9, 1e9])).toBe(true);
    for (const invalid of [[NaN, 0], [Infinity, 0], [1e9 + 1, 0], [1, 2, 3], ['1', 2], null]) {
      expect(isPoint(invalid)).toBe(false);
    }
  });

  it('counts UTF-8 JSON envelope bytes, not only point count', () => {
    expect(fitsCreateMessage({ ...DEFAULT_PREFERENCES, id: crypto.randomUUID(), points: [[0, 0]] })).toBe(true);
    const points: Point[] = Array.from({ length: MAX_POINTS }, () => [0.12345678912345678, 0.9876543219876543]);
    expect(fitsCreateMessage({ ...DEFAULT_PREFERENCES, id: 'x'.repeat(140_000), points })).toBe(false);
  });
});

it('server-backed eraser only considers own strokes and chooses highest seq, not nearest/arrival order', () => {
  const base = { ...DEFAULT_PREFERENCES, points: [[0, 0]] as Point[] };
  const strokes = [
    { ...base, id: 'top', seq: 30, own: true },
    { ...base, id: 'foreign', seq: 99, own: false },
    { ...base, id: 'bottom', seq: 1, own: true },
  ];
  expect(topmostOwned(strokes, () => true)?.id).toBe('top');
  expect(topmostOwned(strokes, (stroke) => stroke.id === 'bottom')?.id).toBe('bottom');
  expect(topmostOwned(strokes, () => false)).toBeUndefined();
});
