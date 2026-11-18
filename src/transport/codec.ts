import { object } from '../wire';
import { CLIENT_MESSAGE_BYTES, CodecError, decodeMessagePack, encodeMessagePack } from './msgpack';

export const MSGPACK_PROTOCOL = 'endless-drawing.msgpack.v2';
export const PRIORITY_PROTOCOL = 'endless-drawing.msgpack.v4';
export const MANIFEST_PROTOCOL = 'endless-drawing.msgpack.v3';
export const JSON_PROTOCOL = 'endless-drawing.json.v1';
export const WS_PROTOCOLS = [PRIORITY_PROTOCOL, MANIFEST_PROTOCOL, MSGPACK_PROTOCOL, JSON_PROTOCOL];

export interface WireCodec {
  readonly protocolVersion: 1 | 2 | 3 | 4;
  encode(message: unknown): string | Uint8Array<ArrayBuffer>;
  decode(data: unknown): Record<string, unknown>;
}

/** The negotiated profile is fixed for the lifetime of one socket. */
export function socketCodec(protocol: string, legacyByteLimit = 4_194_304): WireCodec {
  if (protocol === MSGPACK_PROTOCOL || protocol === MANIFEST_PROTOCOL || protocol === PRIORITY_PROTOCOL) return {
    protocolVersion: protocol === PRIORITY_PROTOCOL ? 4 : protocol === MANIFEST_PROTOCOL ? 3 : 2,
    encode: encodeMessagePack,
    decode(data) {
      if (!(data instanceof ArrayBuffer)) throw new CodecError(1003);
      return decodeMessagePack(new Uint8Array(data));
    },
  };
  if (protocol !== JSON_PROTOCOL) throw new CodecError(1003);
  const utf8 = new TextEncoder();
  return {
    protocolVersion: 1,
    encode(message) {
      const text = JSON.stringify(message);
      if (utf8.encode(text).length > CLIENT_MESSAGE_BYTES) throw new CodecError(1009);
      return text;
    },
    decode(data) {
      if (typeof data !== 'string') throw new CodecError(1003);
      if (data.length > legacyByteLimit || utf8.encode(data).length > legacyByteLimit) throw new CodecError(1009);
      return object(JSON.parse(data));
    },
  };
}
