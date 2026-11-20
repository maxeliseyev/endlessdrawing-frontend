import { encode } from '@msgpack/msgpack';
import { validateMessagePack } from '../../src/transport/msgpack';

/** Test server only. The production client never sends compact geometry. */
export function compactServerPacket(value: unknown): Uint8Array {
  const message = { ...(value as Record<string, unknown>) };
  const compactStroke = (value: unknown) => {
    const { points, ...fields } = value as { points: number[][]; [key: string]: unknown };
    const path: number[] = [];
    let previousX = 0, previousY = 0;
    const round = (v: number) => v < 0 ? -Math.round(-v * 16) : Math.round(v * 16);
    for (const [x, y] of points) {
      const nextX = round(x!), nextY = round(y!);
      path.push(nextX - previousX, nextY - previousY);
      previousX = nextX; previousY = nextY;
    }
    return { ...fields, path };
  };
  if (message.type === 'stroke.created' || (message.type === 'ack' && message.operation === 'stroke.create')) {
    message.stroke = compactStroke(message.stroke);
  }
  if (message.type === 'viewport.snapshot.chunk') message.strokes = (message.strokes as unknown[]).map(compactStroke);
  const bytes = encode(message, { forceFloat32: false });
  validateMessagePack(bytes, undefined, true);
  return bytes;
}
