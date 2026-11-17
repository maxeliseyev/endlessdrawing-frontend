import { describe, expect, it } from 'vitest';
import { sprayParticles } from '../../src/brush-geometry';
import type { Point } from '../../src/model';
import { emulatedOffset } from '../../src/webgl/float';
import { tessellateStroke, type StrokeGeometry } from '../../src/webgl/tessellate';

const id = '87a122fa-7537-4b88-9b77-b45d24a29714';

function covers(geometry: StrokeGeometry, x: number, y: number): boolean {
  for (let i = 0; i < geometry.circles.length; i += 3) {
    const dx = x - geometry.circles[i]!;
    const dy = y - geometry.circles[i + 1]!;
    if (dx * dx + dy * dy <= geometry.circles[i + 2]! ** 2) return true;
  }
  for (let i = 0; i < geometry.triangles.length; i += 6) {
    if (inside(
      x, y,
      geometry.triangles[i]!, geometry.triangles[i + 1]!,
      geometry.triangles[i + 2]!, geometry.triangles[i + 3]!,
      geometry.triangles[i + 4]!, geometry.triangles[i + 5]!,
    )) return true;
  }
  return false;
}

function inside(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const c1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const c2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const c3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const hasNeg = c1 < -1e-8 || c2 < -1e-8 || c3 < -1e-8;
  const hasPos = c1 > 1e-8 || c2 > 1e-8 || c3 > 1e-8;
  return !(hasNeg && hasPos);
}

describe('float32 world pairs', () => {
  it('keeps a world offset exact where a single float32 difference does not', () => {
    const origin = 1e9 + 12345.25;
    const camera = 1e9;
    const exact = (12345.25 + 0.5) * 2;
    expect(Math.abs(emulatedOffset(origin, camera, 0.5, 2) - exact)).toBeLessThan(0.02);
    const naive = Math.fround((Math.fround(origin) - Math.fround(camera) + 0.5) * 2);
    expect(Math.abs(naive - exact)).toBeGreaterThan(1);
  });

  it('matches ordinary arithmetic inside the subscription span', () => {
    expect(emulatedOffset(5000, -7000, 12.5, 0.16)).toBeCloseTo((5000 - -7000 + 12.5) * 0.16, 4);
    expect(emulatedOffset(-250, 0, 0, 1)).toBeCloseTo(-250, 5);
  });
});

describe('stroke tessellation', () => {
  it('covers a round stroke like a stadium and stays local at the world edge', () => {
    const near = tessellateStroke({ id, brush: 'round', width: 4, points: [[0, 0], [20, 0]] });
    const far = tessellateStroke({ id, brush: 'round', width: 4, points: [[1e9, -1e9], [1e9 + 20, -1e9]] });
    expect(Array.from(far.triangles)).toEqual(Array.from(near.triangles));
    expect(Array.from(far.circles)).toEqual(Array.from(near.circles));
    expect(covers(near, 10, 0)).toBe(true);
    expect(covers(near, 10, 1.9)).toBe(true);
    expect(covers(near, 10, 2.2)).toBe(false);
    expect(covers(near, -1.9, 0)).toBe(true);
    expect(covers(near, -2.2, 0)).toBe(false);
    expect(covers(near, 21.9, 0)).toBe(true);
    expect(covers(near, 22.2, 0)).toBe(false);
  });

  it('gives a square dot and a bevelled corner the canvas footprint', () => {
    const dot = tessellateStroke({ id, brush: 'square', width: 4, points: [[5, 5]] });
    expect(covers(dot, 0, 0)).toBe(true);
    expect(covers(dot, 1.9, 1.9)).toBe(true);
    expect(covers(dot, 2.1, 0)).toBe(false);
    const corner = tessellateStroke({ id, brush: 'square', width: 2, points: [[0, 0], [10, 0], [10, 10]] });
    expect(covers(corner, -0.9, 0)).toBe(true);
    expect(covers(corner, -1.2, 0)).toBe(false);
    expect(covers(corner, 10, 5)).toBe(true);
    expect(covers(corner, 10.5, -0.4)).toBe(true);
    expect(covers(corner, 11, -1)).toBe(false);
    expect(covers(corner, 10.9, 10.9)).toBe(true);
    expect(covers(corner, 12.2, 10)).toBe(false);
  });

  it('fans chisel hulls and keeps one circle per spray particle', () => {
    const chisel = tessellateStroke({ id, brush: 'chisel', width: 24, points: [[0, 0], [30, 0]] });
    expect(chisel.circles.length).toBe(0);
    expect(chisel.triangles.length).toBeGreaterThan(0);
    expect(covers(chisel, 15, 0)).toBe(true);
    const spray = tessellateStroke({ id, brush: 'spray', width: 32, points: [[0, 0], [64, 0]] });
    const particles = [...sprayParticles({ id, width: 32, points: [[0, 0], [64, 0]] })];
    expect(spray.triangles.length).toBe(0);
    expect(spray.circles.length / 3).toBe(particles.length);
    expect(spray.circles[0]).toBe(Math.fround(particles[0]!.x));
    expect(spray.circles[1]).toBe(Math.fround(particles[0]!.y));
    expect(spray.circles[2]).toBe(particles[0]!.radius);
  });

  it('drops empty input', () => {
    const empty = tessellateStroke({ id, brush: 'round', width: 6, points: [] as Point[] });
    expect(empty.triangles.length).toBe(0);
    expect(empty.circles.length).toBe(0);
  });
});
