import { ManifestLoader } from '../transport/manifest';
import { socketCodec, WS_PROTOCOLS, type WireCodec } from '../transport/codec';
import { clipVisibleBounds, type Bounds } from '../camera';
import { ProtocolError } from './contracts';
import { AdminScene, SceneLimitError } from './scene';
import { toBase64url } from './webauthn';

export type WorldStatus = 'connecting' | 'loading' | 'ready' | 'disconnected' | 'scene_limit' | 'protocol_error';

export class ReadOnlyWorld {
  readonly scene = new AdminScene();
  private socket: WebSocket | undefined;
  private stopped = true;
  private ready = false;
  private codec: WireCodec | undefined;
  private reusable = false;
  private readonly manifest = new ManifestLoader({
    get: (id) => this.scene.get(id),
    retain: (strokes) => { this.scene.retain(strokes); this.changed('loading'); },
    send: (message) => this.socket?.send(this.codec!.encode(message)),
  });
  private retry = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private subscribeTimer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private bounds: Bounds | undefined;
  private visible: Bounds | undefined;
  private sentAt = 0;
  private readonly secret = toBase64url(crypto.getRandomValues(new Uint8Array(32)));

  constructor(private readonly changed: (status: WorldStatus) => void,
    private readonly createSocket = (url: string, protocols: string[]) => new WebSocket(url, protocols)) {}

  start(bounds: Bounds, visible: Bounds = bounds): void {
    this.bounds = bounds; this.visible = clipVisibleBounds(bounds, visible);
    this.stopped = false;
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    this.reusable = false; this.manifest.start('', false);
    clearTimeout(this.reconnectTimer); clearTimeout(this.subscribeTimer); clearTimeout(this.deadline);
    const socket = this.socket;
    this.socket = undefined; this.ready = false;
    socket?.close(1000);
    this.scene.clear();
  }
  /** Currently subscribed area (for needsResubscribe), undefined before the first subscription. */
  get area(): Bounds | undefined { return this.bounds; }
  refresh(): void {
    if (!this.stopped) this.subscribe();
  }
  setBounds(bounds: Bounds, visible: Bounds = bounds): void {
    this.visible = clipVisibleBounds(bounds, visible);
    if (this.bounds && this.bounds.min_x === bounds.min_x && this.bounds.min_y === bounds.min_y &&
        this.bounds.max_x === bounds.max_x && this.bounds.max_y === bounds.max_y) return;
    this.bounds = bounds;
    if (this.ready && !this.stopped) {
      clearTimeout(this.subscribeTimer);
      this.subscribeTimer = setTimeout(() => this.subscribe(), Math.max(120, 260 - (Date.now() - this.sentAt)));
    }
  }
  private connect(): void {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.scene.clear(); this.ready = false; this.codec = undefined; this.reusable = false; this.manifest.start('', false); this.changed('connecting');
    const url = new URL('/ws', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try { socket = this.createSocket(url.href, WS_PROTOCOLS); }
    catch { this.reconnect(); return; }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.armDeadline(8000);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      try {
        this.codec = socketCodec(socket.protocol, 1_048_576);
        socket.send(this.codec.encode({ type: 'hello', session_secret: this.secret }));
      } catch { this.stop(); this.changed('protocol_error'); }
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.stopped) return;
      try {
        if (!this.codec) throw new ProtocolError();
        const message = this.codec.decode(event.data);
        if (!this.ready) {
          if (message.type !== 'hello.ack' || message.protocol_version !== this.codec.protocolVersion) throw new ProtocolError();
          this.ready = true;
          this.subscribe();
          return;
        }
        if (message.type === 'error' && message.subscription_id === undefined) throw new ProtocolError();
        if (message.subscription_id === this.scene.subscriptionId && message.type === 'viewport.snapshot.fallback') {
          if (this.codec.protocolVersion < 3 || !['busy', 'scene_limit'].includes(String(message.reason))) throw new ProtocolError();
          if (message.reason === 'scene_limit') throw new SceneLimitError();
          this.reusable = false; this.manifest.start('', false); this.scene.subscribe('', true);
          clearTimeout(this.subscribeTimer); this.subscribeTimer = setTimeout(() => this.subscribe(), 1000);
          return;
        }
        if (this.manifest.accept(message)) return;
        const action = this.scene.accept(message);
        if (message.type === 'viewport.snapshot.end' && message.subscription_id === this.scene.subscriptionId && this.scene.phase === 'ready') this.reusable = true;
        if (action === 'resync') {
          // Fresh subscription, not a seq-based replay. Rate-limit resync loops.
          this.reusable = false; this.manifest.start('', false); this.scene.subscribe(''); this.changed('loading');
          clearTimeout(this.subscribeTimer);
          this.subscribeTimer = setTimeout(() => this.subscribe(), 1000);
        } else if (action === 'changed') {
          if (this.scene.phase === 'ready') { clearTimeout(this.deadline); this.retry = 0; }
          this.changed(this.scene.phase);
        }
      } catch (error) {
        this.stop();
        this.changed(error instanceof SceneLimitError ? 'scene_limit' : 'protocol_error');
      }
    };
    socket.onerror = () => { if (this.socket === socket) socket.close(); };
    socket.onclose = () => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = undefined; this.ready = false;
      clearTimeout(this.deadline); clearTimeout(this.subscribeTimer);
      this.scene.clear(); this.changed('disconnected'); this.reconnect();
    };
  }
  private reconnect(): void {
    if (this.stopped) return;
    this.changed('disconnected');
    this.reconnectTimer = setTimeout(() => this.connect(), Math.min(10_000, 500 * 2 ** Math.min(this.retry++, 5)));
  }
  private subscribe(): void {
    if (this.stopped || !this.ready || !this.bounds || this.socket?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.sentAt < 260) {
      clearTimeout(this.subscribeTimer);
      this.subscribeTimer = setTimeout(() => this.subscribe(), 260 - (Date.now() - this.sentAt));
      return;
    }
    clearTimeout(this.subscribeTimer);
    const subscription_id = crypto.randomUUID();
    const cached = (this.codec?.protocolVersion ?? 1) >= 3 && this.reusable;
    this.manifest.start(subscription_id, cached);
    this.scene.subscribe(subscription_id, (this.codec?.protocolVersion ?? 1) >= 3); this.sentAt = Date.now(); this.changed('loading');
    this.socket.send(this.codec!.encode({ type: cached ? 'viewport.subscribe.cached' : 'viewport.subscribe', subscription_id, bounds: this.bounds,
      ...(this.codec?.protocolVersion === 4 ? { visible_bounds: this.visible } : {}) }));
    this.armDeadline(35_000);
  }
  private armDeadline(ms: number): void {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.socket?.close(4000), ms);
  }
}
