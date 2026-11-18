import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadOnlyWorld, type WorldStatus } from '../../src/admin/world';
import { MANIFEST_PROTOCOL } from '../../src/transport/codec';
import { decodeMessagePack, encodeMessagePack, SERVER_MESSAGE_BYTES } from '../../src/transport/msgpack';

const a = '00000000-0000-4000-8000-00000000000a';
const b = '00000000-0000-4000-8000-00000000000b';
const token = '00000000-0000-4000-8000-000000000001';
const stroke = (id: string, seq: number) => ({ id, seq, own: false, points: [[0, 0]], brush: 'round', width: 6, color: '#202020', opacity: 1 });
const bounds = { min_x: -100, min_y: -100, max_x: 100, max_y: 100 };

class Socket {
  protocol = MANIFEST_PROTOCOL;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Record<string, unknown>[] = [];
  close() { this.readyState = 3; this.onclose?.(); }
  send(bytes: Uint8Array) { this.sent.push(decodeMessagePack(bytes)); }
  receive(type: string, fields = {}) { this.onmessage?.({ data: encodeMessagePack({ type, ...fields }, SERVER_MESSAGE_BYTES).slice().buffer }); }
  last() { return this.sent.at(-1)!; }
}

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('window', { location: { href: 'http://localhost/' } });
  vi.stubGlobal('WebSocket', { OPEN: 1 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('read-only admin manifest transport', () => {
  it('preserves the cache while loading and does not resurrect a locally acknowledged hide', () => {
    const socket = new Socket(); const statuses: WorldStatus[] = [];
    const world = new ReadOnlyWorld((status) => statuses.push(status), () => socket as unknown as WebSocket);
    world.start(bounds); socket.onopen?.(); socket.receive('hello.ack', { protocol_version: 3 });
    const first = socket.last().subscription_id;
    socket.receive('viewport.snapshot.begin', { subscription_id: first });
    socket.receive('viewport.snapshot.chunk', { subscription_id: first, strokes: [stroke(a, 1)] });
    socket.receive('viewport.snapshot.end', { subscription_id: first });
    expect(world.scene.strokes.size).toBe(1);
    world.refresh(); vi.advanceTimersByTime(300);
    expect(socket.last().type).toBe('viewport.subscribe.cached');
    const sid = socket.last().subscription_id;
    expect(world.scene.strokes.size).toBe(1);
    socket.receive('viewport.snapshot.begin', { subscription_id: sid });
    world.scene.remove([a]);
    socket.receive('viewport.manifest.begin', { subscription_id: sid, snapshot_token: token, stroke_count: 2, point_count: 2 });
    socket.receive('viewport.manifest.chunk', { subscription_id: sid, snapshot_token: token, stroke_ids: [a, b] });
    socket.receive('viewport.manifest.end', { subscription_id: sid, snapshot_token: token });
    expect(socket.last().type).toBe('viewport.fetch');
    socket.receive('viewport.snapshot.chunk', { subscription_id: sid, strokes: [stroke(a, 1), stroke(b, 2)] });
    socket.receive('viewport.snapshot.end', { subscription_id: sid });
    expect([...world.scene.strokes.keys()]).toEqual([b]);
    expect(statuses.at(-1)).toBe('ready');
    expect(socket.sent.every((m) => ['hello', 'viewport.subscribe', 'viewport.subscribe.cached', 'viewport.fetch'].includes(String(m.type)))).toBe(true);
    world.stop(); expect(world.scene.strokes.size).toBe(0);
  });
});
