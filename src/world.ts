import { ManifestLoader } from './transport/manifest';
import { socketCodec, WS_PROTOCOLS, type WireCodec } from './transport/codec';
import { CodecError } from './transport/msgpack';
import { clipVisibleBounds, type Bounds } from './camera';
import { newId, type Point, type StrokeDraft } from './model';
import { SharedScene } from './scene';
import { parseSpawn, parseStroke, ProtocolError, uuid } from './wire';

export type Notice = 'offline' | 'rejected' | 'deleteFailed' | 'pendingLimit' | 'dense' | 'protocol';

export interface UndoStore {
  load(): string[];
  save(ids: readonly string[]): void;
}

export const MAX_UNDO = 500;
// Server sliding windows are 5 creates/s and 20 deletes/s per connection.
// Keep a small margin for clock skew between the two windows.
const LIMITS = { create: { count: 5, window: 1100 }, delete: { count: 20, window: 1100 } } as const;
const ACK_TIMEOUT = 12_000;

type Op = { kind: 'create'; id: string } | { kind: 'delete'; id: string; undo: boolean };
interface InFlight { op: Op; deadline: number }

export interface WorldOptions {
  secret: string;
  undo: UndoStore;
  changed: () => void;
  notice: (notice: Notice) => void;
  /**
   * After every hello.ack, before the first subscription of that connection:
   * the server's optional entry hint for a new session (undefined when the
   * world is empty or the server does not send one). Advisory only.
   */
  welcome?: (spawn: Point | undefined) => void;
  createSocket?: (url: string, protocols: string[]) => WebSocket;
  url?: string;
}

/** One WebSocket per tab; the server is the source of seq, own and bounds. */
export class SharedWorld {
  readonly scene = new SharedScene();
  private socket: WebSocket | undefined;
  private ready = false;
  private stopped = true;
  private retry = 0;
  private bounds: Bounds | undefined;
  private visible: Bounds | undefined;
  private subscribedBounds: Bounds | undefined;
  private subscribeSentAt = 0;
  private readonly queue: Op[] = [];
  private readonly inFlight = new Map<string, InFlight>();
  private readonly sent = { create: [] as number[], delete: [] as number[] };
  private undoStack: string[];
  private readonly timers: Record<'reconnect' | 'subscribe' | 'flush' | 'deadline' | 'offline' | 'ack', ReturnType<typeof setTimeout> | undefined> =
    { reconnect: undefined, subscribe: undefined, flush: undefined, deadline: undefined, offline: undefined, ack: undefined };
  private readonly createSocket: (url: string, protocols: string[]) => WebSocket;
  private codec: WireCodec | undefined;
  private reusable = false;
  private readonly manifest = new ManifestLoader({
    get: (id) => this.scene.get(id),
    retain: (strokes) => { this.scene.retain(strokes); this.options.changed(); },
    send: (message) => this.socket?.send(this.codec!.encode(message)),
  });

  constructor(private readonly options: WorldOptions) {
    this.undoStack = options.undo.load().slice(-MAX_UNDO);
    this.createSocket = options.createSocket ?? ((url, protocols) => new WebSocket(url, protocols));
  }

  get connected(): boolean { return this.ready; }
  get area(): Bounds | undefined { return this.subscribedBounds ?? this.bounds; }

  start(bounds: Bounds, visible: Bounds = bounds): void {
    this.bounds = bounds; this.visible = clipVisibleBounds(bounds, visible);
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.reusable = false; this.manifest.start('', false);
    for (const key of Object.keys(this.timers) as (keyof typeof this.timers)[]) {
      clearTimeout(this.timers[key]);
      this.timers[key] = undefined;
    }
    const socket = this.socket;
    this.socket = undefined; this.ready = false;
    socket?.close(1000);
  }

  /** Reconnect now (online/visibility); no-op while a socket is alive. */
  wake(): void {
    if (this.stopped || this.socket) return;
    clearTimeout(this.timers.reconnect);
    this.retry = 0;
    this.connect();
  }

  setBounds(bounds: Bounds, visible: Bounds = bounds): void {
    this.bounds = bounds; this.visible = clipVisibleBounds(bounds, visible);
    if (!this.ready) return;
    clearTimeout(this.timers.subscribe);
    // At most ~4 subscriptions/s; the server allows 5/s.
    const wait = Math.max(0, 260 - (Date.now() - this.subscribeSentAt));
    this.timers.subscribe = setTimeout(() => this.subscribe(), wait);
  }

