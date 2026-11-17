// World coordinates reach ±1e9. A single float32 ulp there is 64 units, so the
// GPU stores each absolute value as a float32 pair (hi + lo) and subtracts the
// camera in that form. Stroke-local offsets stay ordinary float32.
// The same rounding sequence is inlined in the vertex shader.

/** Nearest float32 and the float32 remainder. `hi + lo` reconstructs `value` for world-sized inputs. */
export function splitFloat(value: number): [number, number] {
  const hi = Math.fround(value);
  return [hi, Math.fround(value - hi)];
}

function sub2(a: [number, number], b: [number, number]): [number, number] {
  const hi = Math.fround(a[0] - b[0]);
  const lo = Math.fround(Math.fround(a[1] - b[1]) + Math.fround(Math.fround(a[0] - hi) - b[0]));
  const z = Math.fround(hi + lo);
  return [z, Math.fround(lo - Math.fround(z - hi))];
}

function add1(a: [number, number], b: number): [number, number] {
  const hi = Math.fround(a[0] + b);
  const lo = Math.fround(a[1] + Math.fround(Math.fround(a[0] - hi) + b));
  const z = Math.fround(hi + lo);
  return [z, Math.fround(lo - Math.fround(z - hi))];
}

/**
 * Backing-pixel delta of `(origin + local - camera) * scale`, rounded the way
 * the vertex shader rounds. `scale` is zoom × device pixel ratio.
 */
export function emulatedOffset(origin: number, camera: number, local: number, scale: number): number {
  const shifted = add1(sub2(splitFloat(origin), splitFloat(camera)), local);
  return Math.fround(Math.fround(shifted[0] * scale) + Math.fround(shifted[1] * scale));
}
