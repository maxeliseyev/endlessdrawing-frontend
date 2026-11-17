export const WORLD_LIMIT = 1_000_000_000;
export const MAX_POINTS = 2000;
export const MAX_MESSAGE_BYTES = 128 * 1024;
export const ERASER_TOLERANCE = 4; // CSS pixels on screen, independent of zoom.

export type Point = readonly [x: number, y: number];
export type Tool = 'brush' | 'hand' | 'eraser';
export type BrushShape = 'round' | 'square' | 'chisel' | 'spray';

export interface Brush {
  brush: BrushShape;
  width: number;
  color: string;
  opacity: number;
}

// stroke.create payload. chisel/spray are accepted by backend migration 0003.
// Never add ownership or server seq here.
export interface StrokeDraft extends Brush {
  id: string;
  points: Point[];
}

export interface Stroke extends StrokeDraft {
  seq: number;
  own: boolean;
}

export interface Preferences extends Brush {
  tool: Tool;
}

export const DEFAULT_PREFERENCES: Readonly<Preferences> = {
  tool: 'brush',
  brush: 'round',
  width: 6,
  color: '#202020',
  opacity: 1,
};

export function isTool(value: unknown): value is Tool {
  return value === 'brush' || value === 'hand' || value === 'eraser';
}

export function isBrushShape(value: unknown): value is BrushShape {
  return value === 'round' || value === 'square' || value === 'chisel' || value === 'spray';
}

export function isBrush(value: unknown): value is Brush {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  return (
    isBrushShape(b.brush) &&
    typeof b.width === 'number' && Number.isFinite(b.width) && b.width >= 1 && b.width <= 64 &&
    typeof b.color === 'string' && /^#[\da-f]{6}$/i.test(b.color) &&
    typeof b.opacity === 'number' && Number.isFinite(b.opacity) && b.opacity > 0 && b.opacity <= 1
  );
}

export function isPoint(value: unknown): value is Point {
  return Array.isArray(value) && value.length === 2 &&
    value.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= WORLD_LIMIT);
}

// Decimate the full gesture rather than truncating its tail at the protocol limit.
// Every pass retains its endpoints; input continues until pointerup.
export function appendPoint(points: Point[], point: Point, force = false): void {
  const last = points.at(-1);
  if (last && last[0] === point[0] && last[1] === point[1]) return;
  if (!force && last && Math.hypot(point[0] - last[0], point[1] - last[1]) < 0.75) return;
  if (points.length >= MAX_POINTS) {
    const reduced = points.filter((_, index) => index % 2 === 0 || index === points.length - 1);
    points.splice(0, points.length, ...reduced);
  }
  points.push(point);
}

// crypto.randomUUID exists only in secure contexts; plain-HTTP LAN testing on a
// phone still has getRandomValues. Both produce RFC 4122 version 4 UUIDs.
export function newId(random?: (bytes: Uint8Array) => Uint8Array): string {
  if (!random && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = (random ?? ((bytes) => crypto.getRandomValues(bytes)))(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface Extent { min_x: number; min_y: number; max_x: number; max_y: number }
const extents = new WeakMap<readonly Point[], Extent>();

// Same conservative padding as the backend bbox (domain.rs), used for culling.
export function strokeExtent(stroke: Pick<StrokeDraft, 'points' | 'brush' | 'width'>): Extent {
  let cached = extents.get(stroke.points);
  if (!cached || stroke.points.length === 0) {
    let min_x = Infinity, min_y = Infinity, max_x = -Infinity, max_y = -Infinity;
    for (const [x, y] of stroke.points) {
      if (x < min_x) min_x = x; if (x > max_x) max_x = x;
      if (y < min_y) min_y = y; if (y > max_y) max_y = y;
    }
    const pad = (stroke.brush === 'square' || stroke.brush === 'chisel' ? stroke.width / Math.SQRT2 : stroke.width / 2) + 1;
    cached = { min_x: min_x - pad, min_y: min_y - pad, max_x: max_x + pad, max_y: max_y + pad };
    // Preview points mutate; only cache immutable (completed) geometry by identity + length.
    if (Object.isFrozen(stroke.points)) extents.set(stroke.points, cached);
  }
  return cached;
}

export function fitsCreateMessage(stroke: StrokeDraft): boolean {
  // A UUID request_id matches the transport, including its JSON overhead.
  const message = { type: 'stroke.create', request_id: newId(), stroke };
  return new TextEncoder().encode(JSON.stringify(message)).byteLength <= MAX_MESSAGE_BYTES;
}
