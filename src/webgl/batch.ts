/** Stroke-table width. The vertex shader fetches column `index % STROKE_COLUMNS`. */
export const STROKE_COLUMNS = 256;

export interface MeshRange {
  triFirst: number;
  triCount: number;
  circleFirst: number;
  circleCount: number;
}

export interface PackedMesh {
  /** x, y, stroke index. */
  triangles: Float32Array;
  /** x, y, radius, stroke index. */
  circles: Float32Array;
  ranges: MeshRange[];
}

export interface DrawSpan {
  start: number;
  /** Exclusive. */
  end: number;
  /** One stroke with opacity below 1. Opaque neighbours share a span. */
  translucent: boolean;
}

interface MeshPart {
  triangles: Float32Array;
  circles: Float32Array;
  index: number;
}

/** seq, then id. Does not mutate the input. */
export function orderBySeq<T extends { seq: number; id: string }>(strokes: readonly T[]): T[] {
  return [...strokes].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * How a frame draws an ordered list. An opaque run is one draw.
 * A translucent stroke is its own span so it can be composited once.
 */
export function drawSpans(strokes: readonly { opacity: number }[]): DrawSpan[] {
  const spans: DrawSpan[] = [];
  let index = 0;
  while (index < strokes.length) {
    if (strokes[index]!.opacity < 1) {
      spans.push({ start: index, end: index + 1, translucent: true });
      index++;
      continue;
    }
    let end = index + 1;
    while (end < strokes.length && strokes[end]!.opacity >= 1) end++;
    spans.push({ start: index, end, translucent: false });
    index = end;
  }
  return spans;
}

/** Concatenate stroke meshes. Triangle and circle counts are vertex/instance counts. */
export function packMesh(parts: readonly MeshPart[]): PackedMesh {
  let triVerts = 0;
  let circleCount = 0;
  for (const part of parts) {
    triVerts += part.triangles.length / 2;
    circleCount += part.circles.length / 3;
  }
  const triangles = new Float32Array(triVerts * 3);
  const circles = new Float32Array(circleCount * 4);
  const ranges: MeshRange[] = [];
  let tv = 0;
  let cv = 0;
  let triCursor = 0;
  let circleCursor = 0;
  for (const part of parts) {
    const triFirst = triCursor;
    for (let i = 0; i < part.triangles.length; i += 2) {
      triangles[tv++] = part.triangles[i]!;
      triangles[tv++] = part.triangles[i + 1]!;
      triangles[tv++] = part.index;
      triCursor++;
    }
    const circleFirst = circleCursor;
    for (let i = 0; i < part.circles.length; i += 3) {
      circles[cv++] = part.circles[i]!;
      circles[cv++] = part.circles[i + 1]!;
      circles[cv++] = part.circles[i + 2]!;
      circles[cv++] = part.index;
      circleCursor++;
    }
    ranges.push({
      triFirst, triCount: triCursor - triFirst,
      circleFirst, circleCount: circleCursor - circleFirst,
    });
  }
  return { triangles, circles, ranges };
}

export interface StrokeTable {
  /** RGBA32F texels, two texels per stroke: origin, then color. */
  texels: Float32Array;
  width: number;
  height: number;
}

/** One row even when the list is empty, so the texture stays valid. */
export function strokeTable(strokes: readonly { origin: ArrayLike<number>; color: ArrayLike<number> }[]): StrokeTable {
  const rows = Math.max(1, Math.ceil(Math.max(1, strokes.length) / STROKE_COLUMNS));
  const width = STROKE_COLUMNS * 2;
  const texels = new Float32Array(width * rows * 4);
  for (let index = 0; index < strokes.length; index++) {
    const stroke = strokes[index]!;
    const col = index % STROKE_COLUMNS;
    const row = Math.floor(index / STROKE_COLUMNS);
    const offset = (row * width + col * 2) * 4;
    texels[offset] = stroke.origin[0] ?? 0;
    texels[offset + 1] = stroke.origin[1] ?? 0;
    texels[offset + 2] = stroke.origin[2] ?? 0;
    texels[offset + 3] = stroke.origin[3] ?? 0;
    texels[offset + 4] = stroke.color[0] ?? 0;
    texels[offset + 5] = stroke.color[1] ?? 0;
    texels[offset + 6] = stroke.color[2] ?? 0;
    texels[offset + 7] = stroke.color[3] ?? 0;
  }
  return { texels, width, height: rows };
}
