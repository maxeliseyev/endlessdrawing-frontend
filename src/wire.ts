// Runtime guards for untrusted server JSON shared by the public and admin entries.
// Wire source: ../endless-drawing-backend/docs/protocol.md (from repo root).
import { MAX_POINTS, isBrush, isPoint, type Point, type Stroke } from './model';

export class ProtocolError extends Error {
  constructor() { super('Invalid server response'); }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError();
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new ProtocolError();
  return value;
}
export function uuid(value: unknown): string {
  const id = text(value, 36);
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) throw new ProtocolError();
  return id.toLowerCase();
}

// Points are frozen: completed geometry is immutable, which lets renderer
// caches key on identity.
export function parseStroke(value: unknown): Stroke {
  const v = object(value);
  if (!isBrush(v) || !Array.isArray(v.points) || v.points.length < 1 || v.points.length > MAX_POINTS ||
      !v.points.every(isPoint) || !Number.isSafeInteger(v.seq) || (v.seq as number) <= 0 || typeof v.own !== 'boolean') throw new ProtocolError();
  const points = Object.freeze(v.points.map(([x, y]: Point) => Object.freeze([x, y] as const))) as unknown as Point[];
  return { id: uuid(v.id), seq: v.seq as number, own: v.own, points,
    brush: v.brush, width: v.width, color: v.color.toUpperCase(), opacity: v.opacity };
}

// Optional hello.ack entry hint for a new session: a world point.
export function parseSpawn(value: unknown): Point {
  const v = object(value);
  const point = [v.x, v.y];
  if (!isPoint(point)) throw new ProtocolError();
  return [point[0], point[1]];
}
