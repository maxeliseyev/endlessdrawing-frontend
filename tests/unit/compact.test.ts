import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decode, encode } from '@msgpack/msgpack';
import { describe, expect, it } from 'vitest';
import { COMPACT_PROTOCOL, SAFETY_PROTOCOL, socketCodec, WS_PROTOCOLS } from '../../src/transport/codec';
import { CodecError, decodeMessagePack, encodeMessagePack, validateMessagePack } from '../../src/transport/msgpack';
import { parseStroke } from '../../src/wire';

const stroke = { id: '87a122fa-7537-4b88-9b77-b45d24a29714', path: [160, -40, 1, 1, 127, -32],
  brush: 'round', width: 4.5, color: '#E46C60', opacity: 0.75, seq: 42, own: true, author: 'AAAAAAAAAAAAAAAAAAAAAA' };
const message = (s: unknown = stroke) => ({ type: 'stroke.created', subscription_id: 's', stroke: s });
const codec = socketCodec(COMPACT_PROTOCOL);
const receive = (m: unknown) => codec.decode(encode(m).slice().buffer);

describe('v6 compact server geometry', () => {
  it('offers v6 first but keeps v5 rollback and full-precision uplink', () => {
    expect(WS_PROTOCOLS.slice(0, 2)).toEqual([COMPACT_PROTOCOL, SAFETY_PROTOCOL]);
    expect(codec.protocolVersion).toBe(6);
    const { path: _, ...fields } = stroke;
    const create = { type: 'stroke.create', request_id: 'r', stroke: { ...fields, points: [[0.012345, -0.098765]] } };
    expect(decodeMessagePack(codec.encode(create) as Uint8Array)).toEqual(create);
    expect(socketCodec(SAFETY_PROTOCOL).decode(encode(message({ ...fields, points: [[0.012345, -0.098765]] })).slice().buffer))
      .toEqual(message({ ...fields, points: [[0.012345, -0.098765]] }));
  });

  it('normalizes snapshot/fetch chunks, live events and create acks to immutable points', () => {
    const points = [[10, -2.5], [10.0625, -2.4375], [18, -4.4375]];
    for (const m of [message(), { type: 'ack', operation: 'stroke.create', request_id: 'r', stroke }]) {
      const parsed = parseStroke(receive(m).stroke);
      expect(parsed.points).toEqual(points);
      expect(Object.isFrozen(parsed.points) && parsed.points.every(Object.isFrozen)).toBe(true);
    }
    expect((receive({ type: 'viewport.snapshot.chunk', strokes: [stroke] }).strokes as Record<string, unknown>[])[0]!.points).toEqual(points);
  });

  it('accepts 2000 points and counts points, not path elements, against the chunk budget', () => {
    const full = { ...stroke, path: Array(4000).fill(0) };
    const chunk = (count: number) => ({ type: 'viewport.snapshot.chunk', strokes: Array(count).fill(full) });
    expect((receive(chunk(4)).strokes as unknown[]).length).toBe(4);
    expect(() => receive(chunk(5))).toThrow(CodecError);
    expect(() => encodeMessagePack({ path: Array(4000).fill(0) })).toThrow(CodecError); // uplink stays 2000
    expect(() => receive(message({ ...stroke, path: Array(4002).fill(0) }))).toThrow(CodecError);
    const many = { ...stroke, path: [0, 0, ...Array(3998).fill(1)] };
    expect(parseStroke(receive(message(many)).stroke).points.at(-1)).toEqual([1999 / 16, 1999 / 16]);
  });

  it('rejects wrong profiles, malformed paths, unsafe sums and out-of-world coordinates', () => {
    for (const path of [[], [1], [1, 2, 3], [null, 0], [true, 0], [0.5, 0], [Number.MAX_SAFE_INTEGER + 1, 0],
      [16_000_000_001, 0], [16_000_000_000, 0, 1, 0]]) {
      expect(() => receive(message({ ...stroke, path })), JSON.stringify(path)).toThrow(CodecError);
    }
    const { path: _, ...fields } = stroke;
    for (const s of [{ ...fields, points: [[0, 0]] }, { ...stroke, points: [[0, 0]] }, fields]) {
      expect(() => receive(message(s))).toThrow(CodecError);
    }
    expect(() => socketCodec(SAFETY_PROTOCOL).decode(encode(message()).slice().buffer)).toThrow(CodecError);
    // An integral float64 is still not a MessagePack integer.
    expect(() => codec.decode(encode(message(), { forceIntegerToFloat: true }).slice().buffer)).toThrow(CodecError);
    expect(parseStroke(receive(message({ ...stroke, path: [16_000_000_000, -16_000_000_000, -1, 1] })).stroke).points)
      .toEqual([[1e9, -1e9], [1e9 - 1 / 16, -1e9 + 1 / 16]]);
  });

  it('pins and decodes both backend encoders without relaxing domain guards for synthetic fixtures', () => {
    const directory = new URL('../fixtures/ws-v6/', import.meta.url);
    const hashes = JSON.parse(readFileSync(new URL('sha256.json', directory), 'utf8')) as Record<string, string>;
    for (const [name, hash] of Object.entries(hashes)) {
      expect(createHash('sha256').update(readFileSync(new URL(name, directory))).digest('hex')).toBe(hash);
    }
    const samples = JSON.parse(readFileSync(new URL('corpus.json', directory), 'utf8')) as { name: string; value: unknown }[];
    for (const { name, value } of samples) for (const encoder of ['rust', 'ts']) {
      const bytes = readFileSync(new URL(`${name}.${encoder}.msgpack`, directory));
      validateMessagePack(bytes, undefined, true);
      expect(decode(bytes)).toEqual(value);
      // The synthetic snapshot intentionally exceeds world/span limits.
      if (name === 'snapshot-compact') expect(() => decodeMessagePack(bytes, undefined, 6)).toThrow(CodecError);
      else expect(() => decodeMessagePack(bytes, undefined, 6)).not.toThrow();
    }
  });
});
