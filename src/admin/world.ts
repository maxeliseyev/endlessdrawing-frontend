import type { Bounds } from '../camera';
import { object, ProtocolError } from './contracts';
import { AdminScene, SceneLimitError } from './scene';
import { toBase64url } from './webauthn';

export type WorldStatus = 'connecting' | 'loading' | 'ready' | 'disconnected' | 'scene_limit' | 'protocol_error';

export class ReadOnlyWorld {
  readonly scene = new AdminScene();
  private socket: WebSocket | undefined;
  private stopped = true;
  private ready = false;
  private retry = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private subscribeTimer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private bounds: Bounds | undefined;
  private sentAt = 0;
  private readonly secret = toBase64url(crypto.getRandomValues(new Uint8Array(32)));

  constructor(private readonly changed: (status: WorldStatus) => void,
    private readonly createSocket = (url: string) => new WebSocket(url)) {}

  start(bounds: Bounds): void {
    this.bounds = bounds;
    this.stopped = false;
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer); clearTimeout(this.subscribeTimer); clearTimeout(this.deadline);
    const socket = this.socket;
    this.socket = undefined; this.ready = false;
    socket?.close(1000);
    this.scene.clear();
  }
  refresh(): void {
    if (!this.stopped) this.subscribe();
  }
  setBounds(bounds: Bounds): void {
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
    this.scene.clear(); this.ready = false; this.changed('connecting');
    const url = new URL('/ws', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try { socket = this.createSocket(url.href); }
    catch { this.reconnect(); return; }
    this.socket = socket;
    this.armDeadline(8000);
    socket.onopen = () => {
      if (this.socket === socket) socket.send(JSON.stringify({ type: 'hello', session_secret: this.secret }));
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.stopped) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > 1_048_576) throw new ProtocolError();
        const message = object(JSON.parse(event.data));
        if (!this.ready) {
          if (message.type !== 'hello.ack' || message.protocol_version !== 1) throw new ProtocolError();
          this.ready = true;
          this.subscribe();
          return;
        }
        if (message.type === 'error' && message.subscription_id === undefined) throw new ProtocolError();
        const action = this.scene.accept(message);
        if (action === 'resync') {
          // Fresh subscription, not a seq-based replay. Rate-limit resync loops.
          this.scene.subscribe(''); this.changed('loading');
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
    this.scene.subscribe(subscription_id); this.sentAt = Date.now(); this.changed('loading');
    this.socket.send(JSON.stringify({ type: 'viewport.subscribe', subscription_id, bounds: this.bounds }));
    this.armDeadline(35_000);
  }
  private armDeadline(ms: number): void {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.socket?.close(4000), ms);
  }
}
