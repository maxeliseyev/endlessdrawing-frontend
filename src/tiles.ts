import { intersects, visibleBounds, zoomOf, type Bounds, type Camera, type Viewport } from './camera';
import { strokeExtent, type Stroke } from './model';
import { drawProjected } from './renderer';

/**
 * World-anchored raster cache of confirmed strokes.
 *
 * The drawn set is rendered once into opaque 512×512 backing-pixel tiles per
 * scale (zoom × DPR). A frame then only copies tiles, so panning and drawing
 * over a dense area no longer re-strokes every visible path. Pending creates
 * and the live preview are drawn on top by the caller each frame.
 *
 * - New tiles are rendered nearest-first within a per-frame time budget; the
 *   remaining ones follow in the next frames (`busy`). Missing tiles show the
 *   closest cached scale stretched, never a blank hole when anything is known.
 * - When idle, one ring of tiles around the view is prefetched.
 * - During a zoom gesture tiles use √2-quantized levels so they survive many
 *   frames; once the zoom has been still for SETTLE_MS they are re-rendered at
 *   the exact scale (crisp lines, same pixels as a direct render).
 * - A stroke that becomes drawn on top of a tile (higher seq than anything in
 *   it) is painted incrementally; any other change re-renders just the tiles
 *   its bounds touch.
 */
export const TILE_SIZE = 512;
export const SETTLE_MS = 180;
const BUDGET_MS = 6;
const MIN_TILES = 48;
const MAX_ADDS = 256;
const SPARE = 8;
const LEVEL = Math.SQRT2;

export interface TileSource {
  /** Drawn candidates sorted by seq (may include hidden ones). */
  strokes(): readonly Stroke[];
  isHidden(stroke: Stroke): boolean;
}

export interface TileSurface {
  canvas: CanvasImageSource & { width: number; height: number };
  context: CanvasRenderingContext2D;
}
export type SurfaceFactory = (size: number) => TileSurface | undefined;

export interface TileFrame {
  /** The camera snapped to whole backing pixels: draw overlays with it. */
  camera: Camera;
  /** More tiles to render: request another frame. */
  busy: boolean;
  /** Re-render at the exact scale after this many ms without zooming. */
  settleIn: number | undefined;
  /** Tile memory unavailable: the caller must draw the scene directly. */
  direct: boolean;
}

interface Tile extends TileSurface {
  key: string;
  scale: number;
  tx: number;
  ty: number;
  // World area including the anti-aliasing fringe of strokes just outside.
  bounds: Bounds;
  maxSeq: number;
  adds: Stroke[];
  dirty: boolean;
  used: number;
}

/** √2-step zoom level at or above `zoom` (tiles are downscaled, never upscaled). */
export function zoomLevel(zoom: number): number {
  const level = LEVEL ** Math.ceil(Math.log(zoom) / Math.log(LEVEL) - 1e-9);
  return Math.abs(level - zoom) <= zoom * 1e-9 ? zoom : level;
}

function domSurface(size: number): TileSurface | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  // Null when the browser refuses more canvas memory (notably iOS Safari).
  const context = canvas.getContext('2d', { alpha: false });
  return context ? { canvas, context } : undefined;
}

function key(scale: number, tx: number, ty: number): string {
  return `${scale}|${tx}|${ty}`;
}

export class TileCache {
  private readonly tiles = new Map<string, Tile>();
  private readonly spare: TileSurface[] = [];
  private zoom: number | undefined;
  private zoomedAt = -Infinity;
  private frame = 0;
  private failed = false;
  /** Full tile renders since creation (diagnostics and tests). */
  renders = 0;

  constructor(private readonly source: TileSource, private readonly createSurface: SurfaceFactory = domSurface) {}

  get size(): number { return this.tiles.size; }

  /** A stroke entered the drawn set. */
  added(stroke: Stroke): void {
    const extent = strokeExtent(stroke);
    for (const tile of this.tiles.values()) {
      if (tile.dirty || !intersects(tile.bounds, extent)) continue;
      if (stroke.seq > tile.maxSeq && tile.adds.length < MAX_ADDS) {
        tile.adds.push(stroke);
        tile.maxSeq = stroke.seq;
      } else this.spoil(tile);
    }
  }

