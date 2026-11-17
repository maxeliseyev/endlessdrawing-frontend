import './style.css';
import { resolveLocale, translations } from './i18n';
import {
  clampWorld, intersects, needsResubscribe, panScreen, pinch, screenToWorld, subscriptionBounds,
  visibleBounds, wheelPixels, wheelZoomFactor, zoomAt, zoomOf, type Camera, type Viewport,
} from './camera';
import { appendPoint, fitsCreateMessage, newId, strokeExtent, type Point, type StrokeDraft } from './model';
import { Palette, toolCursor } from './palette';
import { drawStroke, hitTest, Renderer } from './renderer';
import { TileCache } from './tiles';
import {
  browserStorage, loadCamera, loadPreferences, loadSessionSecret, loadUndo, save, STORAGE_KEYS,
} from './storage';
import { MAX_UNDO, SharedWorld, type Notice } from './world';

// Every gesture belongs to exactly one pointer, except a two-finger pinch.
// `blocked` swallows the remaining fingers after a pinch or a long press until
// all of them are lifted: a leftover finger never starts drawing by itself.
type Gesture =
  | { kind: 'draw'; pointerId: number; type: string; stroke: StrokeDraft }
  | { kind: 'pan'; pointerId: number; type: string; origin: Point; camera: Camera }
  | { kind: 'erase'; pointerId: number; type: string; origin: Point; moved: boolean }
  | { kind: 'pinch'; a: number; b: number; a0: Point; b0: Point; camera: Camera }
  | { kind: 'blocked' };

const LONG_PRESS_MS = 500;
const TOUCH_SLOP = 10; // CSS px of finger movement that still counts as "holding still"
const ZOOM_STEP = 1.25;

const locale = resolveLocale(navigator.languages, navigator.language);
const messages = translations[locale];
document.documentElement.lang = locale;

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing application root');

const canvas = document.createElement('canvas');
canvas.tabIndex = 0;
canvas.setAttribute('aria-label', messages.canvasLabel);
app.append(canvas);

const local = browserStorage('localStorage');
const session = browserStorage('sessionStorage');
let preferences = loadPreferences(local);
let camera = loadCamera(session);
let viewport: Viewport = { width: window.innerWidth, height: window.innerHeight };
let gesture: Gesture | undefined;
let space = false;
// Last mouse/pen position over the canvas: while Space is held, plain cursor
// movement (no button) drags the canvas along with it.
let hover: Point | undefined;
let cameraDirty = false;
// Once a pen is used, fingers only navigate (palm/hand on the screen).
let penSeen = false;
const touches = new Map<number, Point>();
let longPress: { timer: ReturnType<typeof setTimeout>; pointerId: number; origin: Point } | undefined;

const world = new SharedWorld({
  secret: loadSessionSecret(session),
  undo: { load: () => loadUndo(session, MAX_UNDO), save: (ids) => { save(session, STORAGE_KEYS.undo, ids); } },
  changed: () => renderer.invalidate(),
  notice: (notice) => notify(noticeText(notice), notice),
});

// Confirmed strokes live in a world-anchored tile cache fed by scene changes;
// a frame copies tiles and draws only pending strokes and the preview on top.
const tiles = new TileCache(world.scene);
world.scene.listener = tiles;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

const renderer = new Renderer(canvas, () => {
  const context = renderer.context;
  const dpr = renderer.pixelRatio;
  const scene = world.scene;
  context.setTransform(1, 0, 0, 1, 0, 0);
  const frame = tiles.draw(context, camera, viewport, dpr, performance.now());
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Overlays use the pixel-snapped camera so they line up with the tiles.
  const view = frame.camera;
  if (frame.direct) {
    // No canvas memory for tiles: draw the visible scene directly.
    const bounds = visibleBounds(view, viewport);
    for (const stroke of scene.strokes()) {
      if (scene.hidden.has(stroke.id) || !intersects(strokeExtent(stroke), bounds)) continue;
      drawStroke(context, stroke, view, viewport);
    }
  }
  // Unconfirmed own strokes: on top, in creation order, until their ack.
  for (const draft of scene.visiblePending()) drawStroke(context, draft, view, viewport);
  if (gesture?.kind === 'draw') drawStroke(context, gesture.stroke, view, viewport);
  clearTimeout(settleTimer);
  if (frame.busy) renderer.invalidate();
  else if (frame.settleIn !== undefined) settleTimer = setTimeout(() => renderer.invalidate(), frame.settleIn + 1);
  if (cameraDirty) {
    save(session, STORAGE_KEYS.camera, camera);
    cameraDirty = false;
  }
});

