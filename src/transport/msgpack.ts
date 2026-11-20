import { decode, encode } from '@msgpack/msgpack';
import { ProtocolError, object, decodeCompactPath } from '../wire';

export const CLIENT_MESSAGE_BYTES = 128 * 1024;
export const SERVER_MESSAGE_BYTES = 256 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

export class CodecError extends ProtocolError {
  constructor(readonly closeCode: 1003 | 1007 | 1009 = 1007) { super(); }
}

/** Bounded structural check before the library allocates containers or rounds int64. */
export function validateMessagePack(bytes: Uint8Array, limit = SERVER_MESSAGE_BYTES, compact = false): void {
  if (bytes.byteLength > limit) throw new CodecError(1009);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0, nodes = 0;
  function take(length: number): number {
    if (length > bytes.length - offset) throw new CodecError();
    const start = offset; offset += length; return start;
  }
  function length(size: number): number {
    const at = take(size);
    return size === 1 ? view.getUint8(at) : size === 2 ? view.getUint16(at) : view.getUint32(at);
  }
  function read(depth: number, key = false, integerOnly = false, path = false): string | undefined {
    if (++nodes > 65_536) throw new CodecError();
    const tag = bytes[take(1)]!;
    let size: number;
    if (integerOnly && !(tag <= 0x7f || tag >= 0xe0 || (tag >= 0xcc && tag <= 0xcf) || (tag >= 0xd0 && tag <= 0xd3))) throw new CodecError();
    if (path && !((tag & 0xf0) === 0x90 || tag === 0xdc || tag === 0xdd)) throw new CodecError();
    if ((tag & 0xe0) === 0xa0 || tag === 0xd9 || tag === 0xda || tag === 0xdb) {
      size = (tag & 0xe0) === 0xa0 ? tag & 31 : length(tag === 0xd9 ? 1 : tag === 0xda ? 2 : 4);
      if (size > 256) throw new CodecError();
      return utf8.decode(bytes.subarray(take(size), offset));
    }
    if (key) throw new CodecError();
    if (tag <= 0x7f || tag >= 0xe0 || tag === 0xc2 || tag === 0xc3) return;
    if (tag === 0xcc || tag === 0xd0) { take(1); return; }
    if (tag === 0xcd || tag === 0xd1) { take(2); return; }
    if (tag === 0xce || tag === 0xd2) { take(4); return; }
    if (tag === 0xcf || tag === 0xd3) {
      const at = take(8);
      const value = tag === 0xcf ? view.getBigUint64(at) : view.getBigInt64(at);
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new CodecError();
      return;
    }
    if (tag === 0xcb) {
      if (!Number.isFinite(view.getFloat64(take(8)))) throw new CodecError();
      return;
    }
    const array = (tag & 0xf0) === 0x90 || tag === 0xdc || tag === 0xdd;
    const map = (tag & 0xf0) === 0x80 || tag === 0xde || tag === 0xdf;
    if ((!array && !map) || depth >= 8) throw new CodecError();
    size = tag < 0xa0 ? tag & 15 : length(tag === 0xdc || tag === 0xde ? 2 : 4);
    if (size > (array ? (compact ? 4000 : 2000) : 16) || size * (map ? 2 : 1) > bytes.length - offset) throw new CodecError();
    if (map) {
      const keys = new Set<string>();
      for (let i = 0; i < size; i++) {
        const name = read(depth + 1, true)!;
        if (forbiddenKeys.has(name) || keys.has(name)) throw new CodecError();
        keys.add(name); read(depth + 1, false, false, compact && name === 'path');
      }
    } else for (let i = 0; i < size; i++) read(depth + 1, false, path);
  }
  try {
    const root = bytes[0];
    if (root === undefined || !((root & 0xf0) === 0x80 || root === 0xde || root === 0xdf)) throw new CodecError();
    read(0);
    if (offset !== bytes.length) throw new CodecError();
  } catch (error) {
    if (error instanceof CodecError) throw error;
    throw new CodecError();
  }
}

export function decodeMessagePack(bytes: Uint8Array, limit = SERVER_MESSAGE_BYTES, protocolVersion = 2): Record<string, unknown> {
  const compact = protocolVersion >= 6;
  validateMessagePack(bytes, limit, compact);
  try {
    const message = object(decode(bytes, { maxStrLength: 256, maxArrayLength: compact ? 4000 : 2000, maxMapLength: 16,
      maxBinLength: 0, maxExtLength: 0 }));
    // Normalize once at the wire boundary; scenes/renderers keep immutable point geometry.
    const normalizeStroke = (value: unknown): Record<string, unknown> => {
      const stroke = object(value);
      if (compact) {
        if ('points' in stroke || !('path' in stroke)) throw new CodecError();
        const { path, ...fields } = stroke;
        return { ...fields, points: decodeCompactPath(path) };
      }
      if ('path' in stroke) throw new CodecError();
      return stroke;
    };
    if (message.type === 'stroke.created' || (message.type === 'ack' && message.operation === 'stroke.create')) {
      message.stroke = normalizeStroke(message.stroke);
    }
    if (message.type === 'viewport.snapshot.chunk') {
      if (Array.isArray(message.strokes)) message.strokes = message.strokes.map(normalizeStroke);
      if (!Array.isArray(message.strokes) || message.strokes.length > 1000) throw new CodecError();
      let points = 0;
      for (const stroke of message.strokes) {
        const geometry = object(stroke).points;
        if (!Array.isArray(geometry)) throw new CodecError();
        points += geometry.length;
      }
      if (points > 8192) throw new CodecError();
    }
    return message;
  } catch { throw new CodecError(); }
}

export function encodeMessagePack(message: unknown, limit = CLIENT_MESSAGE_BYTES): Uint8Array<ArrayBuffer> {
  try {
    const bytes = encode(message, { forceFloat32: false, maxDepth: 8 });
    validateMessagePack(bytes, limit);
    return bytes;
  } catch (error) {
    if (error instanceof CodecError) throw error;
    throw new CodecError();
  }
}