  /** Queue a completed stroke. False when too many are still unconfirmed. */
  create(draft: StrokeDraft): boolean {
    if (!this.scene.addPending(draft)) { this.options.notice('pendingLimit'); return false; }
    this.enqueue({ kind: 'create', id: draft.id });
    this.watchOffline();
    return true;
  }

  /** Eraser on one of our own strokes (confirmed or pending). */
  erase(id: string): void {
    const pending = this.scene.pending.get(id);
    if (pending) { this.cancelPending(id); return; }
    const stroke = this.scene.get(id);
    if (!stroke?.own || this.scene.hidden.has(id)) return;
    this.scene.hide(id);
    this.enqueue({ kind: 'delete', id, undo: false });
    this.options.changed();
  }

  /** Ctrl/⌘+Z / palette undo: the newest unconfirmed create, else the newest confirmed one. */
  undo(): boolean {
    const pending = [...this.scene.pending.values()].reverse().find((item) => !item.cancelled);
    if (pending) { this.cancelPending(pending.draft.id); return true; }
    for (let index = this.undoStack.length - 1; index >= 0; index--) {
      const id = this.undoStack[index]!;
      if (this.deleting(id)) continue;
      this.scene.hide(id);
      this.enqueue({ kind: 'delete', id, undo: true });
      this.options.changed();
      return true;
    }
    return false;
  }

  private cancelPending(id: string): void {
    const item = this.scene.pending.get(id);
    if (!item) return;
    if (!item.sent && !this.isInFlight(id)) {
      // Never reached the server: forget it entirely.
      this.scene.dropPending(id);
      const index = this.queue.findIndex((op) => op.kind === 'create' && op.id === id);
      if (index !== -1) this.queue.splice(index, 1);
    } else {
      // A commit may exist. Finish the idempotent create, then delete it.
      item.cancelled = true;
      this.scene.revision++;
    }
    this.options.changed();
  }

  private deleting(id: string): boolean {
    return this.queue.some((op) => op.kind === 'delete' && op.id === id) ||
      [...this.inFlight.values()].some(({ op }) => op.kind === 'delete' && op.id === id);
  }
  private isInFlight(id: string): boolean {
    return [...this.inFlight.values()].some(({ op }) => op.id === id);
  }

  private enqueue(op: Op): void {
    this.queue.push(op);
    this.flush();
  }

