import { WORLD_LIMIT, type Point } from './model';

// zoom = CSS pixels per world unit. Missing zoom means 1 (the admin view).
export interface Camera { x: number; y: number; zoom?: number }
export interface Viewport { width: number; height: number }
export interface Bounds { min_x: number; min_y: number; max_x: number; max_y: number }

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
// Backend VIEWPORT_MAX_SPAN default: a subscription may not exceed it on either axis.
export const MAX_SUBSCRIPTION_SPAN = 30_000;

export function clampWorld(value: number): number {
  return Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, value));
}

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

export function zoomOf(camera: Camera): number {
  return camera.zoom ?? 1;
}

export function screenToWorld([x, y]: Point, camera: Camera, viewport: Viewport): Point {
  const zoom = zoomOf(camera);
  return [(x - viewport.width / 2) / zoom + camera.x, (y - viewport.height / 2) / zoom + camera.y];
}

export function worldToScreen([x, y]: Point, camera: Camera, viewport: Viewport): Point {
  const zoom = zoomOf(camera);
  return [(x - camera.x) * zoom + viewport.width / 2, (y - camera.y) * zoom + viewport.height / 2];
}

// dx/dy are world units.
export function pan(camera: Camera, dx: number, dy: number): Camera {
  return { ...camera, x: clampWorld(camera.x + dx), y: clampWorld(camera.y + dy) };
}

// Pan by a screen-space drag/scroll distance.
export function panScreen(camera: Camera, dx: number, dy: number): Camera {
  const zoom = zoomOf(camera);
  return pan(camera, dx / zoom, dy / zoom);
}

// Keep the world point under `anchor` (screen CSS px) fixed while zooming.
export function zoomAt(camera: Camera, zoom: number, anchor: Point, viewport: Viewport): Camera {
  const next = clampZoom(zoom);
  const [wx, wy] = screenToWorld(anchor, camera, viewport);
  return {
    x: clampWorld(wx - (anchor[0] - viewport.width / 2) / next),
    y: clampWorld(wy - (anchor[1] - viewport.height / 2) / next),
    zoom: next,
  };
}

// Two-finger gesture: the world point under the initial midpoint follows the
// current midpoint, and the finger distance ratio scales the starting zoom.
export function pinch(
  start: Camera, a0: Point, b0: Point, a1: Point, b1: Point, viewport: Viewport,
): Camera {
  const d0 = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]);
  const d1 = Math.hypot(b1[0] - a1[0], b1[1] - a1[1]);
  const zoom = clampZoom(zoomOf(start) * (d0 > 1 && d1 > 1 ? d1 / d0 : 1));
  const mid0: Point = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2];
  const mid1: Point = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2];
  const [wx, wy] = screenToWorld(mid0, start, viewport);
  return {
    x: clampWorld(wx - (mid1[0] - viewport.width / 2) / zoom),
    y: clampWorld(wy - (mid1[1] - viewport.height / 2) / zoom),
    zoom,
  };
}

// Ctrl/⌘+wheel and trackpad pinch. Large mouse-wheel notches are capped so one
// event cannot jump through the entire range.
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-Math.max(-50, Math.min(50, deltaY)) * 0.01);
}

export function visibleBounds(camera: Camera, viewport: Viewport): Bounds {
  const zoom = zoomOf(camera);
  const hw = viewport.width / 2 / zoom;
  const hh = viewport.height / 2 / zoom;
  return { min_x: camera.x - hw, min_y: camera.y - hh, max_x: camera.x + hw, max_y: camera.y + hh };
}

function axis(center: number, span: number): [number, number] {
  let min = clampWorld(center - span / 2);
  let max = clampWorld(center + span / 2);
  if (min >= max) {
    // Only possible exactly at the world edge; keep a non-empty area.
    if (max >= WORLD_LIMIT) min = WORLD_LIMIT - Math.max(1, span); else max = min + Math.max(1, span);
  }
  return [min, max];
}

// Prefetched world distance beyond each visible edge: one screen when the
// server span allows it (subscription = 3× the visible area), less when the
// span cap at deep zoom-out leaves less room.
function slack(visible: number): number {
  return Math.max(0, (Math.min(MAX_SUBSCRIPTION_SPAN, visible * 3) - visible) / 2);
}

// Share of the slack moved ahead of the view in the direction of travel, and
// the share of it that must remain ahead before a new snapshot is requested.
// LEAD < 1 - RESUBSCRIBE_AT, so a fresh subscription never re-triggers itself.
export const PREFETCH_LEAD = 0.35;
export const RESUBSCRIBE_AT = 0.5;

/**
 * Prefetch around the view, capped by the server span. `heading` is the unit
 * direction of the current pan (or [0, 0]): the area is shifted that way so
 * the next snapshot arrives before the view reaches unloaded ground.
 */
export function subscriptionBounds(camera: Camera, viewport: Viewport, heading: Point = [0, 0]): Bounds {
  const zoom = zoomOf(camera);
  const vw = viewport.width / zoom;
  const vh = viewport.height / zoom;
  const [min_x, max_x] = axis(camera.x + heading[0] * PREFETCH_LEAD * slack(vw), Math.min(MAX_SUBSCRIPTION_SPAN, vw * 3));
  const [min_y, max_y] = axis(camera.y + heading[1] * PREFETCH_LEAD * slack(vh), Math.min(MAX_SUBSCRIPTION_SPAN, vh * 3));
  return { min_x, min_y, max_x, max_y };
}

export function intersects(a: Bounds, b: Bounds): boolean {
  return a.min_x <= b.max_x && a.max_x >= b.min_x && a.min_y <= b.max_y && a.max_y >= b.min_y;
}

// Resubscribe once less than half of the prefetched slack remains beyond the
// visible area on some side (so there is still loaded ground ahead while the
// snapshot streams in), or after zooming in far enough that the old area is
// wastefully large.
export function needsResubscribe(subscribed: Bounds | undefined, camera: Camera, viewport: Viewport): boolean {
  if (!subscribed) return true;
  const visible = visibleBounds(camera, viewport);
  const mx = slack(visible.max_x - visible.min_x) * RESUBSCRIBE_AT;
  const my = slack(visible.max_y - visible.min_y) * RESUBSCRIBE_AT;
  const inside = subscribed.min_x <= Math.max(-WORLD_LIMIT, visible.min_x - mx) &&
    subscribed.max_x >= Math.min(WORLD_LIMIT, visible.max_x + mx) &&
    subscribed.min_y <= Math.max(-WORLD_LIMIT, visible.min_y - my) &&
    subscribed.max_y >= Math.min(WORLD_LIMIT, visible.max_y + my);
  const wasteful = (subscribed.max_x - subscribed.min_x) > 6 * (visible.max_x - visible.min_x) &&
    (subscribed.max_y - subscribed.min_y) > 6 * (visible.max_y - visible.min_y);
  return !inside || wasteful;
}

export function wheelPixels(
  dx: number, dy: number, mode: number, viewport: Viewport,
): Point {
  // DOM_DELTA_LINE has no standardized pixel size. Use a documented 16px line.
  if (mode === 1) return [dx * 16, dy * 16];
  if (mode === 2) return [dx * viewport.width, dy * viewport.height];
  return [dx, dy];
}

export function backingSize(viewport: Viewport, dpr: number): Viewport {
  return {
    width: Math.max(1, Math.round(viewport.width * dpr)),
    height: Math.max(1, Math.round(viewport.height * dpr)),
  };
}
