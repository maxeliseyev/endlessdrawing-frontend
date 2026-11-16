import { backingSize, worldToScreen, type Camera, type Viewport } from './camera';
import { ERASER_TOLERANCE, type Point, type Stroke, type StrokeDraft } from './model';

type Drawable = Pick<StrokeDraft, 'points' | 'brush' | 'width' | 'color' | 'opacity'>;

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

function setLineStyle(context: CanvasRenderingContext2D, stroke: Drawable, tolerance = 0): void {
  context.lineWidth = stroke.width + tolerance * 2;
  context.lineCap = stroke.brush === 'round' ? 'round' : 'square';
  context.lineJoin = stroke.brush === 'round' ? 'round' : 'bevel';
}

export function drawStroke(
  context: CanvasRenderingContext2D, stroke: Drawable, camera: Camera, viewport: Viewport,
): void {
  const first = stroke.points[0];
  if (!first) return;
  context.save();
  context.globalCompositeOperation = 'source-over';
  context.globalAlpha = stroke.opacity;
  context.fillStyle = context.strokeStyle = stroke.color;
  setLineStyle(context, stroke);
  if (stroke.points.length === 1) {
    const [x, y] = worldToScreen(first, camera, viewport);
    const path = new Path2D();
    if (stroke.brush === 'round') path.arc(x, y, stroke.width / 2, 0, Math.PI * 2);
    else path.rect(x - stroke.width / 2, y - stroke.width / 2, stroke.width, stroke.width);
    context.fill(path);
  } else {
    // One stroke() operation composites the whole path once, including self-intersections.
    context.stroke(pathFor(stroke, camera, viewport));
  }
  context.restore();
}

export function hitTest(
  context: CanvasRenderingContext2D, stroke: Drawable, point: Point,
  camera: Camera, viewport: Viewport, tolerance = ERASER_TOLERANCE,
): boolean {
  const first = stroke.points[0];
  if (!first) return false;
  const [x, y] = worldToScreen(point, camera, viewport);
  if (stroke.points.length === 1) {
    const dx = Math.abs(point[0] - first[0]);
    const dy = Math.abs(point[1] - first[1]);
    const half = stroke.width / 2 + tolerance;
    return stroke.brush === 'round' ? Math.hypot(dx, dy) <= half : dx <= half && dy <= half;
  }
  context.save();
  // isPointInStroke coordinates are in canvas space and not affected by the CTM.
  context.resetTransform();
  setLineStyle(context, stroke, tolerance);
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

  constructor(private readonly canvas: HTMLCanvasElement, private readonly renderScene: () => void) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable in this browser.');
    this.context = context;
  }

  resize(viewport: Viewport, dpr: number): void {
    this.dpr = dpr;
    const size = backingSize(viewport, dpr);
    if (this.canvas.width !== size.width) this.canvas.width = size.width;
    if (this.canvas.height !== size.height) this.canvas.height = size.height;
    this.invalidate();
  }

  invalidate(): void {
    if (this.frame !== undefined) return;
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
