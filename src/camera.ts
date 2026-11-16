import { WORLD_LIMIT, type Point } from './model';

export interface Camera { x: number; y: number }
export interface Viewport { width: number; height: number }
export interface Bounds { min_x: number; min_y: number; max_x: number; max_y: number }

export function clampWorld(value: number): number {
  return Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, value));
}

export function screenToWorld([x, y]: Point, camera: Camera, viewport: Viewport): Point {
  return [x + camera.x - viewport.width / 2, y + camera.y - viewport.height / 2];
}

export function worldToScreen([x, y]: Point, camera: Camera, viewport: Viewport): Point {
  return [x - camera.x + viewport.width / 2, y - camera.y + viewport.height / 2];
}

export function pan(camera: Camera, dx: number, dy: number): Camera {
  return { x: clampWorld(camera.x + dx), y: clampWorld(camera.y + dy) };
}

export function subscriptionBounds(camera: Camera, viewport: Viewport): Bounds {
  return {
    min_x: clampWorld(camera.x - viewport.width * 1.5),
    min_y: clampWorld(camera.y - viewport.height * 1.5),
    max_x: clampWorld(camera.x + viewport.width * 1.5),
    max_y: clampWorld(camera.y + viewport.height * 1.5),
  };
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
