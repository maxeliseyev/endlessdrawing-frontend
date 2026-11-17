import { intersects, visibleBounds, type Camera, type Viewport } from './camera';
import { strokeExtent, type Stroke, type StrokeDraft } from './model';
import { drawStroke, Renderer } from './renderer';
import type { SceneListener } from './scene';
import { TileCache, type TileSource } from './tiles';

/**
 * Rendering backend boundary of the public canvas.
 *
 * `main.ts` only talks to this interface: it owns input, camera and the
 * shared world, the backend owns the display canvas context and everything
 * about how confirmed strokes get to the screen (caching, budgets, GPU).
 * Canvas 2D with tiles is the current backend; a WebGL backend implements the
 * same contract (see docs/webgl.md). Eraser hit-testing never uses the display
 * context: a canvas can hold only one context type.
 */
export interface SceneRenderer extends SceneListener {
  /** Drawing technology, for diagnostics. */
  readonly kind: 'canvas2d' | 'webgl';
  resize(viewport: Viewport, dpr: number): void;
  /** Request one frame (coalesced to the next animation frame). */
  invalidate(): void;
  dispose(): void;
}

/** What a frame shows; read at frame time, never cached by the backend. */
export interface FrameInput {
  camera(): Camera;
  viewport(): Viewport;
  /** Confirmed drawn candidates by seq plus hidden ids (the shared scene). */
  scene: TileSource;
  /** Unconfirmed own strokes then the live preview, drawn on top in this order. */
  overlays(): readonly StrokeDraft[];
  /** Called after each painted frame. */
  painted?(): void;
}

export function createSceneRenderer(canvas: HTMLCanvasElement, input: FrameInput): SceneRenderer {
  // The WebGL backend plugs in here, falling back to Canvas 2D when WebGL is
  // unavailable or its context is lost.
  return new Canvas2DSceneRenderer(canvas, input);
}

export class Canvas2DSceneRenderer implements SceneRenderer {
  readonly kind = 'canvas2d';
  private readonly renderer: Renderer;
  private readonly tiles: TileCache;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(canvas: HTMLCanvasElement, private readonly input: FrameInput) {
    this.tiles = new TileCache(input.scene);
    this.renderer = new Renderer(canvas, () => this.paint());
  }

  added(stroke: Stroke): void { this.tiles.added(stroke); }
  removed(stroke: Stroke): void { this.tiles.removed(stroke); }
  resize(viewport: Viewport, dpr: number): void { this.renderer.resize(viewport, dpr); }
  invalidate(): void { this.renderer.invalidate(); }

  dispose(): void {
    clearTimeout(this.settleTimer);
    this.renderer.dispose();
  }

  private paint(): void {
    const { input } = this;
    const context = this.renderer.context;
    const dpr = this.renderer.pixelRatio;
    const viewport = input.viewport();
    context.setTransform(1, 0, 0, 1, 0, 0);
    const frame = this.tiles.draw(context, input.camera(), viewport, dpr, performance.now());
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Overlays use the pixel-snapped camera so they line up with the tiles.
    const view = frame.camera;
    if (frame.direct) {
      // No canvas memory for tiles: draw the visible scene directly.
      const bounds = visibleBounds(view, viewport);
      const { hidden } = input.scene;
      for (const stroke of input.scene.strokes()) {
        if (hidden.has(stroke.id) || !intersects(strokeExtent(stroke), bounds)) continue;
        drawStroke(context, stroke, view, viewport);
      }
    }
    for (const draft of input.overlays()) drawStroke(context, draft, view, viewport);
    clearTimeout(this.settleTimer);
    if (frame.busy) this.renderer.invalidate();
    else if (frame.settleIn !== undefined) this.settleTimer = setTimeout(() => this.renderer.invalidate(), frame.settleIn + 1);
    input.painted?.();
  }
}
