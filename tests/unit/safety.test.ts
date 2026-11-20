import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESET_COLORS, RECENT_COLORS, useRecentColor, type Stroke } from '../../src/model';
import { SharedScene } from '../../src/scene';
import { fingersDraw, HiddenContent, MAX_REPORT_STROKES, toggleTarget } from '../../src/safety';
import { COMPACT_PROTOCOL, SAFETY_PROTOCOL, socketCodec, WS_PROTOCOLS } from '../../src/transport/codec';
import { decodeMessagePack, encodeMessagePack, SERVER_MESSAGE_BYTES } from '../../src/transport/msgpack';
import { parseStroke } from '../../src/wire';
import { SharedWorld, type Notice } from '../../src/world';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const TAG_A = 'aaaaaaaaaaaaaaaaaaaaaa';
const TAG_B = 'bbbbbbbbbbbbbbbbbbbbbb';
const bounds = { min_x: -100, min_y: -100, max_x: 100, max_y: 100 };
const wire = (id: string, seq: number, own: boolean, author?: string) =>
  ({ id, seq, own, points: [[0, 0], [10, 5]], brush: 'round', width: 6, color: '#202020', opacity: 1, ...(author ? { author } : {}) });

describe('recent colors (same rules as the iPad app)', () => {
  it('keeps custom colors newest first, without presets, duplicates or more than seven', () => {
    let recent: string[] = [];
    recent = useRecentColor(recent, PRESET_COLORS[1]);
    expect(recent).toEqual([]);
    recent = useRecentColor(recent, '#12ab34');
    recent = useRecentColor(recent, '#FFFFFF');
    recent = useRecentColor(recent, '#12AB34');
    expect(recent).toEqual(['#12AB34', '#FFFFFF']);
    for (let i = 0; i < 10; i++) recent = useRecentColor(recent, `#0000${String(i).padStart(2, '0')}`);
    expect(recent).toHaveLength(RECENT_COLORS);
    expect(recent[0]).toBe('#000009');
    expect(useRecentColor(recent, 'red')).toEqual(recent);
  });
});

describe('local hiding and report selection', () => {
  it('hides reported strokes by id and every stroke of a blocked author', () => {
    const hidden = new HiddenContent().hide([A], [TAG_B]);
    expect(hidden.hides({ id: A, author: TAG_A })).toBe(true);
    expect(hidden.hides({ id: B, author: TAG_B })).toBe(true);
    expect(hidden.hides({ id: B, author: TAG_A })).toBe(false);
    expect(hidden.hides({ id: B, author: undefined })).toBe(false);
    expect(new HiddenContent().isEmpty).toBe(true);
    const many = new HiddenContent(Array.from({ length: 6000 }, (_, i) => `id-${i}`));
    expect(many.storedStrokes).toHaveLength(5000);
    expect(many.storedStrokes[0]).toBe('id-1000'); // the oldest are forgotten first
  });

  it('toggles targets and never selects more than the protocol allows', () => {
    let selection = toggleTarget([], { id: A, author: TAG_A });
    selection = toggleTarget(selection, { id: B, author: TAG_B });
    expect(selection.map((t) => t.id)).toEqual([A, B]);
    expect(toggleTarget(selection, { id: A, author: TAG_A }).map((t) => t.id)).toEqual([B]);
    let full: { id: string; author: string | undefined }[] = [];
    for (let i = 0; i < MAX_REPORT_STROKES + 5; i++) full = toggleTarget(full, { id: String(i), author: undefined });
    expect(full).toHaveLength(MAX_REPORT_STROKES);
  });

  it('fingers draw until a pen is seen, unless chosen explicitly', () => {
    expect(fingersDraw(undefined, false)).toBe(true);
    expect(fingersDraw(undefined, true)).toBe(false);
    expect(fingersDraw(true, true)).toBe(true);
    expect(fingersDraw(false, false)).toBe(false);
  });

  it('the scene filter tells the renderer exactly what left and re-entered the drawn set', () => {
    const scene = new SharedScene();
    const added: string[] = [], removed: string[] = [];
    scene.listener = { added: (s) => added.push(s.id), removed: (s) => removed.push(s.id) };
    scene.subscribe('sub');
    scene.accept({ type: 'viewport.snapshot.begin', subscription_id: 'sub' });
    scene.accept({ type: 'viewport.snapshot.chunk', subscription_id: 'sub', strokes: [wire(A, 1, false, TAG_A), wire(B, 2, false, TAG_B)] });
    scene.accept({ type: 'viewport.snapshot.end', subscription_id: 'sub' });
    added.length = 0;
    const hidden = new HiddenContent([], [TAG_B]);
    scene.setFilter((stroke) => hidden.hides(stroke));
    expect(removed).toEqual([B]);
    expect(scene.isHidden(scene.get(B)!)).toBe(true);
    expect(scene.isHidden(scene.get(A)!)).toBe(false);
    scene.setFilter(undefined);
    expect(added).toEqual([B]);
  });
});

