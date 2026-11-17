import { clampWorld, pan, panScreen, screenToWorld, subscriptionBounds, wheelPixels, wheelZoomFactor, worldToScreen, zoomAt, zoomOf, type Camera, type Viewport } from '../camera';
import type { Point, Stroke } from '../model';
import { drawStroke, hitTest, Renderer } from '../renderer';
import { ReadOnlyWorld, type WorldStatus } from './world';

type Gesture = { id: number; origin: Point; camera: Camera; pan: boolean; moved: boolean };

export class AdminView {
  readonly canvas = document.createElement('canvas');
  readonly world: ReadOnlyWorld;
  private readonly renderer: Renderer;
  private readonly events = new AbortController();
  private readonly observer: ResizeObserver;
  private readonly selected = new Set<string>();
  private camera: Camera = { x: 0, y: 0, zoom: 1 };
  private viewport: Viewport = { width: 1, height: 1 };
  private gesture: Gesture | undefined;
  private space = false;
  private mode: 'select' | 'hand' = 'select';
  private locked = false;
  private disposed = false;
  private dprQuery: MediaQueryList | undefined;
  status: WorldStatus = 'connecting';

  constructor(host: HTMLElement, label: string,
    private readonly changed: (ids: readonly string[], status: WorldStatus) => void,
    private readonly limit: () => void,
    private readonly onCamera?: (camera: Camera) => void) {
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', label);
    host.append(this.canvas);
    this.renderer = new Renderer(this.canvas, () => this.draw());
    this.world = new ReadOnlyWorld((status) => {
      if (this.disposed) return;
      this.status = status;
      if (status !== 'ready') this.selected.clear();
      else for (const id of this.selected) if (!this.world.scene.strokes.has(id)) this.selected.delete(id);
      this.notify(); this.renderer.invalidate();
    });
    this.installInput();
    this.resize();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.watchDpr();
    this.world.start(subscriptionBounds(this.camera, this.viewport));
  }
  get selection(): readonly string[] { return [...this.selected].sort(); }
  setMode(mode: 'select' | 'hand'): void { this.mode = mode; this.cursor(); }
  lock(value: boolean): void { this.locked = value; this.gesture = undefined; this.cursor(); }
  clear(): void { this.selected.clear(); this.notify(); this.renderer.invalidate(); }
  deselect(id: string): void { if (!this.locked) { this.selected.delete(id); this.notify(); this.renderer.invalidate(); } }
  remove(ids: Iterable<string>): void {
    this.world.scene.remove(ids);
    for (const id of this.selected) if (!this.world.scene.strokes.has(id)) this.selected.delete(id);
    this.notify(); this.renderer.invalidate();
  }
  refresh(): void {
    if (this.worldStatusStopped()) this.world.start(subscriptionBounds(this.camera, this.viewport));
    else this.world.refresh();
  }
  dispose(): void {
    this.disposed = true; this.events.abort(); this.observer.disconnect();
    this.dprQuery?.removeEventListener('change', this.onDpr);
    this.world.stop(); this.renderer.dispose(); this.selected.clear(); this.canvas.remove();
  }
  private worldStatusStopped(): boolean { return this.status === 'protocol_error' || this.status === 'scene_limit'; }
  private notify(): void { this.changed(this.selection, this.status); }
  private resize(): void {
    if (this.disposed) return;
    const rect = this.canvas.getBoundingClientRect();
    this.viewport = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
    this.renderer.resize(this.viewport, devicePixelRatio || 1);
    this.world.setBounds(subscriptionBounds(this.camera, this.viewport));
  }
  private readonly onDpr = () => { this.resize(); this.watchDpr(); };
  private watchDpr(): void {
    this.dprQuery?.removeEventListener('change', this.onDpr);
    this.dprQuery = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
    this.dprQuery.addEventListener('change', this.onDpr, { once: true });
  }
  private draw(): void {
    const strokes = [...this.world.scene.strokes.values()].sort((a, b) => a.seq - b.seq);
    for (const stroke of strokes) drawStroke(this.renderer.context, stroke, this.camera, this.viewport);
    const ctx = this.renderer.context;
    ctx.save(); ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    for (const id of this.selected) {
      const stroke = this.world.scene.strokes.get(id);
      if (!stroke) continue;
      const b = bounds(stroke);
      const [x0, y0] = worldToScreen([b.minX, b.minY], this.camera, this.viewport);
      const [x1, y1] = worldToScreen([b.maxX, b.maxY], this.camera, this.viewport);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
    ctx.restore();
  }
  private point(event: { clientX: number; clientY: number }): Point {
    const rect = this.canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }
  private move(dx: number, dy: number): void {
    this.applyCamera(pan(this.camera, dx, dy));
  }
  private moveScreen(dx: number, dy: number): void {
    this.applyCamera(panScreen(this.camera, dx, dy));
  }
  private applyCamera(next: Camera): void {
    this.camera = next;
    this.selected.clear(); this.notify(); this.renderer.invalidate();
    this.world.setBounds(subscriptionBounds(this.camera, this.viewport));
    this.onCamera?.(this.camera);
  }
  zoomIn(): void { this.zoomBy(1.25); }
  zoomOut(): void { this.zoomBy(1 / 1.25); }
  private zoomBy(factor: number): void {
    this.applyCamera(zoomAt(this.camera, zoomOf(this.camera) * factor,
      [this.viewport.width / 2, this.viewport.height / 2], this.viewport));
  }
  jumpTo(x: number, y: number): void {
    this.applyCamera({ x: clampWorld(x), y: clampWorld(y), zoom: zoomOf(this.camera) });
  }
  get zoom(): number { return zoomOf(this.camera); }
  private cursor(): void { this.canvas.style.cursor = this.locked ? 'wait' : this.gesture?.pan ? 'grabbing' : this.space || this.mode === 'hand' ? 'grab' : 'crosshair'; }
  private toggle(point: Point): void {
    if (this.locked || this.status !== 'ready') return;
    const world = screenToWorld(point, this.camera, this.viewport);
    const strokes = [...this.world.scene.strokes.values()].sort((a, b) => b.seq - a.seq);
    const stroke = strokes.find((stroke) => {
      const b = bounds(stroke);
      return world[0] >= b.minX && world[0] <= b.maxX && world[1] >= b.minY && world[1] <= b.maxY &&
        hitTest(this.renderer.context, stroke, world, this.camera, this.viewport);
    });
    if (!stroke) return;
    if (this.selected.has(stroke.id)) this.selected.delete(stroke.id);
    else if (this.selected.size >= 100) { this.limit(); return; }
    else this.selected.add(stroke.id);
    this.notify(); this.renderer.invalidate();
  }
  private installInput(): void {
    const signal = this.events.signal;
    this.canvas.addEventListener('pointerdown', (event) => {
      if (this.locked || this.gesture || event.pointerType === 'touch' || ![0, 1].includes(event.button)) return;
      event.preventDefault(); this.canvas.focus({ preventScroll: true });
      this.gesture = { id: event.pointerId, origin: this.point(event), camera: { ...this.camera },
        pan: event.button === 1 || this.space || this.mode === 'hand', moved: false };
      this.canvas.setPointerCapture(event.pointerId); this.cursor();
    }, { signal });
    this.canvas.addEventListener('pointermove', (event) => {
      const g = this.gesture;
      if (!g || g.id !== event.pointerId) return;
      const point = this.point(event);
      if (Math.hypot(point[0] - g.origin[0], point[1] - g.origin[1]) > 4) g.moved = true;
      if (g.pan) {
        const zoom = zoomOf(g.camera);
        const target = {
          x: clampWorld(g.camera.x + (g.origin[0] - point[0]) / zoom),
          y: clampWorld(g.camera.y + (g.origin[1] - point[1]) / zoom),
        };
        this.move(target.x - this.camera.x, target.y - this.camera.y);
      }
    }, { signal });
    this.canvas.addEventListener('pointerup', (event) => {
      const g = this.gesture;
      if (!g || g.id !== event.pointerId || event.buttons !== 0) return;
      this.gesture = undefined;
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      if (!g.pan && !g.moved) this.toggle(this.point(event));
      this.cursor();
    }, { signal });
    for (const type of ['pointercancel', 'lostpointercapture'] as const) this.canvas.addEventListener(type, () => { this.gesture = undefined; this.cursor(); }, { signal });
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });
    this.canvas.addEventListener('auxclick', (event) => { if (event.button === 1) event.preventDefault(); }, { signal });
    this.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (this.locked) return;
      this.gesture = undefined;
      if (event.ctrlKey || event.metaKey) {
        this.applyCamera(zoomAt(this.camera, zoomOf(this.camera) * wheelZoomFactor(event.deltaY), this.point(event), this.viewport));
      } else {
        const [x, y] = wheelPixels(event.deltaX, event.deltaY, event.deltaMode, this.viewport);
        this.moveScreen(x, y);
      }
      this.cursor();
    }, { passive: false, signal });
    window.addEventListener('keydown', (event) => {
      if (event.target !== this.canvas) return;
      if (event.code === 'Space') { event.preventDefault(); this.space = true; this.cursor(); }
      if (event.key === 'Escape' && !this.locked) { this.gesture = undefined; this.clear(); this.cursor(); }
    }, { signal });
    window.addEventListener('keyup', (event) => { if (event.code === 'Space') { this.space = false; this.cursor(); } }, { signal });
    window.addEventListener('blur', () => { this.space = false; this.gesture = undefined; this.cursor(); }, { signal });
  }
}

function bounds(stroke: Stroke) {
  const pad = stroke.width / Math.SQRT2 + 5;
  return { minX: Math.min(...stroke.points.map((p) => p[0])) - pad,
    minY: Math.min(...stroke.points.map((p) => p[1])) - pad,
    maxX: Math.max(...stroke.points.map((p) => p[0])) + pad,
    maxY: Math.max(...stroke.points.map((p) => p[1])) + pad };
}
