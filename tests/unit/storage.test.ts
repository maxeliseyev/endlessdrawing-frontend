import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../../src/model';
import { base64url, loadCamera, loadPreferences, loadSessionSecret, loadUndo, save, STORAGE_KEYS, type StoragePort } from '../../src/storage';

function memory(): StoragePort {
  const items = new Map<string, string>();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value); } };
}

describe('versioned browser storage', () => {
  it('defaults to brush and restores tool without losing brush settings', () => {
    const storage = memory();
    expect(loadPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
    const prefs = { ...DEFAULT_PREFERENCES, tool: 'hand', width: 32, color: '#aabbcc', opacity: 0.4 };
    expect(save(storage, STORAGE_KEYS.preferences, prefs)).toBe(true);
    expect(loadPreferences(storage)).toEqual({ ...prefs, color: '#AABBCC' });
  });

  it.each(['chisel', 'spray'] as const)('restores %s with existing versioned preferences', (brush) => {
    const storage = memory();
    const prefs = { ...DEFAULT_PREFERENCES, brush, width: 48, opacity: 0.5 };
    save(storage, STORAGE_KEYS.preferences, prefs);
    expect(loadPreferences(storage)).toEqual(prefs);
  });

  it.each([
    'broken JSON', 'null', '{"tool":"other"}',
    JSON.stringify({ ...DEFAULT_PREFERENCES, width: 65 }),
    JSON.stringify({ ...DEFAULT_PREFERENCES, opacity: 0 }),
    JSON.stringify({ ...DEFAULT_PREFERENCES, color: 'red' }),
  ])('rejects corrupted preferences: %s', (value) => {
    const storage = memory();
    storage.setItem(STORAGE_KEYS.preferences, value);
    expect(loadPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
  });

  it('creates an independent random camera within +/-250 and restores it', () => {
    const storage = memory();
    const numbers = [0, 1];
    expect(loadCamera(storage, () => numbers.shift() ?? 0.5)).toEqual({ x: -250, y: 250, zoom: 1 });
    save(storage, STORAGE_KEYS.camera, { x: 123.5, y: -99 });
    expect(loadCamera(storage, () => { throw new Error('must not generate'); })).toEqual({ x: 123.5, y: -99, zoom: 1 });
  });

  it.each(['null', '[]', '{"x":1e100,"y":0}', '{"x":"10","y":0}', '{"x":0,"y":null}'])
  ('rejects corrupted camera: %s', (value) => {
    const storage = memory();
    storage.setItem(STORAGE_KEYS.camera, value);
    expect(loadCamera(storage, () => 0.5)).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('survives blocked, unavailable and quota-exhausted storage', () => {
    const denied: StoragePort = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('quota'); },
    };
    expect(loadPreferences(denied)).toEqual(DEFAULT_PREFERENCES);
    expect(loadCamera(denied, () => 0.5)).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(save(denied, 'key', {})).toBe(false);
    expect(save(undefined, 'key', {})).toBe(false);
  });

  it('restores and clamps camera zoom; missing zoom stays 1 for old sessions', () => {
    const storage = memory();
    save(storage, STORAGE_KEYS.camera, { x: 1, y: 2, zoom: 2.5 });
    expect(loadCamera(storage)).toEqual({ x: 1, y: 2, zoom: 2.5 });
    save(storage, STORAGE_KEYS.camera, { x: 1, y: 2, zoom: 99 });
    expect(loadCamera(storage)).toEqual({ x: 1, y: 2, zoom: 4 });
    save(storage, STORAGE_KEYS.camera, { x: 1, y: 2, zoom: 0.001 });
    expect(loadCamera(storage)).toEqual({ x: 1, y: 2, zoom: 0.16 });
  });

  it('keeps a 32-byte base64url session secret per tab session and replaces corrupted values', () => {
    const storage = memory();
    const fixed = (bytes: Uint8Array) => bytes.fill(0xfb);
    const secret = loadSessionSecret(storage, fixed);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secret).toBe(base64url(new Uint8Array(32).fill(0xfb)));
    expect(storage.getItem(STORAGE_KEYS.session)).toBe(secret);
    expect(loadSessionSecret(storage, () => { throw new Error('must reuse'); })).toBe(secret);
    storage.setItem(STORAGE_KEYS.session, 'short');
    expect(loadSessionSecret(storage, (b) => b.fill(1))).toBe(base64url(new Uint8Array(32).fill(1)));
    expect(STORAGE_KEYS.session).not.toBe(STORAGE_KEYS.preferences);
  });

  it('still produces a secret when Storage throws, without persisting it', () => {
    const denied: StoragePort = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadSessionSecret(denied, (b) => b.fill(7))).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loadSessionSecret(undefined, (b) => b.fill(7))).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loadUndo(denied)).toEqual([]);
  });

  it('loads only valid lowercase UUIDs for undo and caps the stack', () => {
    const storage = memory();
    const id = '87a122fa-7537-4b88-9b77-b45d24a29714';
    storage.setItem(STORAGE_KEYS.undo, JSON.stringify([id, 'nope', 5, id.toUpperCase()]));
    expect(loadUndo(storage)).toEqual([id]);
    storage.setItem(STORAGE_KEYS.undo, JSON.stringify(Array.from({ length: 10 }, () => id)));
    expect(loadUndo(storage, 3)).toHaveLength(3);
    storage.setItem(STORAGE_KEYS.undo, '{"broken"');
    expect(loadUndo(storage)).toEqual([]);
  });
});
