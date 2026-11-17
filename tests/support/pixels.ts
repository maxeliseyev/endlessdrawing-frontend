// Reads the public canvas in page.evaluate. WebGL keeps its own context on
// `canvas.__gl` because a second getContext('webgl2') can come back null, and
// its origin is the bottom of the buffer.

interface PixelRequest {
  op: string;
  x?: number;
  y?: number;
  sizeCss?: number;
  cx?: number;
  cy?: number;
  halfWidth?: number;
  halfHeight?: number;
}

type GLCanvas = HTMLCanvasElement & { __gl?: WebGL2RenderingContext };

export function canvasPixels(canvas: HTMLCanvasElement, request: PixelRequest): unknown {
  function read(x: number, y: number, width: number, height: number): Uint8ClampedArray {
    const gl = (canvas as GLCanvas).__gl;
    if (gl && canvas.dataset.renderer === 'webgl') {
      const buf = new Uint8Array(width * height * 4);
      gl.readPixels(x, canvas.height - y - height, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const out = new Uint8ClampedArray(width * height * 4);
      const stride = width * 4;
      for (let row = 0; row < height; row++) {
        out.set(buf.subarray((height - 1 - row) * stride, (height - row) * stride), row * stride);
      }
      return out;
    }
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Missing canvas context');
    return context.getImageData(x, y, width, height).data;
  }
  const scale = canvas.width / canvas.clientWidth;
  if (request.op === 'pixel') {
    const data = read(Math.round((request.x ?? 0) * scale), Math.round((request.y ?? 0) * scale), 1, 1);
    return [data[0], data[1], data[2], data[3]];
  }
  if (request.op === 'keep') {
    (window as unknown as { kept: Uint8ClampedArray }).kept = read(0, 0, canvas.width, canvas.height);
    return null;
  }
  if (request.op === 'distance') {
    const kept = (window as unknown as { kept: Uint8ClampedArray }).kept;
    const next = read(0, 0, canvas.width, canvas.height);
    let max = 0;
    let count = 0;
    const length = Math.min(kept.length, next.length);
    for (let i = 0; i < length; i++) {
      const delta = Math.abs(kept[i]! - next[i]!);
      if (delta) count++;
      if (delta > max) max = delta;
    }
    return [count, max];
  }
  if (request.op === 'ink') {
    const originX = request.x ?? 0;
    const originY = request.y ?? 0;
    const size = Math.round((request.sizeCss ?? 1) * scale);
    const pixels = read(Math.round(originX * scale), Math.round(originY * scale), size, size);
    let count = 0;
    let first: { x: number; y: number } | null = null;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i]! < 230) {
        count++;
        first ??= {
          x: originX + ((i / 4) % size) / scale,
          y: originY + Math.floor(i / 4 / size) / scale,
        };
      }
    }
    return { count, first };
  }
  const cx = request.cx ?? 0;
  const cy = request.cy ?? 0;
  const halfWidth = request.halfWidth ?? 0;
  const halfHeight = request.halfHeight ?? 0;
  const x0 = Math.max(0, Math.round((cx - halfWidth) * scale));
  const y0 = Math.max(0, Math.round((cy - halfHeight) * scale));
  const x1 = Math.min(canvas.width, Math.round((cx + halfWidth) * scale));
  const y1 = Math.min(canvas.height, Math.round((cy + halfHeight) * scale));
  const data = read(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255 || data[i + 3] !== 255) return true;
  }
  return false;
}
