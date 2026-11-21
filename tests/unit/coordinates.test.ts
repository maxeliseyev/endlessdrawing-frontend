import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasCoordinates, coordinateText } from '../../src/coordinates';

afterEach(() => vi.unstubAllGlobals());

describe('canvas center coordinates', () => {
  it.each([
    [{ x: 0, y: -0 }, 'x: 0  y: 0'],
    [{ x: -0.49, y: 0.49 }, 'x: 0  y: 0'],
    [{ x: -0.5, y: 0.5 }, 'x: −1  y: 1'],
    [{ x: -1240.2, y: 579.8 }, 'x: −1240  y: 580'],
    [{ x: -1_000_000_000, y: 1_000_000_000 }, 'x: −1000000000  y: 1000000000'],
  ] as const)('formats %o in whole world units', (center, text) => {
    expect(coordinateText(center)).toBe(text);
  });

  it('uses the camera center, independent of zoom', () => {
    for (const zoom of [0.16, 1, 4]) {
      const camera = { x: -1240, y: 580, zoom };
      expect(coordinateText(camera)).toBe('x: −1240  y: 580');
    }
  });

  it('creates a passive localized group and avoids DOM writes while rounded coordinates stay the same', () => {
    let text = '';
    const write = vi.fn((value: string) => { text = value; });
    const element = { className: '', setAttribute: vi.fn(), get textContent() { return text; }, set textContent(value: string) { write(value); } };
    vi.stubGlobal('document', { createElement: vi.fn(() => element) });
    const coordinates = new CanvasCoordinates('Canvas center coordinates', { x: 10.1, y: -20.2 });
    expect(element.className).toBe('canvas-coordinates');
    expect(element.setAttribute).toHaveBeenCalledWith('role', 'group');
    expect(element.setAttribute).toHaveBeenCalledWith('aria-label', 'Canvas center coordinates');
    expect(element.setAttribute).toHaveBeenCalledWith('aria-live', 'off');
    expect(text).toBe('x: 10  y: −20');
    coordinates.update({ x: 10.2, y: -20.3, zoom: 4 });
    expect(write).toHaveBeenCalledTimes(1);
    coordinates.update({ x: 11, y: -21 });
    expect(text).toBe('x: 11  y: −21');
    expect(write).toHaveBeenCalledTimes(2);
  });
});
