import { chiselPolygons, sprayParticles } from '../brush-geometry';
import type { Point, StrokeDraft } from '../model';

/**
 * Local-space geometry for one stroke, relative to its first point.
 * Round is the union of segment rectangles and a disk at every vertex
 * (canvas round cap + round join). Square is segment rectangles, square caps
 * and a bevel triangle at each corner. Chisel fans are the convex hulls from
 * `chiselPolygons`. Spray is one circle per particle. The GPU draws circles
 * with an SDF so the particle count never becomes a triangle fan.
 */
export interface StrokeGeometry {
  /** Triangle list, xy pairs. */
  triangles: Float32Array;
  /** Circles as x, y, radius triples. */
  circles: Float32Array;
}

type Drawable = Pick<StrokeDraft, 'id' | 'points' | 'brush' | 'width'>;

interface Segment {
  p0: Point;
  p1: Point;
  dir: Point;
  l0: Point;
  r0: Point;
  l1: Point;
  r1: Point;
}

export function tessellateStroke(stroke: Drawable): StrokeGeometry {
  const tris: number[] = [];
  const circles: number[] = [];
  const first = stroke.points[0];
  if (!first || !Number.isFinite(stroke.width) || stroke.width <= 0) {
    return { triangles: new Float32Array(), circles: new Float32Array() };
  }
  const local = (point: Point): Point => [point[0] - first[0], point[1] - first[1]];
  if (stroke.brush === 'chisel') {
    for (const polygon of chiselPolygons(stroke.points, stroke.width)) fan(tris, polygon);
  } else if (stroke.brush === 'spray') {
    for (const particle of sprayParticles(stroke)) circles.push(particle.x, particle.y, particle.radius);
  } else {
    const points = stroke.points.map(local);
    const half = stroke.width / 2;
    const segments = polyline(points, half);
    if (stroke.brush === 'round') {
      for (const segment of segments) quad(tris, segment.l0, segment.l1, segment.r1, segment.r0);
      let previous: Point | undefined;
      for (const point of points) {
        if (previous && previous[0] === point[0] && previous[1] === point[1]) continue;
        circles.push(point[0], point[1], half);
        previous = point;
      }
    } else if (segments.length === 0) {
      squareDot(tris, half);
    } else {
      const start = segments[0]!;
      const end = segments[segments.length - 1]!;
      cap(tris, start.dir, start.l0, start.r0, -1);
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i]!;
        quad(tris, segment.l0, segment.l1, segment.r1, segment.r0);
        const next = segments[i + 1];
        if (next) bevel(tris, segment, next);
      }
      cap(tris, end.dir, end.l1, end.r1, 1);
    }
  }
  return { triangles: Float32Array.from(tris), circles: Float32Array.from(circles) };
}

function polyline(points: readonly Point[], half: number): Segment[] {
  const segments: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1]!;
    const p1 = points[i]!;
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-8) continue;
    const dir: Point = [dx / length, dy / length];
    const n: Point = [-dir[1], dir[0]];
    segments.push({
      p0, p1, dir,
      l0: [p0[0] + n[0] * half, p0[1] + n[1] * half],
      r0: [p0[0] - n[0] * half, p0[1] - n[1] * half],
      l1: [p1[0] + n[0] * half, p1[1] + n[1] * half],
      r1: [p1[0] - n[0] * half, p1[1] - n[1] * half],
    });
  }
  return segments;
}

function squareDot(out: number[], half: number): void {
  quad(out, [-half, -half], [half, -half], [half, half], [-half, half]);
}

// Square cap: half a stroke width past the endpoint, along the segment.
function cap(out: number[], dir: Point, left: Point, right: Point, sign: number): void {
  const half = Math.hypot(left[0] - right[0], left[1] - right[1]) / 2;
  const ex = dir[0] * half * sign;
  const ey = dir[1] * half * sign;
  const a: Point = [left[0] + ex, left[1] + ey];
  const b: Point = [right[0] + ex, right[1] + ey];
  if (sign < 0) quad(out, a, left, right, b);
  else quad(out, left, a, b, right);
}

function bevel(out: number[], a: Segment, b: Segment): void {
  const cross = a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0];
  if (cross > 1e-8) tri(out, a.r1, b.r0, a.p1);
  else if (cross < -1e-8) tri(out, a.l1, b.l0, a.p1);
}

function fan(out: number[], polygon: readonly Point[]): void {
  const origin = polygon[0];
  if (!origin || polygon.length < 3) return;
  for (let i = 1; i < polygon.length - 1; i++) tri(out, origin, polygon[i]!, polygon[i + 1]!);
}

function quad(out: number[], a: Point, b: Point, c: Point, d: Point): void {
  tri(out, a, b, c);
  tri(out, a, c, d);
}

function tri(out: number[], a: Point, b: Point, c: Point): void {
  out.push(a[0], a[1], b[0], b[1], c[0], c[1]);
}
