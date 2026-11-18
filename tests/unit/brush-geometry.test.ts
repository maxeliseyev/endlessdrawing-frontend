import { describe, expect, it } from 'vitest';
import { chiselPolygons, chiselTip, MAX_SPRAY_PARTICLES_PER_STAMP, MAX_SPRAY_STAMPS, sprayParticles } from '../../src/brush-geometry';
import { DEFAULT_PREFERENCES, isBrush, isBrushShape, type Point } from '../../src/model';

const id = '87a122fa-7537-4b88-9b77-b45d24a29714';

describe('brush variants', () => {
  it.each(['round', 'square', 'chisel', 'spray'])('accepts %s without changing other brush validation', (brush) => {
    expect(isBrushShape(brush)).toBe(true);
    expect(isBrush({ ...DEFAULT_PREFERENCES, brush })).toBe(true);
    expect(isBrush({ ...DEFAULT_PREFERENCES, brush, opacity: 0 })).toBe(false);
    expect(isBrush({ ...DEFAULT_PREFERENCES, brush, width: 65 })).toBe(false);
  });

  it.each(['triangle', 'CHISEL', null, undefined])('rejects unknown shape %s', (brush) => {
    expect(isBrushShape(brush)).toBe(false);
    expect(isBrush({ ...DEFAULT_PREFERENCES, brush })).toBe(false);
  });
});

describe('fixed diagonal chisel nib', () => {
  it('has a -45 degree long edge and width/6 thickness', () => {
    const tip = chiselTip(12);
    const a = tip[0]!;
    const b = tip[1]!;
    const c = tip[2]!;
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(12);
    expect(b[0] - a[0]).toBeCloseTo(-(b[1] - a[1]));
    expect(Math.hypot(c[0] - b[0], c[1] - b[1])).toBeCloseTo(2);
  });

  it.each([1, 6, 64])('keeps width %s within the documented conservative bounds', (width) => {
    const polygons = [...chiselPolygons([[1e9, -1e9]], width)];
    expect(polygons).toHaveLength(1);
    expect(polygons[0]).toHaveLength(4);
    for (const [x, y] of polygons[0]!) {
      expect(Math.abs(x)).toBeLessThanOrEqual(width / Math.SQRT2);
      expect(Math.abs(y)).toBeLessThanOrEqual(width / Math.SQRT2);
    }
  });

  it('sweeps across long segments without gaps, with positive polygon winding', () => {
    const polygons = [...chiselPolygons([[0, 0], [200, 0], [200, 300]], 24)];
    expect(polygons).toHaveLength(2);
    for (const polygon of polygons) {
      const area = polygon.reduce((sum, a, i) => {
        const b = polygon[(i + 1) % polygon.length]!;
        return sum + a[0] * b[1] - b[0] * a[1];
      }, 0);
      expect(area).toBeGreaterThan(0);
    }
    expect(Math.min(...polygons[0]!.map(([x]) => x))).toBeLessThan(0);
    expect(Math.max(...polygons[0]!.map(([x]) => x))).toBeGreaterThan(200);
  });

  it('is camera-independent, handles duplicate points and empty input', () => {
    expect([...chiselPolygons([], 6)]).toEqual([]);
    expect([...chiselPolygons([[0, 0], [0, 0]], 6)][0]).toEqual([...chiselPolygons([[0, 0]], 6)][0]);
    expect([...chiselPolygons([[0, 0], [10, 20]], 6)])
      .toEqual([...chiselPolygons([[1e9 - 10, -1e9], [1e9, -1e9 + 20]], 6)]);
  });
});

describe('deterministic distance-based spray', () => {
  const stroke = { id, width: 32, points: [[0, 0], [64, 0]] as Point[] };

  it('reproduces the same pattern after redraw, deserialization and UUID normalization', () => {
    const particles = [...sprayParticles(stroke)];
    expect([...sprayParticles(JSON.parse(JSON.stringify(stroke)))]).toEqual(particles);
    expect([...sprayParticles({ ...stroke, id: id.toUpperCase() })]).toEqual(particles);
    expect([...sprayParticles({ ...stroke, id: '00000000-0000-4000-8000-000000000001' })]).not.toEqual(particles);
    expect(particles[0]!.x).toBeCloseTo(-13.535378459662176, 10);
    expect(particles[0]!.y).toBeCloseTo(-4.175018980666572, 10);
    expect(particles[0]!.radius).toBe(0.5);
  });

  it('does not depend on pointer event density, duplicates or absolute world position', () => {
    expect([...sprayParticles({ ...stroke, points: [[0, 0], [0, 0], [16, 0], [32, 0], [64, 0]] })])
      .toEqual([...sprayParticles(stroke)]);
    expect([...sprayParticles({ ...stroke, points: [[1000, -2000], [1064, -2000]] })])
      .toEqual([...sprayParticles(stroke)]);
  });

  it.each([1, 6, 8, 10, 32, 64])('keeps fine single-click particles within width %s, including particle radii', (width) => {
    const particles = [...sprayParticles({ id, width, points: [[0, 0]] })];
    expect(particles.length).toBeGreaterThan(0);
    for (const particle of particles) {
      expect(particle.radius).toBeGreaterThan(0);
      expect(particle.radius * 2).toBeLessThanOrEqual(1);
      expect(Math.hypot(particle.x, particle.y) + particle.radius).toBeLessThanOrEqual(width / 2 + 1e-10);
    }
  });

  it('bounds work even for world-spanning segments and returns nothing for an empty path', () => {
    const particles = [...sprayParticles({ id, width: 64, points: [[-1e9, -1e9], [1e9, 1e9]] })];
    expect(particles.length).toBeLessThanOrEqual(MAX_SPRAY_STAMPS * MAX_SPRAY_PARTICLES_PER_STAMP);
    expect(particles.length).toBeGreaterThan(0);
    expect(particles.every(({ x, y, radius }) => Number.isFinite(x) && Number.isFinite(y) && radius > 0)).toBe(true);
    expect([...sprayParticles({ id, width: 64, points: [] })]).toEqual([]);
  });
});