  private connect(): void {
    if (this.stopped) return;
    clearTimeout(this.timers.reconnect);
    this.ready = false;
    this.codec = undefined; this.reusable = false; this.manifest.start('', false);
    this.scene.reconnected();
    const url = new URL(this.options.url ?? '/ws', globalThis.location?.href ?? 'http://localhost/');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try { socket = this.createSocket(url.href, WS_PROTOCOLS); } catch { this.reconnect(); return; }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.armDeadline(8000);
    socket.onopen = () => {
      // The secret is sent only here, never in URLs or logs.
      if (this.socket !== socket) return;
      try {
        this.codec = socketCodec(socket.protocol);
        socket.send(this.codec.encode({ type: 'hello', session_secret: this.options.secret }));
      } catch (error) {
        this.options.notice('protocol');
        socket.close(error instanceof CodecError ? error.closeCode + 3000 : 4007);
      }
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.stopped) return;
      try {
        if (!this.codec) throw new ProtocolError();
        this.receive(this.codec.decode(event.data));
      } catch (error) {
        this.options.notice('protocol');
        // Browser WebSocket.close only permits 1000 or application codes 3000..4999.
        socket.close(error instanceof CodecError ? error.closeCode + 3000 : 4002);
      }
    };
    socket.onerror = () => { if (this.socket === socket) socket.close(); };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined; this.ready = false;
      clearTimeout(this.timers.deadline); clearTimeout(this.timers.subscribe); clearTimeout(this.timers.flush);
      // Unacknowledged operations go back to the front of the queue, same UUIDs/payloads.
      const lost = [...this.inFlight.values()].map(({ op }) => op);
      this.inFlight.clear();
      this.queue.unshift(...lost.filter((op) => !this.queue.some((q) => q.kind === op.kind && q.id === op.id)));
      this.subscribedBounds = undefined;
      this.watchOffline();
      this.reconnect();
    };
  }

  private reconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(this.retry++, 5));
    this.timers.reconnect = setTimeout(() => this.connect(), delay + Math.random() * 250);
  }

  private receive(message: Record<string, unknown>): void {
    if (!this.ready) {
      if (message.type !== 'hello.ack' || message.protocol_version !== this.codec?.protocolVersion) throw new ProtocolError();
      const spawn = message.spawn === undefined ? undefined : parseSpawn(message.spawn);
      this.ready = true;
      this.retry = 0;
      clearTimeout(this.timers.deadline);
      // May move the camera and call setBounds: the subscription below uses it.
      this.options.welcome?.(spawn);
      this.subscribe();
      this.flush();
      return;
    }
    if (message.type === 'ack') { this.acked(message); return; }
    if (message.type === 'error' && message.request_id !== undefined) { this.failed(message); return; }
    if (message.type === 'error' && message.subscription_id === undefined) throw new ProtocolError();
    if (message.subscription_id === this.scene.subscriptionId && message.type === 'viewport.snapshot.fallback') {
      if ((this.codec?.protocolVersion ?? 1) < 3 || !['busy', 'scene_limit'].includes(String(message.reason))) throw new ProtocolError();
      if (message.reason === 'scene_limit') this.options.notice('dense');
      this.reusable = false; this.manifest.start('', false); this.scene.subscribe('');
      clearTimeout(this.timers.subscribe);
      this.timers.subscribe = setTimeout(() => this.subscribe(), 1000);
      return;
    }
    if (this.manifest.accept(message)) return;
    const result = this.scene.accept(message);
    if (message.type === 'viewport.snapshot.end' && message.subscription_id === this.scene.subscriptionId && this.scene.phase === 'ready') {
      this.reusable = !this.scene.truncated;
    }
    if (result === 'resync') {
      this.reusable = false; this.manifest.start('', false); this.scene.subscribe('');
      clearTimeout(this.timers.subscribe);
      this.timers.subscribe = setTimeout(() => this.subscribe(), 1000);
    } else if (result === 'changed') {
      if (this.scene.phase === 'ready') clearTimeout(this.timers.deadline);
      if (this.scene.truncated) this.options.notice('dense');
      this.options.changed();
    }
  }

  private acked(message: Record<string, unknown>): void {
    const requestId = typeof message.request_id === 'string' ? message.request_id : '';
    const flight = this.inFlight.get(requestId);
    if (!flight) return; // A late ack from an operation we already re-sent.
    this.inFlight.delete(requestId);
    if (flight.op.kind === 'create' && message.operation === 'stroke.create') {
      const stroke = parseStroke(message.stroke);
      if (stroke.id !== flight.op.id || !stroke.own) throw new ProtocolError();
      const cancelled = this.scene.pending.get(stroke.id)?.cancelled ?? false;
      // Hidden before it is confirmed: a cancelled stroke never flashes on screen.
      if (cancelled) this.scene.hide(stroke.id);
      this.scene.confirm(stroke);
      this.pushUndo(stroke.id);
      if (cancelled) this.queue.push({ kind: 'delete', id: stroke.id, undo: true });
    } else if (flight.op.kind === 'delete' && message.operation === 'stroke.delete') {
      if (uuid(message.stroke_id) !== flight.op.id) throw new ProtocolError();
      this.scene.remove(flight.op.id);
      this.dropUndo(flight.op.id);
    } else throw new ProtocolError();
    this.options.changed();
    this.flush();
  }

  private failed(message: Record<string, unknown>): void {
    const requestId = typeof message.request_id === 'string' ? message.request_id : '';
    const flight = this.inFlight.get(requestId);
    if (!flight) return;
    this.inFlight.delete(requestId);
    const code = message.code;
    const { op } = flight;
    if (code === 'rate_limited' || code === 'internal_error') {
      // Same UUID and payload, a bit later.
      this.queue.unshift(op);
      clearTimeout(this.timers.flush);
      this.timers.flush = setTimeout(() => this.flush(), 1200);
      return;
    }
    if (op.kind === 'create') {
      // stroke_deleted: it was committed and deleted elsewhere (e.g. moderation).
      if (code !== 'stroke_deleted') this.options.notice('rejected');
      this.scene.dropPending(op.id);
    } else if (code === 'not_found') {
      this.scene.remove(op.id);
      this.dropUndo(op.id);
    } else {
      this.scene.unhide(op.id);
      if (code === 'forbidden') this.dropUndo(op.id);
      this.options.notice('deleteFailed');
    }
    this.options.changed();
    this.flush();
  }

  private flush(): void {
    clearTimeout(this.timers.flush);
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    let wait = 0;
    for (let index = 0; index < this.queue.length;) {
      const op = this.queue[index]!;
      const window = this.sent[op.kind];
      const limit = LIMITS[op.kind];
      while (window.length && now - window[0]! >= limit.window) window.shift();
      if (window.length >= limit.count) { wait = Math.max(wait, limit.window - (now - window[0]!)); index++; continue; }
      if (this.isInFlight(op.id)) { index++; continue; }
      this.queue.splice(index, 1);
      const request_id = newId();
      let payload: unknown;
      if (op.kind === 'create') {
        const item = this.scene.pending.get(op.id);
        if (!item) continue;
        item.sent = true;
        const { id, points, brush, width, color, opacity } = item.draft;
        payload = { type: 'stroke.create', request_id, stroke: { id, points, brush, width, color, opacity } };
      } else {
        payload = { type: 'stroke.delete', request_id, stroke_id: op.id };
      }
      window.push(now);
      this.inFlight.set(request_id, { op, deadline: now + ACK_TIMEOUT });
      socket.send(this.codec!.encode(payload));
    }
    if (wait > 0) this.timers.flush = setTimeout(() => this.flush(), wait + 5);
    this.armAckDeadline();
  }

  private subscribe(): void {
    const socket = this.socket;
    if (!this.ready || !this.bounds || socket?.readyState !== WebSocket.OPEN) return;
    clearTimeout(this.timers.subscribe);
    const subscription_id = newId();
    const cached = (this.codec?.protocolVersion ?? 1) >= 3 && this.reusable;
    this.manifest.start(subscription_id, cached);
    this.scene.subscribe(subscription_id, (this.codec?.protocolVersion ?? 1) >= 3, this.bounds);
    this.subscribeSentAt = Date.now();
    this.subscribedBounds = this.bounds;
    socket.send(this.codec!.encode({ type: cached ? 'viewport.subscribe.cached' : 'viewport.subscribe', subscription_id, bounds: this.bounds,
      ...(this.codec?.protocolVersion === 4 ? { visible_bounds: this.visible } : {}) }));
    this.armDeadline(35_000);
  }

  private armDeadline(ms: number): void {
    clearTimeout(this.timers.deadline);
    const socket = this.socket;
    this.timers.deadline = setTimeout(() => { if (this.socket === socket) socket?.close(4000); }, ms);
  }

  private armAckDeadline(): void {
    clearTimeout(this.timers.ack);
    if (!this.inFlight.size) return;
    const next = Math.min(...[...this.inFlight.values()].map((f) => f.deadline));
    const socket = this.socket;
    // No ack in time: the result is unknown. Reconnect and retry the same UUID.
    this.timers.ack = setTimeout(() => {
      if (this.socket === socket && [...this.inFlight.values()].some((f) => f.deadline <= Date.now())) socket?.close(4001);
      else this.armAckDeadline();
    }, Math.max(0, next - Date.now()) + 10);
  }

  private watchOffline(): void {
    // Only a real, lasting problem with unsent work is worth a brief message.
    // Reconnect attempts must not keep postponing an already armed check.
    if (this.timers.offline !== undefined) return;
    this.timers.offline = setTimeout(() => {
      this.timers.offline = undefined;
      if (!this.ready && this.scene.visiblePending().length > 0) this.options.notice('offline');
    }, 4000);
  }

  private pushUndo(id: string): void {
    if (this.undoStack.includes(id)) return;
    this.undoStack.push(id);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.splice(0, this.undoStack.length - MAX_UNDO);
    this.options.undo.save(this.undoStack);
  }
  private dropUndo(id: string): void {
    const index = this.undoStack.indexOf(id);
    if (index === -1) return;
    this.undoStack.splice(index, 1);
    this.options.undo.save(this.undoStack);
  }
}
