import { DEFAULT_PREFERENCES, isBrush, isTool, WORLD_LIMIT, type Preferences } from './model';
import { clampZoom, type Camera } from './camera';

export const STORAGE_KEYS = {
  preferences: 'endless-drawing.preferences.v1',
  camera: 'endless-drawing.camera.v1',
  // Drawing-session secret: sessionStorage only, sent only in WS hello.
  session: 'endless-drawing.session.v1',
  // Own confirmed stroke UUIDs for undo; sessionStorage only.
  undo: 'endless-drawing.undo.v1',
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
  return storedCamera(storage) ?? { x: random() * 500 - 250, y: random() * 500 - 250, zoom: 1 };
}

/** The camera of this tab session, if any (undefined: a new session). */
export function storedCamera(storage: StoragePort | undefined): Camera | undefined {
  const value = load(storage, STORAGE_KEYS.camera);
  if (value && typeof value === 'object' && 'x' in value && 'y' in value &&
      typeof value.x === 'number' && typeof value.y === 'number' &&
      Number.isFinite(value.x) && Number.isFinite(value.y) &&
      Math.abs(value.x) <= WORLD_LIMIT && Math.abs(value.y) <= WORLD_LIMIT) {
    const zoom = 'zoom' in value && typeof value.zoom === 'number' ? clampZoom(value.zoom) : 1;
    return { x: value.x, y: value.y, zoom };
  }
  return undefined;
}

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 32 random bytes, base64url without padding. Storage failure keeps a
// page-lifetime secret: drawing still works, ownership ends with the page.
export function loadSessionSecret(
  storage: StoragePort | undefined,
  random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b),
): string {
  try {
    const stored = storage?.getItem(STORAGE_KEYS.session);
    if (stored && SECRET.test(stored)) return stored;
  } catch { /* fall through */ }
  const secret = base64url(random(new Uint8Array(32)));
  try { storage?.setItem(STORAGE_KEYS.session, secret); } catch { /* RAM only */ }
  return secret;
}

export function loadUndo(storage: StoragePort | undefined, max = 500): string[] {
  const value = load(storage, STORAGE_KEYS.undo);
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && UUID.test(id)).slice(-max);
}
