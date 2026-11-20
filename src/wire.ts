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

// v5 author tag: first 16 bytes of a SHA-256, unpadded base64url.
const AUTHOR = /^[A-Za-z0-9_-]{22}$/;

// Points are frozen: completed geometry is immutable, which lets renderer
// caches key on identity.
export function parseStroke(value: unknown): Stroke {
  const v = object(value);
  if (!isBrush(v) || !Array.isArray(v.points) || v.points.length < 1 || v.points.length > MAX_POINTS ||
      !v.points.every(isPoint) || !Number.isSafeInteger(v.seq) || (v.seq as number) <= 0 || typeof v.own !== 'boolean') throw new ProtocolError();
  const points = Object.freeze(v.points.map(([x, y]: Point) => Object.freeze([x, y] as const))) as unknown as Point[];
  if (v.author !== undefined && (typeof v.author !== 'string' || !AUTHOR.test(v.author))) throw new ProtocolError();
  return { id: uuid(v.id), seq: v.seq as number, own: v.own, points,
    brush: v.brush, width: v.width, color: v.color.toUpperCase(), opacity: v.opacity,
    ...(typeof v.author === 'string' ? { author: v.author } : {}) };
}

/** Decode in integer space: each delta joins already-rounded points, without accumulated error. */
export function decodeCompactPath(value: unknown): Point[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_POINTS * 2 || value.length % 2 !== 0 ||
      !value.every(Number.isSafeInteger)) throw new ProtocolError();
  const points: Point[] = [];
  let x = 0, y = 0;
  for (let i = 0; i < value.length; i += 2) {
    x += value[i]; y += value[i + 1];
    const point: Point = [x / 16, y / 16];
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !isPoint(point)) throw new ProtocolError();
    points.push(point);
  }
  return points;
}

// Optional hello.ack entry hint for a new session: a world point.
export function parseSpawn(value: unknown): Point {
  const v = object(value);
  const point = [v.x, v.y];
  if (!isPoint(point)) throw new ProtocolError();
  return [point[0], point[1]];
}
