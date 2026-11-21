import type { Camera } from './camera';

/** Whole world units, symmetric rounding and no negative zero or exponential notation in world bounds. */
export function coordinateText(camera: Pick<Camera, 'x' | 'y'>): string {
  const integer = (value: number): string => {
    const magnitude = Math.round(Math.abs(value));
    return value < 0 && magnitude !== 0 ? `−${magnitude}` : String(magnitude);
  };
  return `x: ${integer(camera.x)}  y: ${integer(camera.y)}`;
}

/** A passive label, not a toolbar or live region. Camera updates reuse the renderer's existing RAF. */
export class CanvasCoordinates {
  readonly element = document.createElement('div');

  constructor(label: string, camera: Camera) {
    this.element.className = 'canvas-coordinates';
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', label);
    this.element.setAttribute('aria-live', 'off');
    this.update(camera);
  }

  update(camera: Camera): void {
    const text = coordinateText(camera);
    if (this.element.textContent !== text) this.element.textContent = text;
  }
}
