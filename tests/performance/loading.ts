import { SharedWorld } from '../../src/world';
import { createSceneRenderer } from '../../src/scene-renderer';
import { subscriptionBounds, visibleBounds, intersects, type Camera } from '../../src/camera';
import { strokeExtent } from '../../src/model';
import { socketCodec } from '../../src/transport/codec';
import { canvasPixels } from '../support/pixels';

const canvas = document.querySelector('canvas')!;
const viewport = { width: 1000, height: 700 };
const params = new URLSearchParams(location.search);
const zoom = Number(params.get('zoom') ?? 1);
let camera: Camera = { x: zoom === 1 ? 0 : zoom === 0.16 ? 100_000 : 200_000, y: 0, zoom };
let started = 0;
let firstGeometry: number | null = null, firstPaint: number | null = null, visiblePaint: number | null = null;
let end: number | null = null, bytes = 0, points = 0, handling = 0, prepare = 0, decode = 0;
let frameStart = 0, paintStart = 0;
const paintTimes: number[] = [];
const frames: number[] = [];
let done: (() => void) | undefined;
const failures: string[] = [];
const raw: ArrayBuffer[] = [];
const arrivals: number[] = [];
const seen = new Set<string>();
let expected: string[] = [];
let protocol = '';
const since = () => performance.now() - started;
const world = new SharedWorld({
  secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', undo: { load: () => [], save: () => {} },
  notice: (notice) => failures.push(notice), changed: () => renderer.invalidate(),
  createSocket: (_url, protocols) => {
    const socket = new WebSocket('ws://127.0.0.1:3301/ws', protocols);
    const nativeSend = socket.send.bind(socket);
    socket.send = (data) => {
      const message = socketCodec(socket.protocol).decode(data instanceof Uint8Array ? data.slice().buffer : data);
      if (String(message.type).startsWith('viewport.subscribe')) {
        started = performance.now(); firstGeometry = firstPaint = visiblePaint = end = null;
        bytes = points = handling = prepare = decode = 0; raw.length = arrivals.length = frames.length = paintTimes.length = 0; seen.clear(); frameStart = 0;
      }
      nativeSend(data);
    };
    const property = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage')!;
    Object.defineProperty(socket, 'onmessage', { set(handler: (event: MessageEvent) => void) {
      property.set!.call(socket, (event: MessageEvent) => {
        const begin = performance.now();
        if (started && event.data instanceof ArrayBuffer) { bytes += event.data.byteLength; raw.push(event.data); arrivals.push(since()); }
        handler(event);
        handling += performance.now() - begin;
        protocol = socket.protocol;
        if (world.scene.phase === 'ready' && end === null) end = since();
      });
    } });
    return socket;
  },
});
const renderer = createSceneRenderer(canvas, {
  camera: () => camera, viewport: () => { paintStart = performance.now(); return viewport; }, scene: world.scene, overlays: () => [],
  painted: () => {
    if (!started) return;
    const now = performance.now(); paintTimes.push(now - paintStart); if (frameStart) frames.push(now - frameStart); frameStart = now;
    const ink = (x: number, y: number) => canvasPixels(canvas, { op: 'region', cx: x, cy: y, halfWidth: 3, halfHeight: 3 }) === true;
    if (firstPaint === null && expected.some((id, index) => world.scene.get(id) && ink(200 + index * 50, 350))) firstPaint = since();
    if (visiblePaint === null && expected.length > 0 && expected.every((id, index) => world.scene.get(id) && ink(200 + index * 50, 350))) visiblePaint = since();
    if (end !== null && (expected.length === 0 || visiblePaint !== null)) done?.();
  },
});
world.scene.listener = {
  added(stroke) {
    if (intersects(strokeExtent(stroke), visibleBounds(camera, viewport))) {
      seen.add(stroke.id); firstGeometry ??= since();
    }
    const start = performance.now(); renderer.added(stroke); prepare += performance.now() - start;
  }, removed: (stroke) => renderer.removed(stroke),
};
renderer.resize(viewport, devicePixelRatio);

const api = {
  async run(ids: string[], scenario = 'cold') {
    expected = ids;
    if (scenario === 'pan') camera = { ...camera, x: camera.x - 2000 / zoom };
    if (scenario === 'empty') camera = { ...camera, x: camera.x + 50000 };
    if (scenario === 'reconnect') world.stop();
    const completion = new Promise<void>((resolve) => { done = resolve; });
    if (scenario === 'cold' || scenario === 'reconnect') world.start(subscriptionBounds(camera, viewport), visibleBounds(camera, viewport));
    else world.setBounds(subscriptionBounds(camera, viewport), visibleBounds(camera, viewport));
    await Promise.race([completion, new Promise((_, reject) => setTimeout(() => reject(new Error('Loading timeout: ' + JSON.stringify({ failures, protocol, end, firstGeometry, firstPaint, visiblePaint, seen: seen.size, scene: world.scene.strokes().length }))), 15000))]);
    // Decode cost measured separately after the observed load, without decoding twice on its hot path.
    const codec = socketCodec(protocol); const t = performance.now();
    points = 0; firstGeometry = null;
    for (let i = 0; i < raw.length; i++) {
      const message = codec.decode(raw[i]);
      if (message.type !== 'viewport.snapshot.chunk') continue;
      for (const stroke of message.strokes as import('../../src/model').Stroke[]) {
        points += stroke.points.length;
        if (intersects(strokeExtent(stroke), visibleBounds(camera, viewport))) firstGeometry ??= arrivals[i]!;
      }
    }
    decode = performance.now() - t;
    const strokes = world.scene.strokes();
    const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (n) => n.toString(16).padStart(2, '0')).join('');
    const sceneHash = await hash(JSON.stringify(strokes));
    const gl = (canvas as HTMLCanvasElement & { __gl?: WebGL2RenderingContext }).__gl;
    const rgba = new Uint8Array(canvas.width * canvas.height * 4);
    if (gl) gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    else rgba.set(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data);
    const rasterHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', rgba)), (n) => n.toString(16).padStart(2, '0')).join('');
    return { protocol, scenario, renderer: renderer.kind, zoom, dpr: devicePixelRatio, first_geometry_ms: firstGeometry,
      first_paint_ms: firstPaint, visible_paint_ms: visiblePaint, snapshot_end_ms: end, bytes, received_points: points,
      handling_ms: handling, geometry_prepare_ms: prepare, decode_replay_ms: decode,
      strokes: strokes.length, scene_hash: sceneHash, raster_hash: rasterHash, raster_format: 'rgba', frame_intervals_ms: frames, frame_times_ms: paintTimes,
      heap_bytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
      failures: [...failures] };
  },
  stop() { world.stop(); renderer.dispose(); },
};
(window as unknown as { loadingBench: typeof api }).loadingBench = api;
