import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../../src/model';
import { loadCamera, loadPreferences, save, STORAGE_KEYS, type StoragePort } from '../../src/storage';

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
    expect(loadCamera(storage, () => numbers.shift() ?? 0.5)).toEqual({ x: -250, y: 250 });
    save(storage, STORAGE_KEYS.camera, { x: 123.5, y: -99 });
    expect(loadCamera(storage, () => { throw new Error('must not generate'); })).toEqual({ x: 123.5, y: -99 });
  });

  it.each(['null', '[]', '{"x":1e100,"y":0}', '{"x":"10","y":0}', '{"x":0,"y":null}'])
  ('rejects corrupted camera: %s', (value) => {
    const storage = memory();
    storage.setItem(STORAGE_KEYS.camera, value);
    expect(loadCamera(storage, () => 0.5)).toEqual({ x: 0, y: 0 });
  });

  it('survives blocked, unavailable and quota-exhausted storage', () => {
    const denied: StoragePort = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('quota'); },
    };
    expect(loadPreferences(denied)).toEqual(DEFAULT_PREFERENCES);
    expect(loadCamera(denied, () => 0.5)).toEqual({ x: 0, y: 0 });
    expect(save(denied, 'key', {})).toBe(false);
    expect(save(undefined, 'key', {})).toBe(false);
  });
});