const palette = new Palette(preferences, {
  change: (next) => {
    preferences = next;
    save(local, STORAGE_KEYS.preferences, preferences);
    updateCursor();
  },
  restoreFocus: () => canvas.focus({ preventScroll: true }),
  undo: () => undo(),
  zoom: (direction) => {
    const center: Point = [viewport.width / 2, viewport.height / 2];
    const zoom = direction === 'reset' ? 1 : zoomOf(camera) * (direction === 'in' ? ZOOM_STEP : 1 / ZOOM_STEP);
    setCamera(zoomAt(camera, zoom, center, viewport));
  },
}, messages, locale);
app.append(palette.element);
palette.setZoom(zoomOf(camera));

const status = document.createElement('p');
status.className = 'error-notice';
status.setAttribute('role', 'status');
status.hidden = true;
app.append(status);
let statusTimeout: ReturnType<typeof setTimeout> | undefined;
const lastNotice = new Map<string, number>();
function notify(message: string, key = message): void {
  // Brief and unobtrusive; the same problem is not repeated every second.
  const now = Date.now();
  if (now - (lastNotice.get(key) ?? -Infinity) < 8000 && !status.hidden) return;
  lastNotice.set(key, now);
  status.textContent = message;
  status.hidden = false;
  clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => { status.hidden = true; }, 5000);
}
function noticeText(notice: Notice): string {
  return messages[notice];
}

function updateCursor(): void {
  canvas.style.cursor = gesture?.kind === 'pan' ? 'grabbing' : space ? 'grab' : toolCursor(preferences.tool);
}

// Smoothed direction of the current pan, used to prefetch ahead of the view.
let heading: Point = [0, 0];
function track(previous: Camera, next: Camera): void {
  if (zoomOf(previous) !== zoomOf(next)) { heading = [0, 0]; return; }
  const dx = next.x - previous.x, dy = next.y - previous.y;
  const length = Math.hypot(dx, dy);
  if (!length) return;
  const hx = heading[0] * 0.7 + (dx / length) * 0.3, hy = heading[1] * 0.7 + (dy / length) * 0.3;
  const norm = Math.hypot(hx, hy) || 1;
  heading = [hx / norm, hy / norm];
}

function setCamera(next: Camera): void {
  track(camera, next);
  camera = next;
  cameraDirty = true;
  palette.setZoom(zoomOf(camera));
  renderer.invalidate();
  if (needsResubscribe(world.area, camera, viewport)) world.setBounds(subscriptionBounds(camera, viewport, heading));
}

