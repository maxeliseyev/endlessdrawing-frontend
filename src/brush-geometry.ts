import type { Point, StrokeDraft } from './model';

// Geometry below is relative to the first point: DPR and camera never affect it.
export const MAX_SPRAY_STAMPS = 2048;
export const MAX_SPRAY_PARTICLES_PER_STAMP = 48;

export interface Particle { x: number; y: number; radius: number }

function cross(origin: Point, a: Point, b: Point): number {
  return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
}

function convexHull(points: Point[]): Point[] {
  const sorted = points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: Point[] = [];
  const upper: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop();
    lower.push(point);
  }
  for (const point of sorted.toReversed()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function chiselTip(width: number): Point[] {
  const halfLength = width / 2;
  const halfThickness = Math.max(1, width / 6) / 2;
  // Fixed -45° (/ in screen coordinates). Width is the nib's long dimension.
  const corners: Point[] = [
    [-halfLength, -halfThickness], [halfLength, -halfThickness],
    [halfLength, halfThickness], [-halfLength, halfThickness],
  ];
  return corners.map(([x, y]) => [(x + y) / Math.SQRT2, (-x + y) / Math.SQRT2]);
}

export function* chiselPolygons(points: readonly Point[], width: number): Generator<Point[]> {
  const origin = points[0];
  if (!origin) return;
  const tip = chiselTip(width);
  let previous = tip;
  if (points.length === 1) { yield convexHull([...tip]); return; }
  for (const point of points.slice(1)) {
    const next: Point[] = tip.map(([x, y]) => [point[0] - origin[0] + x, point[1] - origin[1] + y]);
    // Sweeping a fixed rectangular nib along a segment gives the convex hull
    // of its endpoint footprints. All polygons have the same winding for union fill.
    yield convexHull([...previous, ...next]);
    previous = next;
  }
}

// FNV-1a over the canonical lowercase UUID followed by xorshift32. No random(),
// elapsed time, arrival order, camera or DPR participates in the spray pattern.
function seededRandom(id: string): () => number {
  let state = 2166136261;
  for (const char of id.toLowerCase()) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function* sprayCenters(points: readonly Point[], width: number): Generator<Point> {
  const origin = points[0];
  if (!origin) return;
  yield [0, 0];
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  const step = Math.max(1, width / 4, length / (MAX_SPRAY_STAMPS - 1));
  let traveled = 0;
  let sample = 1;
  for (let i = 1; i < points.length && sample < MAX_SPRAY_STAMPS; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const segment = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (segment === 0) continue;
    while (sample < MAX_SPRAY_STAMPS && sample * step <= traveled + segment) {
      const t = Math.min(1, (sample * step - traveled) / segment);
      yield [a[0] - origin[0] + (b[0] - a[0]) * t, a[1] - origin[1] + (b[1] - a[1]) * t];
      sample++;
    }
    traveled += segment;
  }
}

export function* sprayParticles(stroke: Pick<StrokeDraft, 'id' | 'points' | 'width'>): Generator<Particle> {
  const random = seededRandom(stroke.id);
  const count = Math.min(MAX_SPRAY_PARTICLES_PER_STAMP, Math.max(6, Math.ceil(stroke.width * 0.75)));
  const radius = Math.max(0.35, Math.min(1.25, stroke.width / 20));
  const spread = Math.max(0, stroke.width / 2 - radius);
  for (const [x, y] of sprayCenters(stroke.points, stroke.width)) {
    for (let i = 0; i < count; i++) {
      const angle = random() * Math.PI * 2;
      const distance = Math.sqrt(random()) * spread;
      yield { x: x + Math.cos(angle) * distance, y: y + Math.sin(angle) * distance, radius };
    }
  }
}
