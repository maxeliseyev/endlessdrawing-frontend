import { DEFAULT_PREFERENCES, isBrush, isTool, WORLD_LIMIT, type Preferences } from './model';
import type { Camera } from './camera';

export const STORAGE_KEYS = {
  preferences: 'endless-drawing.preferences.v1',
  camera: 'endless-drawing.camera.v1',
} as const;

export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function load(storage: StoragePort | undefined, key: string): unknown {
  try { return JSON.parse(storage?.getItem(key) ?? 'null') as unknown; }
  catch { return null; }
}

export function save(storage: StoragePort | undefined, key: string, value: unknown): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}

export function browserStorage(kind: 'localStorage' | 'sessionStorage'): StoragePort | undefined {
  // The property access itself may throw (privacy policy / sandbox).
  try { return window[kind]; }
  catch { return undefined; }
}

export function loadPreferences(storage: StoragePort | undefined): Preferences {
  const value = load(storage, STORAGE_KEYS.preferences);
  if (!isBrush(value) || !('tool' in value) || !isTool(value.tool)) return { ...DEFAULT_PREFERENCES };
  return { brush: value.brush, width: value.width, color: value.color.toUpperCase(), opacity: value.opacity, tool: value.tool };
}

export function loadCamera(storage: StoragePort | undefined, random = Math.random): Camera {
  const value = load(storage, STORAGE_KEYS.camera);
  if (value && typeof value === 'object' && 'x' in value && 'y' in value &&
      typeof value.x === 'number' && typeof value.y === 'number' &&
      Number.isFinite(value.x) && Number.isFinite(value.y) &&
      Math.abs(value.x) <= WORLD_LIMIT && Math.abs(value.y) <= WORLD_LIMIT) {
    return { x: value.x, y: value.y };
  }
  return { x: random() * 500 - 250, y: random() * 500 - 250 };
}
