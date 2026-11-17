import { backingSize, worldToScreen, zoomOf, type Camera, type Viewport } from './camera';
import { chiselPolygons, sprayParticles } from './brush-geometry';
import { ERASER_TOLERANCE, type Point, type Stroke, type StrokeDraft } from './model';

type Drawable = Pick<StrokeDraft, 'id' | 'points' | 'brush' | 'width' | 'color' | 'opacity'>;

interface CachedEffect {
  points: Point[];
  count: number;
  last: Point | undefined;
  width: number;
  brush: Drawable['brush'];
  id: string;
  path: Path2D;
}
const effects = new WeakMap<Drawable, CachedEffect>();

function effectPath(stroke: Drawable): Path2D {
  const cached = effects.get(stroke);
  const last = stroke.points.at(-1);
  // Preview only appends/decimates points. Completed geometry is immutable.
  if (cached && cached.points === stroke.points && cached.count === stroke.points.length &&
      cached.last === last && cached.width === stroke.width && cached.brush === stroke.brush && cached.id === stroke.id) return cached.path;
  const path = new Path2D();
  if (stroke.brush === 'chisel') {
    for (const polygon of chiselPolygons(stroke.points, stroke.width)) {
      const first = polygon[0];
      if (!first) continue;
      path.moveTo(first[0], first[1]);
      for (const [x, y] of polygon.slice(1)) path.lineTo(x, y);
      path.closePath();
    }
  } else {
    for (const { x, y, radius } of sprayParticles(stroke)) {
      path.moveTo(x + radius, y);
      path.arc(x, y, radius, 0, Math.PI * 2);
      path.closePath();
    }
  }
  effects.set(stroke, { points: stroke.points, count: stroke.points.length, last,
    width: stroke.width, brush: stroke.brush, id: stroke.id, path });
  return path;
}

function pathFor(stroke: Drawable, camera: Camera, viewport: Viewport): Path2D {
  const path = new Path2D();
  const first = stroke.points[0];
  if (!first) return path;
  const [x, y] = worldToScreen(first, camera, viewport);
  path.moveTo(x, y);
  for (const point of stroke.points.slice(1)) {
    const [px, py] = worldToScreen(point, camera, viewport);
    path.lineTo(px, py);
  }
  return path;
}

// Centerline relative to the first point, in world units. Completed points
// are frozen, so the Path2D is built once and reused by every tile and frame;
// a live preview only appends/decimates, which the count/last check catches.
interface CachedLine { count: number; last: Point | undefined; path: Path2D }
const lines = new WeakMap<readonly Point[], CachedLine>();

function linePath(points: readonly Point[]): Path2D {
  const last = points.at(-1);
  const cached = lines.get(points);
  if (cached && cached.count === points.length && cached.last === last) return cached.path;
  const path = new Path2D();
  const first = points[0]!;
  path.moveTo(0, 0);
  for (let index = 1; index < points.length; index++) {
    const point = points[index]!;
    path.lineTo(point[0] - first[0], point[1] - first[1]);
  }
  lines.set(points, { count: points.length, last, path });
  return path;
}

// Screen-space line style: width scales with zoom, tolerance stays in CSS px.
function setLineStyle(context: CanvasRenderingContext2D, stroke: Drawable, zoom: number, tolerance = 0): void {
  context.lineWidth = stroke.width * zoom + tolerance * 2;
  context.lineCap = stroke.brush === 'round' ? 'round' : 'square';
  context.lineJoin = stroke.brush === 'round' ? 'round' : 'bevel';
}

/**
 * Draw with an explicit projection: target = (world - origin) * scale, in the
 * context's current units. Geometry is relative to the stroke's first point,
 * so float precision of huge world coordinates never reaches the Canvas path.
 */
export function drawProjected(
  context: CanvasRenderingContext2D, stroke: Drawable, scale: number, originX: number, originY: number,
): void {
  const first = stroke.points[0];
  if (!first) return;
  context.save();
  context.globalCompositeOperation = 'source-over';
  context.globalAlpha = stroke.opacity;
  context.fillStyle = context.strokeStyle = stroke.color;
  context.translate((first[0] - originX) * scale, (first[1] - originY) * scale);
  context.scale(scale, scale);
  setLineStyle(context, stroke, 1);
  if (stroke.brush === 'chisel' || stroke.brush === 'spray') {
    // One union fill: overlap inside the nib/spray never reapplies opacity.
    context.fill(effectPath(stroke));
  } else if (stroke.points.length === 1) {
    const path = new Path2D();
    const size = stroke.width;
    if (stroke.brush === 'round') path.arc(0, 0, size / 2, 0, Math.PI * 2);
    else path.rect(-size / 2, -size / 2, size, size);
    context.fill(path);
  } else {
    // One stroke() operation composites the whole path once, including self-intersections.
    context.stroke(linePath(stroke.points));
  }
  context.restore();
}

