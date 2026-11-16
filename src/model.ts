export const WORLD_LIMIT = 1_000_000_000;
export const MAX_POINTS = 2000;
export const MAX_MESSAGE_BYTES = 128 * 1024;
export const ERASER_TOLERANCE = 4; // CSS pixels; zoom is fixed at 1.

export type Point = readonly [x: number, y: number];
export type Tool = 'brush' | 'hand' | 'eraser';
export type BrushShape = 'round' | 'square' | 'chisel' | 'spray';

export interface Brush {
  brush: BrushShape;
  width: number;
  color: string;
  opacity: number;
}

// stroke.create payload; chisel/spray extend the original round/square contract.
// Backend support for these enum values must be added before WS integration.
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

export function fitsCreateMessage(stroke: StrokeDraft): boolean {
  // A UUID request_id matches the planned transport, including its JSON overhead.
  const message = { type: 'stroke.create', request_id: crypto.randomUUID(), stroke };
  return new TextEncoder().encode(JSON.stringify(message)).byteLength <= MAX_MESSAGE_BYTES;
}
