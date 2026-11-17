import { intersects, visibleBounds, zoomOf, type Bounds, type Camera, type Viewport } from '../camera';
import { SETTLE_MS, TILE_SIZE, zoomLevel } from '../tiles';

/** Same frame budget and retention rules as the Canvas tile cache. */
export const TILE_BUDGET_MS = 6;
export const MIN_CACHED_TILES = 48;
export const MAX_TILE_ADDS = 256;

export interface TileCoord {
  scale: number;
  tx: number;
  ty: number;
  key: string;
  bounds: Bounds;
}

export interface ZoomClock {
  zoom: number | undefined;
  zoomedAt: number;
}

export interface ViewPlan {
  snapped: Camera;
  ox: number;
  oy: number;
  exact: number;
  scale: number;
  settleIn: number | undefined;
  needed: TileCoord[];
  ring: TileCoord[];
  clock: ZoomClock;
}

export interface TilePlacement {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ResidentTile {
  key: string;
  bounds: Bounds;
  dirty: boolean;
  maxSeq: number;
  adds: number;
}

export function tileKey(scale: number, tx: number, ty: number): string {
  return `${scale}|${tx}|${ty}`;
}

/** World area of a tile plus the two-pixel fringe the Canvas cache uses. */
export function tileBounds(scale: number, tx: number, ty: number): Bounds {
  const world = TILE_SIZE / scale;
  const fringe = 2 / scale;
  return {
    min_x: tx * world - fringe,
    min_y: ty * world - fringe,
    max_x: (tx + 1) * world + fringe,
    max_y: (ty + 1) * world + fringe,
  };
}

/** World coordinate at the tile's top-left backing pixel. */
export function tileOrigin(scale: number, tx: number, ty: number): [number, number] {
  return [(tx * TILE_SIZE) / scale, (ty * TILE_SIZE) / scale];
}

/**
 * Which tiles this frame needs. The scale stays on √2 steps during a zoom
 * gesture and becomes exact after `SETTLE_MS`, matching `TileCache`.
 */
export function planView(
  camera: Camera, viewport: Viewport, dpr: number, now: number, clock: ZoomClock,
): ViewPlan {
  let zoomedAt = clock.zoomedAt;
  const zoom = zoomOf(camera);
  if (clock.zoom !== undefined && zoom !== clock.zoom) zoomedAt = now;
  const exact = zoom * dpr;
  const wait = SETTLE_MS - (now - zoomedAt);
  const scale = wait <= 0 ? exact : zoomLevel(zoom) * dpr;
  const ox = Math.round((viewport.width * dpr) / 2 - camera.x * exact);
  const oy = Math.round((viewport.height * dpr) / 2 - camera.y * exact);
  const snapped: Camera = {
    x: ((viewport.width * dpr) / 2 - ox) / exact,
    y: ((viewport.height * dpr) / 2 - oy) / exact,
    zoom,
  };
  const view = visibleBounds(snapped, viewport);
  return {
    snapped, ox, oy, exact, scale,
    settleIn: scale === exact ? undefined : wait,
    needed: tilesCovering(view, scale, 0),
    ring: tilesCovering(view, scale, 1),
    clock: { zoom, zoomedAt },
  };
}

/** Destination rectangle in backing pixels. Edges land on whole pixels. */
export function tilePlacement(
  tx: number, ty: number, tileScale: number, exact: number, ox: number, oy: number,
): TilePlacement {
  const k = (TILE_SIZE * exact) / tileScale;
  return {
    x0: Math.round(tx * k + ox),
    y0: Math.round(ty * k + oy),
    x1: Math.round((tx + 1) * k + ox),
    y1: Math.round((ty + 1) * k + oy),
  };
}

/**
 * A newer stroke is appended. An older one, a full add queue, or a removal
 * spoils the tile so it is rendered again. Tiles that do not exist yet are
 * omitted: the next frame builds them from the scene.
 */
export function tileUpdates(
  tiles: readonly ResidentTile[], extent: Bounds, seq: number, removed: boolean,
): { key: string; spoil: boolean }[] {
  const updates: { key: string; spoil: boolean }[] = [];
  for (const tile of tiles) {
    if (tile.dirty || !intersects(tile.bounds, extent)) continue;
    updates.push({
      key: tile.key,
      spoil: removed || seq <= tile.maxSeq || tile.adds >= MAX_TILE_ADDS,
    });
  }
  return updates;
}

/** Far at 1, nearer toward 0.5. Index 0 is the oldest stroke in the list. */
export function strokeDepth(index: number, count: number): number {
  const total = Math.max(1, count);
  return 0.5 + 0.5 * (1 - (index + 1) / (total + 1));
}

function tilesCovering(view: Bounds, scale: number, margin: number): TileCoord[] {
  const world = TILE_SIZE / scale;
  const x0 = Math.floor(view.min_x / world) - margin;
  const x1 = Math.floor(view.max_x / world) + margin;
  const y0 = Math.floor(view.min_y / world) - margin;
  const y1 = Math.floor(view.max_y / world) + margin;
  const cx = (view.min_x + view.max_x) / 2 / world - 0.5;
  const cy = (view.min_y + view.max_y) / 2 / world - 0.5;
  const result: TileCoord[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      result.push({ scale, tx, ty, key: tileKey(scale, tx, ty), bounds: tileBounds(scale, tx, ty) });
    }
  }
  return result.sort((a, b) => Math.hypot(a.tx - cx, a.ty - cy) - Math.hypot(b.tx - cx, b.ty - cy));
}