function localPoint(event: { clientX: number; clientY: number }): Point {
  const rect = canvas.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

function toWorld(point: Point): Point {
  const [x, y] = screenToWorld(point, camera, viewport);
  return [clampWorld(x), clampWorld(y)];
}

function clearLongPress(): void {
  if (longPress) clearTimeout(longPress.timer);
  longPress = undefined;
}

function releaseGesture(cancel: boolean): void {
  const previous = gesture;
  gesture = undefined;
  clearLongPress();
  if (previous?.kind === 'pan' && cancel) setCamera(previous.camera);
  if (previous && 'pointerId' in previous && canvas.hasPointerCapture(previous.pointerId)) {
    canvas.releasePointerCapture(previous.pointerId);
  }
  renderer.invalidate();
  updateCursor();
}

// The eraser only ever targets our own strokes: the newest unconfirmed one, or
// the confirmed own stroke with the highest seq. The server checks ownership.
function eraseAt(screen: Point): void {
  const point = toWorld(screen);
  const context = renderer.context;
  const pending = world.scene.visiblePending();
  for (let index = pending.length - 1; index >= 0; index--) {
    const draft = pending[index]!;
    if (hitTest(context, draft, point, camera, viewport)) { world.erase(draft.id); return; }
  }
  const strokes = world.scene.strokes();
  const tolerance = 8 / zoomOf(camera);
  const probe = { min_x: point[0] - tolerance, min_y: point[1] - tolerance, max_x: point[0] + tolerance, max_y: point[1] + tolerance };
  for (let index = strokes.length - 1; index >= 0; index--) {
    const stroke = strokes[index]!;
    if (!stroke.own || world.scene.hidden.has(stroke.id) || !intersects(strokeExtent(stroke), probe)) continue;
    if (hitTest(context, stroke, point, camera, viewport)) { world.erase(stroke.id); return; }
  }
}

function commit(stroke: StrokeDraft): void {
  if (!fitsCreateMessage(stroke)) { notify(messages.strokeTooLarge); return; }
  // Completed geometry is immutable from here on (UUID + payload are retried as-is).
  Object.freeze(stroke.points);
  world.create(stroke);
}

function undo(): void {
  if (gesture && gesture.kind !== 'blocked') { releaseGesture(true); return; }
  world.undo();
  renderer.invalidate();
}

function begin(event: PointerEvent): void {
  const point = localPoint(event);
  const type = event.pointerType;
  const { pointerId } = event;
  if (event.button === 1 || space || preferences.tool === 'hand' || (type === 'touch' && penSeen)) {
    gesture = { kind: 'pan', pointerId, type, origin: point, camera: { ...camera } };
  } else if (preferences.tool === 'eraser') {
    gesture = { kind: 'erase', pointerId, type, origin: point, moved: type !== 'touch' };
    // A finger erases on movement or tap, so a long press can open tools instead.
    if (type !== 'touch') eraseAt(point);
  } else {
    gesture = {
      kind: 'draw', pointerId, type,
      stroke: {
        id: newId(), points: [toWorld(point)],
        brush: preferences.brush, width: preferences.width, color: preferences.color, opacity: preferences.opacity,
      },
    };
  }
  try { canvas.setPointerCapture(pointerId); } catch { /* pointer already gone */ }
  if (type === 'touch') startLongPress(event);
  renderer.invalidate();
  updateCursor();
}

function startPinch(): void {
  const ids = [...touches.keys()].slice(0, 2);
  const [a, b] = ids;
  if (a === undefined || b === undefined) return;
  // The second finger cancels an unfinished stroke: nothing is sent, nothing
  // enters undo. A one-finger pan simply continues as a pinch.
  releaseGesture(false);
  gesture = { kind: 'pinch', a, b, a0: touches.get(a)!, b0: touches.get(b)!, camera: { ...camera } };
  renderer.invalidate();
  updateCursor();
}

function startLongPress(event: PointerEvent): void {
  clearLongPress();
  const { pointerId, clientX, clientY } = event;
  const origin = localPoint(event);
  const timer = setTimeout(() => {
    longPress = undefined;
    if (touches.size !== 1 || !touches.has(pointerId)) return;
    // Opening tools discards the initial dot / undoes the tiny pan.
    releaseGesture(true);
    gesture = { kind: 'blocked' };
    palette.open(clientX, clientY, false);
  }, LONG_PRESS_MS);
  longPress = { timer, pointerId, origin };
}

function gesturePointer(g: Gesture | undefined): number | undefined {
  return g && 'pointerId' in g ? g.pointerId : undefined;
}

canvas.addEventListener('pointerdown', (event) => {
  const touch = event.pointerType === 'touch';
  if (!touch && event.button !== 0 && event.button !== 1) return;
  event.preventDefault();
  if (touch) {
    // The first finger of a new touch sequence: no other finger can still be
    // down, so drop any touch whose lift we never saw (self-healing only; the
    // multi-touch model itself does not rely on isPrimary).
    if (event.isPrimary && touches.size) {
      touches.clear();
      if (gesture?.kind === 'pinch' || gesture?.kind === 'blocked') gesture = undefined;
      // An unfinished finger stroke of a vanished finger is discarded, never sent.
      // isPrimary is per pointer type, so a pen stroke in progress is kept.
      else if (gesture && gesture.type === 'touch') releaseGesture(true);
    }
    touches.set(event.pointerId, localPoint(event));
  }
  if (palette.isOpen) {
    palette.close(!touch);
    if (touch) gesture ??= { kind: 'blocked' };
    return;
  }
  if (event.pointerType === 'pen') {
    penSeen = true;
    // The pen wins over any finger gesture in progress.
    if (gesture && (gesture.kind === 'pinch' || gesture.kind === 'blocked' || gesture.type === 'touch')) releaseGesture(false);
  }
  if (touch) {
    const active = gesture;
    // A pen/mouse stroke in progress ignores fingers and palms.
    if (active && 'type' in active && active.type !== 'touch') return;
    if (touches.size >= 2) {
      if (active?.kind !== 'pinch') startPinch();
      return;
    }
    if (active) return;
  } else if (gesture) return;
  if (!touch) canvas.focus({ preventScroll: true });
  begin(event);
});

canvas.addEventListener('pointermove', (event) => {
  const id = event.pointerId;
  if (event.pointerType !== 'touch') {
    const point = localPoint(event);
    if (space && !gesture && hover && !palette.isOpen) setCamera(panScreen(camera, hover[0] - point[0], hover[1] - point[1]));
    hover = point;
  }
  if (event.pointerType === 'touch' && touches.has(id)) touches.set(id, localPoint(event));
  if (longPress?.pointerId === id) {
    const [x, y] = localPoint(event);
    if (Math.hypot(x - longPress.origin[0], y - longPress.origin[1]) > TOUCH_SLOP) clearLongPress();
  }
  if (gesture?.kind === 'pinch') {
    const a1 = touches.get(gesture.a);
    const b1 = touches.get(gesture.b);
    if (a1 && b1 && (id === gesture.a || id === gesture.b)) setCamera(pinch(gesture.camera, gesture.a0, gesture.b0, a1, b1, viewport));
    return;
  }
  if (!gesture || gesturePointer(gesture) !== id) return;
  if (gesture.kind === 'pan') {
    const [x, y] = localPoint(event);
    setCamera(panScreen(gesture.camera, gesture.origin[0] - x, gesture.origin[1] - y));
  } else if (gesture.kind === 'draw') {
    const coalesced = event.getCoalescedEvents?.() ?? [];
    for (const sample of coalesced.length ? coalesced : [event]) appendPoint(gesture.stroke.points, toWorld(localPoint(sample)));
    renderer.invalidate();
  } else if (gesture.kind === 'erase') {
    const point = localPoint(event);
    if (!gesture.moved && Math.hypot(point[0] - gesture.origin[0], point[1] - gesture.origin[1]) <= TOUCH_SLOP) return;
    gesture.moved = true;
    const coalesced = event.getCoalescedEvents?.() ?? [];
    for (const sample of coalesced.length ? coalesced : [event]) eraseAt(localPoint(sample));
  }
});

function endTouch(id: number): boolean {
  touches.delete(id);
  if (longPress?.pointerId === id) clearLongPress();
  if (gesture?.kind === 'pinch') {
    if (id === gesture.a || id === gesture.b) gesture = touches.size ? { kind: 'blocked' } : undefined;
    return true;
  }
  if (gesture?.kind === 'blocked') {
    if (touches.size === 0) gesture = undefined;
    return true;
  }
  return false;
}

canvas.addEventListener('pointerup', (event) => {
  const touch = event.pointerType === 'touch';
  if (touch && endTouch(event.pointerId)) return;
  if (!gesture || gesturePointer(gesture) !== event.pointerId) return;
  // Do not complete a left-button gesture when an unrelated mouse button is released.
  if (!touch && event.buttons !== 0) return;
  if (gesture.kind === 'draw') {
    appendPoint(gesture.stroke.points, toWorld(localPoint(event)), true);
    commit(gesture.stroke);
  } else if (gesture.kind === 'erase' && !gesture.moved) {
    eraseAt(localPoint(event));
  }
  releaseGesture(false);
});

function cancelPointer(event: PointerEvent): void {
  if (event.pointerType === 'touch' && endTouch(event.pointerId)) return;
  if (gesturePointer(gesture) === event.pointerId) releaseGesture(true);
}
canvas.addEventListener('pointercancel', cancelPointer);
// After a long press the capture is released and the palette opens under the
// finger, so its lift is delivered to the palette, not the canvas. Forget the
// finger wherever it is lifted; otherwise it would count as still down and
// turn the next single touch into a pinch (and break long press).
function liftElsewhere(event: PointerEvent): void {
  if (event.pointerType !== 'touch' || event.target === canvas || !touches.has(event.pointerId)) return;
  if (!endTouch(event.pointerId) && gesturePointer(gesture) === event.pointerId) releaseGesture(true);
}
window.addEventListener('pointerup', liftElsewhere);
window.addEventListener('pointercancel', liftElsewhere);
// Re-entering the canvas must not jump by the distance travelled outside it.
canvas.addEventListener('pointerleave', (event) => { if (event.pointerType !== 'touch') hover = undefined; });
canvas.addEventListener('lostpointercapture', (event) => {
  // Touch ends release capture implicitly; pointerup has already run then.
  if (gesturePointer(gesture) === event.pointerId) releaseGesture(true);
});
canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  releaseGesture(true);
  if (touches.size) gesture = { kind: 'blocked' };
  space = false;
  updateCursor();
  palette.open(event.clientX || viewport.width / 2, event.clientY || viewport.height / 2);
});
canvas.addEventListener('auxclick', (event) => { if (event.button === 1) event.preventDefault(); });
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (palette.isOpen) return;
  releaseGesture(true);
  // Trackpad pinch arrives as ctrl+wheel in Chromium/Firefox.
  if (event.ctrlKey || event.metaKey) {
    const [, dy] = wheelPixels(0, event.deltaY, event.deltaMode, viewport);
    setCamera(zoomAt(camera, zoomOf(camera) * wheelZoomFactor(dy), localPoint(event), viewport));
    return;
  }
  const [dx, dy] = wheelPixels(event.deltaX, event.deltaY, event.deltaMode, viewport);
  setCamera(panScreen(camera, dx, dy));
}, { passive: false });