  /** A stroke left the drawn set (deleted, hidden or outside the new snapshot). */
  removed(stroke: Stroke): void {
    const extent = strokeExtent(stroke);
    for (const tile of this.tiles.values()) if (!tile.dirty && intersects(tile.bounds, extent)) this.spoil(tile);
  }

  clear(): void {
    for (const tile of this.tiles.values()) this.spoil(tile);
  }

  /** Paint the view into `target` (identity transform, backing pixels). */
  draw(target: CanvasRenderingContext2D, camera: Camera, viewport: Viewport, dpr: number, now: number): TileFrame {
    const zoom = zoomOf(camera);
    if (this.zoom !== undefined && zoom !== this.zoom) this.zoomedAt = now;
    this.zoom = zoom;
    const exact = zoom * dpr;
    // Whole backing pixels from the canvas origin to world (0, 0) at the exact scale.
    const ox = Math.round((viewport.width * dpr) / 2 - camera.x * exact);
    const oy = Math.round((viewport.height * dpr) / 2 - camera.y * exact);
    const snapped: Camera = { x: ((viewport.width * dpr) / 2 - ox) / exact, y: ((viewport.height * dpr) / 2 - oy) / exact, zoom };
    if (this.failed) return { camera: snapped, busy: false, settleIn: undefined, direct: true };

    const wait = SETTLE_MS - (now - this.zoomedAt);
    const scale = wait <= 0 ? exact : zoomLevel(zoom) * dpr;
    const frame = ++this.frame;
    const view = visibleBounds(snapped, viewport);
    const needed = this.range(view, scale, 0);

    // Fallback first, farthest scale first: target tiles cover it where ready.
    // Not needed at all once every target tile is ready.
    const complete = needed.every(([tx, ty]) => this.tiles.get(key(scale, tx, ty))?.dirty === false);
    const fallback = complete ? [] : [...this.tiles.values()]
      .filter((tile) => tile.scale !== scale && !tile.dirty && intersects(tile.bounds, view))
      .sort((a, b) => Math.abs(Math.log(b.scale / scale)) - Math.abs(Math.log(a.scale / scale)));
    for (const tile of fallback) { tile.used = frame; this.blit(target, tile, exact, ox, oy); }

    const started = performance.now();
    const spent = () => performance.now() - started > BUDGET_MS;
    let busy = false;
    let rendered = 0;
    for (const [tx, ty] of needed) {
      let tile = this.tiles.get(key(scale, tx, ty));
      if (!tile || tile.dirty) {
        if (rendered > 0 && spent()) busy = true;
        else {
          tile = this.render(tile, scale, tx, ty);
          if (!tile) return this.fail(snapped);
          rendered++;
        }
      } else if (tile.adds.length) this.apply(tile);
      if (!tile) continue;
      tile.used = frame;
      // A stale tile over budget is still better than a hole for one frame.
      this.blit(target, tile, exact, ox, oy);
    }

    const ring = this.range(view, scale, 1);
    const cap = Math.max(MIN_TILES, Math.ceil(ring.length * 1.2));
    if (scale === exact) {
      // Idle prefetch of one ring around the view, so a pan reveals ready tiles.
      for (const [tx, ty] of ring) {
        let tile = this.tiles.get(key(scale, tx, ty));
        if ((!tile || tile.dirty) && !busy) {
          if (spent()) busy = true;
          else {
            tile = this.render(tile, scale, tx, ty);
            if (!tile) return this.fail(snapped);
          }
        }
        if (tile) tile.used = frame;
      }
    }
    this.evict(cap, frame, scale);
    return { camera: snapped, busy, settleIn: scale === exact ? undefined : wait, direct: false };
  }