export function drawStroke(
  context: CanvasRenderingContext2D, stroke: Drawable, camera: Camera, viewport: Viewport,
): void {
  const zoom = zoomOf(camera);
  drawProjected(context, stroke, zoom, camera.x - viewport.width / 2 / zoom, camera.y - viewport.height / 2 / zoom);
}

/**
 * A detached 2D context for hit-testing (isPointInPath/isPointInStroke only).
 * Independent of the display canvas, which may hold a WebGL context instead.
 */
export function createHitContext(): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable in this browser.');
  return context;
}

export function hitTest(
  context: CanvasRenderingContext2D, stroke: Drawable, point: Point,
  camera: Camera, viewport: Viewport, tolerance = ERASER_TOLERANCE,
): boolean {
  const first = stroke.points[0];
  if (!first) return false;
  const [x, y] = worldToScreen(point, camera, viewport);
  const zoom = zoomOf(camera);
  // `tolerance` is CSS px on screen; effect geometry is tested in world units.
  const worldTolerance = tolerance / zoom;
  if (stroke.brush === 'spray') {
    const px = point[0] - first[0];
    const py = point[1] - first[1];
    // Analytic circle distances avoid engine-specific stroke-to-path behavior
    // when a tolerance stroke is wider than a tiny particle's diameter.
    for (const particle of sprayParticles(stroke)) {
      if (Math.hypot(px - particle.x, py - particle.y) <= particle.radius + worldTolerance) return true;
    }
    return false;
  }
  if (stroke.brush === 'chisel') {
    context.save();
    context.resetTransform();
    context.lineWidth = worldTolerance * 2;
    context.lineJoin = 'round';
    const path = effectPath(stroke);
    const px = point[0] - first[0];
    const py = point[1] - first[1];
    // Match the swept nib rather than a round approximation of its centerline.
    const hit = context.isPointInPath(path, px, py) ||
      (tolerance > 0 && context.isPointInStroke(path, px, py));
    context.restore();
    return hit;
  }
  if (stroke.points.length === 1) {
    const dx = Math.abs(point[0] - first[0]);
    const dy = Math.abs(point[1] - first[1]);
    const half = stroke.width / 2 + worldTolerance;
    return stroke.brush === 'round' ? Math.hypot(dx, dy) <= half : dx <= half && dy <= half;
  }
  context.save();
  // isPointInStroke coordinates are in canvas space and not affected by the CTM.
  context.resetTransform();
  setLineStyle(context, stroke, zoom, tolerance);
  const hit = context.isPointInStroke(pathFor(stroke, camera, viewport), x, y);
  context.restore();
  return hit;
}

// Server-backed eraser selection must use seq, never local arrival order.
export function topmostOwned(strokes: Iterable<Stroke>, matches: (stroke: Stroke) => boolean): Stroke | undefined {
  let top: Stroke | undefined;
  for (const stroke of strokes) {
    if (stroke.own && (!top || stroke.seq > top.seq) && matches(stroke)) top = stroke;
  }
  return top;
}

export class Renderer {
  readonly context: CanvasRenderingContext2D;
  private frame: number | undefined;
  private dpr = 1;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly renderScene: () => void) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable in this browser.');
    this.context = context;
  }

  get pixelRatio(): number { return this.dpr; }

  resize(viewport: Viewport, dpr: number): void {
    this.dpr = dpr;
    const size = backingSize(viewport, dpr);
    if (this.canvas.width !== size.width) this.canvas.width = size.width;
    if (this.canvas.height !== size.height) this.canvas.height = size.height;
    this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }

  invalidate(): void {
    if (this.disposed || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      const context = this.context;
      context.resetTransform();
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';
      context.fillStyle = '#FFFFFF';
      context.fillRect(0, 0, this.canvas.width, this.canvas.height);
      context.scale(this.dpr, this.dpr);
      this.renderScene();
    });
  }
}
