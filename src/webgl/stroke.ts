import type { StrokeDraft } from '../model';
import { splitFloat } from './float';
import { tessellateStroke } from './tessellate';

/** One confirmed or overlay stroke, ready for a frame. Independent of the camera and of WebGL. */
export interface PreparedStroke {
  id: string;
  seq: number;
  opacity: number;
  /** Local xy pairs, relative to the first point. */
  triangles: Float32Array;
  /** Local x, y, radius triples. */
  circles: Float32Array;
  /** First point as float32 pairs: x hi, x lo, y hi, y lo. */
  origin: [number, number, number, number];
  /** RGB in 0..1 plus opacity. The fragment shader quantizes RGB back to bytes. */
  color: [number, number, number, number];
}

/** Tessellate once. `seq` is 0 for a live overlay, which is not in the confirmed order. */
export function prepareStroke(stroke: StrokeDraft, seq = 0): PreparedStroke {
  const geometry = tessellateStroke(stroke);
  const first = stroke.points[0] ?? [0, 0];
  const [red, green, blue] = parseColor(stroke.color);
  const [ox, oxLo] = splitFloat(first[0]);
  const [oy, oyLo] = splitFloat(first[1]);
  return {
    id: stroke.id,
    seq,
    opacity: stroke.opacity,
    triangles: geometry.triangles,
    circles: geometry.circles,
    origin: [ox, oxLo, oy, oyLo],
    color: [red / 255, green / 255, blue / 255, stroke.opacity],
  };
}

function parseColor(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(value)) return [32, 32, 32];
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