  // Tile indices covering `view` (plus `margin` tiles), nearest to its center first.
  private range(view: Bounds, scale: number, margin: number): [number, number][] {
    const world = TILE_SIZE / scale;
    const x0 = Math.floor(view.min_x / world) - margin, x1 = Math.floor(view.max_x / world) + margin;
    const y0 = Math.floor(view.min_y / world) - margin, y1 = Math.floor(view.max_y / world) + margin;
    const cx = (view.min_x + view.max_x) / 2 / world - 0.5, cy = (view.min_y + view.max_y) / 2 / world - 0.5;
    const result: [number, number][] = [];
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) result.push([tx, ty]);
    return result.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  }

  private render(existing: Tile | undefined, scale: number, tx: number, ty: number): Tile | undefined {
    let tile = existing;
    if (!tile) {
      const surface = this.spare.pop() ?? this.createSurface(TILE_SIZE);
      if (!surface) return undefined;
      const world = TILE_SIZE / scale;
      const fringe = 2 / scale;
      tile = {
        ...surface, key: key(scale, tx, ty), scale, tx, ty, maxSeq: 0, adds: [], dirty: true, used: 0,
        bounds: { min_x: tx * world - fringe, min_y: ty * world - fringe, max_x: (tx + 1) * world + fringe, max_y: (ty + 1) * world + fringe },
      };
      this.tiles.set(tile.key, tile);
    }
    const { context } = tile;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
    const originX = (tile.tx * TILE_SIZE) / scale;
    const originY = (tile.ty * TILE_SIZE) / scale;
    const source = this.source;
    let maxSeq = 0;
    for (const stroke of source.strokes()) {
      if (source.isHidden(stroke) || !intersects(tile.bounds, strokeExtent(stroke))) continue;
      drawProjected(context, stroke, scale, originX, originY);
      maxSeq = Math.max(maxSeq, stroke.seq);
    }
    tile.maxSeq = maxSeq;
    tile.adds.length = 0;
    tile.dirty = false;
    this.renders++;
    return tile;
  }

  private apply(tile: Tile): void {
    const originX = (tile.tx * TILE_SIZE) / tile.scale;
    const originY = (tile.ty * TILE_SIZE) / tile.scale;
    for (const stroke of tile.adds) drawProjected(tile.context, stroke, tile.scale, originX, originY);
    tile.adds.length = 0;
  }

  // Edges are rounded per tile boundary, so neighbours share them exactly: no
  // seams when stretched, and whole-pixel 1:1 copies at the exact scale.
  private blit(target: CanvasRenderingContext2D, tile: Tile, exact: number, ox: number, oy: number): void {
    const k = (TILE_SIZE * exact) / tile.scale;
    const x0 = Math.round(tile.tx * k + ox), x1 = Math.round((tile.tx + 1) * k + ox);
    const y0 = Math.round(tile.ty * k + oy), y1 = Math.round((tile.ty + 1) * k + oy);
    if (x1 > x0 && y1 > y0) target.drawImage(tile.canvas, x0, y0, x1 - x0, y1 - y0);
  }

  private spoil(tile: Tile): void {
    tile.dirty = true;
    tile.adds.length = 0;
  }

  private evict(cap: number, frame: number, scale: number): void {
    // Dirty tiles out of view are useless; then least recently used, keeping
    // whatever the current frame needs at the target scale.
    for (const tile of this.tiles.values()) if (tile.dirty && tile.used !== frame) this.release(tile);
    if (this.tiles.size <= cap) return;
    const order = [...this.tiles.values()]
      .filter((tile) => !(tile.used === frame && tile.scale === scale))
      .sort((a, b) => a.used - b.used);
    for (const tile of order) {
      if (this.tiles.size <= cap) break;
      this.release(tile);
    }
  }

  private release(tile: Tile): void {
    this.tiles.delete(tile.key);
    if (this.spare.length < SPARE) { this.spare.push({ canvas: tile.canvas, context: tile.context }); return; }
    // Return the memory now; iOS Safari counts it until the canvas is collected.
    tile.canvas.width = tile.canvas.height = 0;
  }

  private fail(snapped: Camera): TileFrame {
    this.failed = true;
    for (const tile of [...this.tiles.values()]) this.release(tile);
    this.spare.length = 0;
    return { camera: snapped, busy: false, settleIn: undefined, direct: true };
  }
}
