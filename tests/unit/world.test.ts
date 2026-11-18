import { JSON_PROTOCOL, MSGPACK_PROTOCOL, MANIFEST_PROTOCOL, PRIORITY_PROTOCOL } from '../../src/transport/codec';
import { decodeMessagePack, encodeMessagePack, SERVER_MESSAGE_BYTES } from '../../src/transport/msgpack';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StrokeDraft } from '../../src/model';
import { MAX_PENDING, SharedScene } from '../../src/scene';
import { SharedWorld, type Notice } from '../../src/world';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const bounds = { min_x: -100, min_y: -100, max_x: 100, max_y: 100 };

function draft(id: string): StrokeDraft {
  return { id, points: Object.freeze([[0, 0], [10, 5]]) as unknown as StrokeDraft['points'], brush: 'spray', width: 6, color: '#202020', opacity: 1 };
}
function wire(id: string, seq: number, own: boolean) {
  return { ...draft(id), points: [[0, 0], [10, 5]], seq, own };
}

class FakeSocket {
  static readonly instances: FakeSocket[] = [];
  readyState = 0;
  protocol = JSON_PROTOCOL;
  binaryType = 'blob';
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(data: string | Uint8Array) { this.sent.push(typeof data === 'string' ? JSON.parse(data) as Record<string, unknown> : decodeMessagePack(data)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: unknown) { this.onmessage?.({ data: this.protocol !== JSON_PROTOCOL ? encodeMessagePack(message, SERVER_MESSAGE_BYTES).slice().buffer : JSON.stringify(message) }); }
  of(type: string) { return this.sent.filter((m) => m.type === type); }
  last(type: string) { return this.of(type).at(-1)!; }
  // hello.ack + empty snapshot for the latest subscription.
  ready() {
    this.open();
    this.receive({ type: 'hello.ack', protocol_version: 1 });
    const id = this.last('viewport.subscribe').subscription_id;
    this.receive({ type: 'viewport.snapshot.begin', subscription_id: id });
    this.receive({ type: 'viewport.snapshot.end', subscription_id: id });
    return id as string;
  }
}

function setup(stored: string[] = []) {
  FakeSocket.instances.length = 0;
  const notices: Notice[] = [];
  const saved: string[][] = [];
  const world = new SharedWorld({
    secret: 'A'.repeat(43), url: 'ws://test/ws',
    undo: { load: () => stored, save: (ids) => { saved.push([...ids]); } },
    changed: () => {}, notice: (n) => notices.push(n),
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  world.start(bounds);
  return { world, notices, saved, socket: () => FakeSocket.instances.at(-1)! };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', { OPEN: 1 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('SharedWorld transport', () => {
  it('sends clipped visible bounds only on v4 and composes reordered chunks by seq', () => {
    const { world, socket, notices } = setup();
    const s = socket(); s.protocol = PRIORITY_PROTOCOL;
    world.setBounds(bounds, { min_x: -200, min_y: -10, max_x: 20, max_y: 200 });
    s.open(); s.receive({ type: 'hello.ack', protocol_version: 4 });
    expect(s.last('viewport.subscribe').visible_bounds).toEqual({ min_x: -100, min_y: -10, max_x: 20, max_y: 100 });
    const sid = s.last('viewport.subscribe').subscription_id;
    s.receive({ type: 'viewport.snapshot.begin', subscription_id: sid });
    s.receive({ type: 'viewport.snapshot.chunk', subscription_id: sid, strokes: [wire(B, 2, false)] });
    s.receive({ type: 'viewport.snapshot.chunk', subscription_id: sid, strokes: [wire(A, 1, false)] });
    s.receive({ type: 'viewport.snapshot.end', subscription_id: sid });
    expect(world.scene.strokes().map((s) => s.id)).toEqual([A, B]);
    const cached = world.scene.get(B);
    world.setBounds(bounds); vi.advanceTimersByTime(300);
    const next = s.last('viewport.subscribe.cached').subscription_id;
    expect(s.last('viewport.subscribe.cached').visible_bounds).toEqual(bounds);
    const token = '00000000-0000-4000-8000-000000000001';
    s.receive({ type: 'viewport.snapshot.begin', subscription_id: next });
    s.receive({ type: 'viewport.manifest.begin', subscription_id: next, snapshot_token: token, stroke_count: 3, point_count: 6 });
    s.receive({ type: 'viewport.manifest.chunk', subscription_id: next, snapshot_token: token, stroke_ids: [C, B, A] });
    s.receive({ type: 'viewport.manifest.end', subscription_id: next, snapshot_token: token });
    expect(s.last('viewport.fetch').stroke_ids).toEqual([C]);
    s.receive({ type: 'viewport.snapshot.chunk', subscription_id: next, strokes: [wire(C, 3, false)] });
    s.receive({ type: 'viewport.snapshot.end', subscription_id: next });
    expect(world.scene.get(B)).toBe(cached);
    expect(world.scene.strokes().map((s) => s.id)).toEqual([A, B, C]);
    expect(notices).toEqual([]);
    world.stop();
  });

  it('keeps cold/reconnect loads full and reuses geometry only on a live v3 connection', () => {
    const { world, socket, notices } = setup();
    const s = socket(); s.protocol = MANIFEST_PROTOCOL; s.open();
    s.receive({ type: 'hello.ack', protocol_version: 3 });
    const first = s.last('viewport.subscribe').subscription_id;
    s.receive({ type: 'viewport.snapshot.begin', subscription_id: first });
    s.receive({ type: 'viewport.snapshot.chunk', subscription_id: first, strokes: [wire(A, 1, false)] });
    s.receive({ type: 'viewport.snapshot.end', subscription_id: first });
    const cached = world.scene.get(A);
    world.setBounds(bounds); vi.advanceTimersByTime(300);
    const next = s.last('viewport.subscribe.cached').subscription_id;
    const token = '00000000-0000-4000-8000-000000000001';
    s.receive({ type: 'viewport.snapshot.begin', subscription_id: next });
    s.receive({ type: 'viewport.manifest.begin', subscription_id: next, snapshot_token: token, stroke_count: 1, point_count: 2 });
    s.receive({ type: 'viewport.manifest.chunk', subscription_id: next, snapshot_token: token, stroke_ids: [A] });
    s.receive({ type: 'viewport.manifest.end', subscription_id: next, snapshot_token: token });
    expect(s.last('viewport.fetch').stroke_ids).toEqual([]);
    s.receive({ type: 'viewport.snapshot.end', subscription_id: next });
    expect(world.scene.get(A)).toBe(cached);
    expect(world.scene.phase).toBe('ready');
    expect(notices).toEqual([]);
    s.close(); vi.advanceTimersByTime(1000);
    const reconnected = socket(); reconnected.protocol = MANIFEST_PROTOCOL; reconnected.open();
    reconnected.receive({ type: 'hello.ack', protocol_version: 3 });
    expect(reconnected.of('viewport.subscribe')).toHaveLength(1);
    expect(reconnected.of('viewport.subscribe.cached')).toHaveLength(0);
  });

  it('falls back from a busy manifest to full and ignores late frames from the invalidated subscription', () => {
    const { world, socket } = setup(); const s = socket(); s.protocol = MANIFEST_PROTOCOL; s.open();
    s.receive({ type: 'hello.ack', protocol_version: 3 });
    const first = s.last('viewport.subscribe').subscription_id;
    s.receive({ type: 'viewport.snapshot.begin', subscription_id: first });
    s.receive({ type: 'viewport.snapshot.end', subscription_id: first });
    world.setBounds(bounds); vi.advanceTimersByTime(300);
    const next = s.last('viewport.subscribe.cached').subscription_id;
    s.receive({ type: 'viewport.snapshot.fallback', subscription_id: next, reason: 'busy' });
    s.receive({ type: 'viewport.snapshot.chunk', subscription_id: next, strokes: [wire(A, 1, false)] });
    expect(s.readyState).toBe(1);
    vi.advanceTimersByTime(1100);
    expect(s.of('viewport.subscribe')).toHaveLength(2);
  });

  it('uses binary hello, snapshots, create/undo and reconnect in the negotiated v2 profile', () => {
    const { world, socket, notices } = setup();
    const s = socket(); s.protocol = MSGPACK_PROTOCOL;
    s.open();
    expect(s.binaryType).toBe('arraybuffer');
    expect(s.last('hello')).toEqual({ type: 'hello', session_secret: 'A'.repeat(43) });
    s.receive({ type: 'hello.ack', protocol_version: 2 });
    const sub = s.last('viewport.subscribe').subscription_id;
    s.receive({ type: 'viewport.snapshot.begin', subscription_id: sub });
    s.receive({ type: 'viewport.snapshot.chunk', subscription_id: sub, strokes: [wire(B, 2, false)] });
    s.receive({ type: 'viewport.snapshot.end', subscription_id: sub });
    expect(world.scene.strokes()).toHaveLength(1);
    world.create(draft(A));
    s.receive({ type: 'ack', request_id: s.last('stroke.create').request_id,
      operation: 'stroke.create', stroke: wire(A, 3, true) });
    world.undo();
    expect(s.last('stroke.delete').stroke_id).toBe(A);
    s.receive({ type: 'ack', request_id: s.last('stroke.delete').request_id,
      operation: 'stroke.delete', stroke_id: A, seq: 3, already_deleted: false });
    expect(world.scene.strokes().map((stroke) => stroke.id)).toEqual([B]);
    expect(notices).toEqual([]);
    s.close(); vi.advanceTimersByTime(1000);
    const next = socket(); next.protocol = MSGPACK_PROTOCOL; next.open();
    expect(next.last('hello').session_secret).toBe('A'.repeat(43));
    next.receive({ type: 'hello.ack', protocol_version: 1 });
    expect(next.readyState).toBe(3);
  });

  it('rejects an absent negotiated profile without sending the secret', () => {
    const { socket } = setup();
    const s = socket(); s.protocol = ''; s.open();
    expect(s.sent).toEqual([]); expect(s.readyState).toBe(3);
  });

  it('sends hello with the secret only, then subscribes; seq/own come from the server', () => {
    const { world, socket } = setup();
    const s = socket();
    s.open();
    expect(s.sent).toEqual([{ type: 'hello', session_secret: 'A'.repeat(43) }]);
    s.receive({ type: 'hello.ack', protocol_version: 1 });
    expect(s.last('viewport.subscribe')).toMatchObject({ bounds });
    const sub = s.last('viewport.subscribe').subscription_id;
    s.receive({ type: 'viewport.snapshot.begin', subscription_id: sub });
    s.receive({ type: 'viewport.snapshot.chunk', subscription_id: sub, strokes: [wire(B, 7, false), wire(A, 3, true)] });
    // Drawn as soon as the chunk arrives; replacement of the cache waits for end.
    expect(world.scene.strokes().map((x) => x.seq)).toEqual([3, 7]);
    expect(world.scene.confirmed.size).toBe(0);
    s.receive({ type: 'viewport.snapshot.end', subscription_id: sub });
    expect(world.scene.strokes().map((x) => x.seq)).toEqual([3, 7]);
    // A late message of an older subscription is ignored.
    s.receive({ type: 'stroke.deleted', subscription_id: 'old', stroke_id: A, seq: 3 });
    expect(world.scene.confirmed.has(A)).toBe(true);
  });

  it('create → pending → ack: confirmed with seq, one undo entry, own event deduplicated', () => {
    const { world, socket, saved } = setup();
    const s = socket(); const sub = s.ready();
    world.create(draft(A));
    expect(world.scene.visiblePending().map((d) => d.id)).toEqual([A]);
    const create = s.last('stroke.create');
    expect(create.stroke).toEqual({ id: A, points: [[0, 0], [10, 5]], brush: 'spray', width: 6, color: '#202020', opacity: 1 });
    s.receive({ type: 'stroke.created', subscription_id: sub, stroke: wire(A, 11, true) });
    s.receive({ type: 'ack', request_id: create.request_id, operation: 'stroke.create', stroke: wire(A, 11, true) });
    expect(world.scene.visiblePending()).toEqual([]);
    expect(world.scene.strokes()).toHaveLength(1);
    expect(saved.at(-1)).toEqual([A]);
  });

  it('retries an unacknowledged create after reconnect with the same UUID and payload', () => {
    const { world, socket } = setup();
    const first = socket(); first.ready();
    world.create(draft(A));
    const original = first.last('stroke.create');
    first.close();
    vi.advanceTimersByTime(1000);
    const second = socket();
    expect(second).not.toBe(first);
    second.ready();
    const retry = second.last('stroke.create');
    expect(retry.stroke).toEqual(original.stroke);
    expect(retry.request_id).not.toBe(original.request_id);
    expect(second.of('hello')).toHaveLength(1);
  });

  it('closes and retries when an ack does not arrive in time', () => {
    const { world, socket } = setup();
    const first = socket(); first.ready();
    world.create(draft(A));
    vi.advanceTimersByTime(12_100);
    expect(first.readyState).toBe(3);
    vi.advanceTimersByTime(1000);
    socket().ready();
    expect(socket().last('stroke.create').stroke).toMatchObject({ id: A });
  });

  it('keeps creates under the server rate limit by queueing, not dropping', () => {
    const { world, socket } = setup();
    const s = socket(); s.ready();
    for (let i = 0; i < 7; i++) world.create(draft(`00000000-0000-4000-8000-00000000010${i}`));
    expect(s.of('stroke.create')).toHaveLength(5);
    vi.advanceTimersByTime(1200);
    expect(s.of('stroke.create')).toHaveLength(7);
  });

  it('rate_limited errors retry the identical create later', () => {
    const { world, socket, notices } = setup();
    const s = socket(); s.ready();
    world.create(draft(A));
    s.receive({ type: 'error', request_id: s.last('stroke.create').request_id, code: 'rate_limited', message: 'x' });
    expect(world.scene.visiblePending()).toHaveLength(1);
    vi.advanceTimersByTime(1300);
    expect(s.of('stroke.create')).toHaveLength(2);
    expect(notices).toEqual([]);
  });

  it('undo of a never-sent pending drops it locally; of a sent one deletes after the ack', () => {
    const { world, socket } = setup();
    world.create(draft(A)); // offline: not sent
    expect(world.undo()).toBe(true);
    expect(world.scene.pending.size).toBe(0);
    const s = socket(); s.ready();
    expect(s.of('stroke.create')).toHaveLength(0);
    world.create(draft(B));
    const create = s.last('stroke.create');
    world.undo();
    expect(world.scene.visiblePending()).toEqual([]); // hidden at once
    s.receive({ type: 'ack', request_id: create.request_id, operation: 'stroke.create', stroke: wire(B, 2, true) });
    const del = s.last('stroke.delete');
    expect(del.stroke_id).toBe(B);
    expect(world.scene.hidden.has(B)).toBe(true);
    s.receive({ type: 'ack', request_id: del.request_id, operation: 'stroke.delete', stroke_id: B, seq: 2, already_deleted: false });
    expect(world.scene.confirmed.has(B)).toBe(false);
  });

  it('undo uses the session stack even for strokes outside the current snapshot', () => {
    const { world, socket, saved } = setup([A, B]);
    const s = socket(); s.ready();
    expect(world.undo()).toBe(true);
    const del = s.last('stroke.delete');
    expect(del.stroke_id).toBe(B);
    s.receive({ type: 'error', request_id: del.request_id, code: 'not_found', message: 'x' });
    expect(saved.at(-1)).toEqual([A]);
    world.undo();
    expect(s.last('stroke.delete').stroke_id).toBe(A);
  });

  it('eraser only targets own strokes and restores on forbidden', () => {
    const { world, socket, notices } = setup();
    const s = socket(); const sub = s.ready();
    s.receive({ type: 'stroke.created', subscription_id: sub, stroke: wire(C, 5, false) });
    world.erase(C);
    expect(s.of('stroke.delete')).toHaveLength(0);
    s.receive({ type: 'stroke.created', subscription_id: sub, stroke: wire(A, 6, true) });
    world.erase(A);
    expect(world.scene.hidden.has(A)).toBe(true);
    s.receive({ type: 'error', request_id: s.last('stroke.delete').request_id, code: 'forbidden', message: 'x' });
    expect(world.scene.hidden.has(A)).toBe(false);
    expect(notices).toContain('deleteFailed');
  });

  it('id_conflict drops the pending stroke with a brief notice', () => {
    const { world, socket, notices } = setup();
    const s = socket(); s.ready();
    world.create(draft(A));
    s.receive({ type: 'error', request_id: s.last('stroke.create').request_id, code: 'id_conflict', message: 'x' });
    expect(world.scene.pending.size).toBe(0);
    expect(notices).toEqual(['rejected']);
  });

  it('applies the optional entry hint before the first subscription; rejects a malformed one', () => {
    FakeSocket.instances.length = 0;
    const hints: unknown[] = [];
    let area = bounds;
    const world = new SharedWorld({
      secret: 'A'.repeat(43), url: 'ws://test/ws',
      undo: { load: () => [], save: () => {} }, changed: () => {}, notice: () => {},
      welcome: (spawn) => { hints.push(spawn); area = { min_x: 4900, min_y: 6900, max_x: 5100, max_y: 7100 }; world.setBounds(area); },
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    world.start(bounds);
    const s = FakeSocket.instances.at(-1)!;
    s.open();
    s.receive({ type: 'hello.ack', protocol_version: 1, spawn: { x: 5000, y: 7000 } });
    expect(hints).toEqual([[5000, 7000]]);
    expect(s.of('viewport.subscribe')).toHaveLength(1);
    expect(s.last('viewport.subscribe')).toMatchObject({ bounds: area });
    // Old servers and empty worlds: no field, no hint.
    const { world: plain, socket } = setup();
    void plain;
    const other = socket();
    other.open();
    other.receive({ type: 'hello.ack', protocol_version: 1, spawn: { x: 'far', y: 0 } });
    expect(other.readyState).toBe(3);
  });

  it('resync_required discards staging and subscribes again with a new id', () => {
    const { socket } = setup();
    const s = socket(); const sub = s.ready();
    s.receive({ type: 'error', subscription_id: sub, code: 'resync_required', message: 'x' });
    vi.advanceTimersByTime(1100);
    const next = s.last('viewport.subscribe').subscription_id;
    expect(next).not.toBe(sub);
  });

  it('invalid server data closes the socket and reconnects with a fresh hello', () => {
    const { socket, notices } = setup();
    const s = socket(); const sub = s.ready();
    s.receive({ type: 'stroke.created', subscription_id: sub, stroke: { id: 'nope' } });
    expect(s.readyState).toBe(3);
    expect(notices).toContain('protocol');
    vi.advanceTimersByTime(1000);
    expect(socket()).not.toBe(s);
  });

  it('reports a lasting outage only when there is unsent work', () => {
    const { world, notices } = setup();
    vi.advanceTimersByTime(5000);
    expect(notices).toEqual([]);
    world.create(draft(A));
    vi.advanceTimersByTime(4100);
    expect(notices).toEqual(['offline']);
  });
});

describe('SharedScene', () => {
  it('replaces the cache only on snapshot end and keeps drawing the old one meanwhile', () => {
    const scene = new SharedScene();
    scene.subscribe('s1');
    scene.accept({ type: 'viewport.snapshot.begin', subscription_id: 's1' });
    scene.accept({ type: 'viewport.snapshot.chunk', subscription_id: 's1', strokes: [wire(A, 1, false)] });
    scene.accept({ type: 'viewport.snapshot.end', subscription_id: 's1' });
    scene.subscribe('s2');
    scene.accept({ type: 'viewport.snapshot.begin', subscription_id: 's2' });
    expect(scene.strokes().map((s) => s.id)).toEqual([A]);
    scene.accept({ type: 'viewport.snapshot.chunk', subscription_id: 's2', strokes: [wire(B, 2, false)] });
    scene.accept({ type: 'viewport.snapshot.end', subscription_id: 's2' });
    expect(scene.strokes().map((s) => s.id)).toEqual([B]);
  });

  it('reports every change of the drawn set exactly once, including snapshot replacement', () => {
    const scene = new SharedScene();
    const log: string[] = [];
    scene.listener = { added: (s) => log.push(`+${s.id.at(-1)}`), removed: (s) => log.push(`-${s.id.at(-1)}`) };
    scene.subscribe('s1');
    scene.accept({ type: 'viewport.snapshot.begin', subscription_id: 's1' });
    scene.accept({ type: 'viewport.snapshot.chunk', subscription_id: 's1', strokes: [wire(A, 1, true), wire(B, 2, false)] });
    scene.accept({ type: 'viewport.snapshot.end', subscription_id: 's1' });
    expect(log.splice(0)).toEqual(['+a', '+b']);
    // Pan: the new snapshot re-sends A, adds C and no longer contains B.
    scene.subscribe('s2');
    scene.accept({ type: 'viewport.snapshot.begin', subscription_id: 's2' });
    scene.accept({ type: 'viewport.snapshot.chunk', subscription_id: 's2', strokes: [wire(A, 1, true), wire(C, 3, false)] });
    expect(log.splice(0)).toEqual(['+c']); // visible before end
    scene.accept({ type: 'viewport.snapshot.end', subscription_id: 's2' });
    expect(log.splice(0)).toEqual(['-b']);
    scene.hide(A); scene.unhide(A); scene.hide(A); scene.remove(A);
    expect(log.splice(0)).toEqual(['-a', '+a', '-a']);
    scene.accept({ type: 'stroke.deleted', subscription_id: 's2', stroke_id: C, seq: 3 });
    expect(log.splice(0)).toEqual(['-c']);
  });

  it('a cancelled snapshot keeps the strokes it already delivered until the next one ends', () => {
    const scene = new SharedScene();
    const log: string[] = [];
    scene.listener = { added: (s) => log.push(`+${s.id.at(-1)}`), removed: (s) => log.push(`-${s.id.at(-1)}`) };
    scene.subscribe('s1');
    scene.accept({ type: 'viewport.snapshot.begin', subscription_id: 's1' });
    scene.accept({ type: 'viewport.snapshot.chunk', subscription_id: 's1', strokes: [wire(A, 1, false)] });
    scene.subscribe('s2'); // the user kept panning
    expect(scene.strokes().map((s) => s.id)).toEqual([A]);
    scene.accept({ type: 'viewport.snapshot.begin', subscription_id: 's2' });
    scene.accept({ type: 'viewport.snapshot.chunk', subscription_id: 's2', strokes: [wire(A, 1, false)] });
    scene.accept({ type: 'viewport.snapshot.end', subscription_id: 's2' });
    expect(log).toEqual(['+a']); // no flicker
    expect(scene.confirmed.has(A)).toBe(true);
  });

  it('an own ack during staging survives the snapshot replacement', () => {
    const scene = new SharedScene();
    scene.subscribe('s1');
    scene.accept({ type: 'viewport.snapshot.begin', subscription_id: 's1' });
    scene.confirm({ ...wire(A, 9, true), points: [[0, 0]] });
    scene.accept({ type: 'viewport.snapshot.end', subscription_id: 's1' });
    expect(scene.confirmed.has(A)).toBe(true);
  });

  it('a deleted id does not come back from a stale chunk', () => {
    const scene = new SharedScene();
    scene.subscribe('s1');
    scene.accept({ type: 'viewport.snapshot.begin', subscription_id: 's1' });
    scene.remove(A);
    scene.accept({ type: 'viewport.snapshot.chunk', subscription_id: 's1', strokes: [wire(A, 1, true)] });
    scene.accept({ type: 'viewport.snapshot.end', subscription_id: 's1' });
    expect(scene.confirmed.has(A)).toBe(true); // snapshot is authoritative for the area...
    scene.accept({ type: 'stroke.deleted', subscription_id: 's1', stroke_id: A, seq: 1 });
    expect(scene.confirmed.has(A)).toBe(false); // ...and the buffered event follows it.
    scene.accept({ type: 'stroke.created', subscription_id: 's1', stroke: wire(A, 1, true) });
    expect(scene.confirmed.has(A)).toBe(false);
  });

  it('bounds pending strokes and rejects malformed snapshot order', () => {
    const scene = new SharedScene();
    for (let i = 0; i < MAX_PENDING; i++) expect(scene.addPending(draft(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`))).toBe(true);
    expect(scene.addPending(draft(A))).toBe(false);
    scene.subscribe('s1');
    expect(() => scene.accept({ type: 'viewport.snapshot.end', subscription_id: 's1' })).toThrow();
    expect(() => scene.accept({ type: 'viewport.snapshot.chunk', subscription_id: 's1', strokes: [] })).toThrow();
  });
});