// Safari (macOS trackpad / iOS) pinch: non-standard GestureEvent. Page zoom is
// always suppressed; on touch screens pointer events drive the pinch instead.
type SafariGesture = Event & { scale: number; clientX: number; clientY: number };
let gestureZoom: number | undefined;
window.addEventListener('gesturestart', (event) => {
  event.preventDefault();
  if (touches.size || palette.isOpen) return;
  releaseGesture(true);
  gestureZoom = zoomOf(camera);
}, { passive: false } as AddEventListenerOptions);
window.addEventListener('gesturechange', (event) => {
  event.preventDefault();
  const g = event as SafariGesture;
  if (gestureZoom === undefined || touches.size || !Number.isFinite(g.scale)) return;
  setCamera(zoomAt(camera, gestureZoom * g.scale, localPoint(g), viewport));
}, { passive: false } as AddEventListenerOptions);
window.addEventListener('gestureend', (event) => {
  event.preventDefault();
  gestureZoom = undefined;
}, { passive: false } as AddEventListenerOptions);

function keyboardInCanvas(event: KeyboardEvent): boolean {
  if (palette.isOpen) return false;
  const target = event.target;
  return target === canvas || target === document.body || target === document.documentElement;
}

window.addEventListener('keydown', (event) => {
  // WebKit may leave focus on body after a mouse click on a palette button.
  // Escape must still dismiss the palette even when the event is outside it.
  if (event.key === 'Escape' && palette.isOpen) {
    event.preventDefault();
    palette.close();
    return;
  }
  if (!keyboardInCanvas(event)) return;
  const command = event.ctrlKey || event.metaKey;
  if (event.key === 'Escape') {
    releaseGesture(true);
    space = false;
    updateCursor();
  } else if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
    event.preventDefault();
    releaseGesture(true);
    space = false;
    updateCursor();
    palette.open(viewport.width / 2, viewport.height / 2);
  } else if (event.code === 'Space' && !command && !event.altKey) {
    event.preventDefault();
    space = true;
    updateCursor();
  } else if (command && !event.shiftKey && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undo();
  } else if (command && !event.altKey && (event.key === '=' || event.key === '+' || event.key === '-' || event.key === '0')) {
    // Canvas zoom instead of browser page zoom while the canvas has focus.
    event.preventDefault();
    const center: Point = [viewport.width / 2, viewport.height / 2];
    const zoom = event.key === '0' ? 1 : zoomOf(camera) * (event.key === '-' ? 1 / ZOOM_STEP : ZOOM_STEP);
    setCamera(zoomAt(camera, zoom, center, viewport));
  }
});
window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') {
    space = false;
    updateCursor();
  }
});

function suspend(): void {
  releaseGesture(true);
  touches.clear();
  space = false;
  palette.close(false);
  updateCursor();
  save(session, STORAGE_KEYS.camera, camera);
}
window.addEventListener('blur', suspend);
window.addEventListener('pagehide', suspend);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) suspend();
  else world.wake();
});
window.addEventListener('online', () => world.wake());
window.addEventListener('pageshow', () => world.wake());

function resize(): void {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  renderer.resize(viewport, window.devicePixelRatio || 1);
  if (needsResubscribe(world.area, camera, viewport)) world.setBounds(subscriptionBounds(camera, viewport, heading));
}
window.addEventListener('resize', () => {
  releaseGesture(true);
  resize();
});

// A DPR change can occur without a window resize when moving between displays.
let dprQuery: MediaQueryList | undefined;
function watchDpr(): void {
  dprQuery?.removeEventListener('change', onDprChange);
  dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  dprQuery.addEventListener('change', onDprChange, { once: true });
}
function onDprChange(): void { resize(); watchDpr(); }
watchDpr();
save(session, STORAGE_KEYS.camera, camera);
resize();
updateCursor();
world.start(subscriptionBounds(camera, viewport));