describe('protocol v5', () => {
  it('is offered first and parses the per-viewer author tag', () => {
    expect(WS_PROTOCOLS.slice(0, 2)).toEqual([COMPACT_PROTOCOL, SAFETY_PROTOCOL]);
    expect(socketCodec(SAFETY_PROTOCOL).protocolVersion).toBe(5);
    expect((parseStroke(wire(A, 1, false, TAG_A)) as Stroke).author).toBe(TAG_A);
    expect('author' in parseStroke(wire(A, 1, false))).toBe(false);
    expect(() => parseStroke({ ...wire(A, 1, false), author: 'short' })).toThrow();
    expect(() => parseStroke({ ...wire(A, 1, false), author: 'a'.repeat(21) + '=' })).toThrow();
  });
});

class FakeSocket {
  static readonly instances: FakeSocket[] = [];
  readyState = 0;
  protocol = SAFETY_PROTOCOL;
  binaryType = 'blob';
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(data: Uint8Array) { this.sent.push(decodeMessagePack(data)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
  receive(message: unknown) { this.onmessage?.({ data: encodeMessagePack(message, SERVER_MESSAGE_BYTES).slice().buffer }); }
  of(type: string) { return this.sent.filter((m) => m.type === type); }
  ready(version = 5) {
    this.readyState = 1; this.onopen?.();
    this.receive({ type: 'hello.ack', protocol_version: version });
  }
}

function setup() {
  FakeSocket.instances.length = 0;
  const notices: Notice[] = [];
  const world = new SharedWorld({
    secret: 'A'.repeat(43), url: 'ws://test/ws', undo: { load: () => [], save: () => {} },
    changed: () => {}, notice: (n) => notices.push(n),
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  world.start(bounds);
  return { world, notices, socket: () => FakeSocket.instances.at(-1)! };
}

describe('SharedWorld reports', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('WebSocket', { OPEN: 1 }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('sends stroke.report on v5 with visible bounds and accepts the ack', () => {
    const { world, socket } = setup();
    const s = socket(); s.ready();
    expect(s.of('viewport.subscribe')[0]?.visible_bounds).toBeDefined();
    world.report([A, A, B], 'hate', true);
    const [sent] = s.of('stroke.report');
    expect(sent).toMatchObject({ stroke_ids: [A, B], reason: 'hate', block_author: true });
    s.receive({ type: 'ack', request_id: sent!.request_id, operation: 'stroke.report', report_id: B });
    world.report([A], 'spam', false);
    expect(s.of('stroke.report')).toHaveLength(2);
  });

  it('retries a rate-limited report and drops a refused one silently', () => {
    const { world, socket, notices } = setup();
    const s = socket(); s.ready();
    world.report([A], 'spam', false);
    s.receive({ type: 'error', request_id: s.of('stroke.report')[0]!.request_id, code: 'rate_limited', message: 'slow' });
    vi.advanceTimersByTime(1300);
    expect(s.of('stroke.report')).toHaveLength(2);
    s.receive({ type: 'error', request_id: s.of('stroke.report')[1]!.request_id, code: 'not_found', message: 'gone' });
    vi.advanceTimersByTime(5000);
    expect(s.of('stroke.report')).toHaveLength(2);
    expect(notices).toEqual([]);
  });

  it('never sends a report to a server that negotiated an older protocol', () => {
    const { world, socket } = setup();
    const s = socket(); s.protocol = 'endless-drawing.msgpack.v4'; s.ready(4);
    world.report([A], 'other', true);
    expect(s.of('stroke.report')).toEqual([]);
  });

  it('a banned author is told once and the stroke is not kept pending', () => {
    const { world, socket, notices } = setup();
    const s = socket(); s.ready();
    world.create({ id: A, points: [[0, 0], [1, 1]], brush: 'round', width: 6, color: '#202020', opacity: 1 });
    s.receive({ type: 'error', request_id: s.of('stroke.create')[0]!.request_id, code: 'banned', message: 'banned' });
    expect(notices).toEqual(['banned']);
    expect(world.scene.pending.size).toBe(0);
  });
});
