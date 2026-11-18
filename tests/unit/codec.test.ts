import { describe, expect, it } from 'vitest';
import { encode } from '@msgpack/msgpack';
import { JSON_PROTOCOL, MSGPACK_PROTOCOL, socketCodec } from '../../src/transport/codec';
import { CLIENT_MESSAGE_BYTES, CodecError, decodeMessagePack, encodeMessagePack, SERVER_MESSAGE_BYTES,
  validateMessagePack } from '../../src/transport/msgpack';

const point = [999_999_999.125, -999_999_999.0625];
const stroke = { id: '87a122fa-7537-4b88-9b77-b45d24a29714', points: [point], brush: 'spray',
  width: 6.25, color: '#AABBCC', opacity: 0.125, seq: Number.MAX_SAFE_INTEGER, own: true };

describe('MessagePack wire boundary', () => {
  it('preserves full world precision, names, UUID strings and safe int64', () => {
    const message = { type: 'stroke.created', subscription_id: 'view', stroke };
    expect(decodeMessagePack(encodeMessagePack(message))).toEqual(message);
    const codec = socketCodec(MSGPACK_PROTOCOL);
    expect(codec.protocolVersion).toBe(2);
    expect(codec.decode(encodeMessagePack(message).slice().buffer)).toEqual(message);
  });

  it('keeps the explicit JSON profile and rejects ambiguous or wrong frame types', () => {
    const codec = socketCodec(JSON_PROTOCOL, 128);
    expect(codec.protocolVersion).toBe(1);
    expect(codec.decode(codec.encode({ type: 'hello' }))).toEqual({ type: 'hello' });
    expect(() => socketCodec('')).toThrow(CodecError);
    expect(() => socketCodec('unexpected')).toThrow(CodecError);
    expect(() => codec.decode(new ArrayBuffer(1))).toThrow(CodecError);
    expect(() => socketCodec(MSGPACK_PROTOCOL).decode('{}')).toThrow(CodecError);
    expect(() => codec.decode(' '.repeat(129))).toThrow(CodecError);
  });

  it('limits actual encoded bytes in each direction', () => {
    expect(() => validateMessagePack(new Uint8Array(SERVER_MESSAGE_BYTES + 1))).toThrow(CodecError);
    const message = { strokes: Array.from({ length: 4 }, () => ({ ...stroke,
      points: Array.from({ length: 2000 }, () => point) })) };
    const bytes = encodeMessagePack(message, SERVER_MESSAGE_BYTES);
    expect(bytes.byteLength).toBeGreaterThan(CLIENT_MESSAGE_BYTES);
    expect(() => validateMessagePack(bytes, CLIENT_MESSAGE_BYTES)).toThrow(CodecError);
  });

  it('rejects hostile headers, types, duplicate keys, unsafe integers and trailing bytes', () => {
    const invalid = [
      [], [0xc0], [0x90], [0x81, 0xa1, 0x61, 0xdd, 255, 255, 255, 255],
      [0xdf, 255, 255, 255, 255], [0x81, 1, 1], [0x82, 0xa1, 0x61, 1, 0xa1, 0x61, 2],
      [0x81, 0xa1, 0x61, 0xcf, 0, 32, 0, 0, 0, 0, 0, 0],
      [0x81, 0xa1, 0x61, 0xd3, 255, 223, 255, 255, 255, 255, 255, 255],
      [0x81, 0xa1, 0xff, 1], [0x81, 0xa1, 0x61, 0xca, 0, 0, 0, 0],
      [0x81, 0xa1, 0x61, 0xc4, 0], [0x81, 0xa1, 0x61, 0xd4, 0, 0],
      [0x80, 0x80], [0x81, 0xa1, 0x61, 0xc0],
    ];
    for (const bytes of invalid) expect(() => decodeMessagePack(Uint8Array.from(bytes)), String(bytes)).toThrow(CodecError);
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(() => decodeMessagePack(encode({ [key]: 1 }))).toThrow(CodecError);
    }
    for (const n of [NaN, Infinity, -Infinity]) expect(() => decodeMessagePack(encode({ n }))).toThrow(CodecError);
  });

  it('rejects deep nesting and truncated messages without accepting a prefix', () => {
    let nested: unknown = 1;
    for (let i = 0; i < 9; i++) nested = [nested];
    expect(() => decodeMessagePack(encode({ nested }))).toThrow(CodecError);
    const bytes = encodeMessagePack({ stroke });
    for (let end = 0; end < bytes.length; end++) {
      expect(() => decodeMessagePack(bytes.subarray(0, end))).toThrow(CodecError);
    }
  });

  it('reduces a deterministic geometry-heavy snapshot below 60% of JSON bytes', () => {
    const message = { type: 'viewport.snapshot.chunk', subscription_id: 'view', strokes: [{ ...stroke,
      points: Array.from({ length: 2000 }, (_, i) => [1234.125 + Math.sin(i) * 100, -4321.25 + Math.cos(i) * 100]) }] };
    expect(encodeMessagePack(message).byteLength).toBeLessThan(new TextEncoder().encode(JSON.stringify(message)).length * 0.6);
  });
});
