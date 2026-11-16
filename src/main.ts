import './style.css';
import { resolveLocale, translations } from './i18n';
import { clampWorld, pan, screenToWorld, wheelPixels, type Camera, type Viewport } from './camera';
import { appendPoint, fitsCreateMessage, type Point, type StrokeDraft } from './model';
import { Palette, toolCursor } from './palette';
import { drawStroke, hitTest, Renderer } from './renderer';
import { browserStorage, loadCamera, loadPreferences, save, STORAGE_KEYS } from './storage';

type Gesture =
  | { kind: 'draw'; pointerId: number; stroke: StrokeDraft }
  | { kind: 'pan'; pointerId: number; origin: Point; camera: Camera };

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
let cameraDirty = false;

// Prototype-only, ephemeral drawings. These are NOT server-confirmed objects,
// NOT a persistent undo stack, and are never assigned a fake server seq/own.
const localDrafts: StrokeDraft[] = [];
const MAX_LOCAL_DRAFTS = 500;

const renderer = new Renderer(canvas, () => {
  for (const stroke of localDrafts) drawStroke(renderer.context, stroke, camera, viewport);
  if (gesture?.kind === 'draw') drawStroke(renderer.context, gesture.stroke, camera, viewport);
  if (cameraDirty) {
    save(session, STORAGE_KEYS.camera, camera);
    cameraDirty = false;
  }
});

const palette = new Palette(preferences, (next) => {
  preferences = next;
  save(local, STORAGE_KEYS.preferences, preferences);
  updateCursor();
}, () => canvas.focus({ preventScroll: true }), messages, locale);
app.append(palette.element);

const status = document.createElement('p');
status.className = 'error-notice';
status.setAttribute('role', 'status');
status.hidden = true;
app.append(status);
let statusTimeout: ReturnType<typeof setTimeout> | undefined;
function notify(message: string): void {
  status.textContent = message;
  status.hidden = false;
  clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => { status.hidden = true; }, 5000);
}

function updateCursor(): void {
  canvas.style.cursor = gesture?.kind === 'pan' ? 'grabbing' : space ? 'grab' : toolCursor(preferences.tool);
}

function setCamera(next: Camera): void {
  camera = next;
  cameraDirty = true;
  renderer.invalidate();
}

function localPoint(event: PointerEvent): Point {
  const rect = canvas.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

function worldPoint(event: PointerEvent): Point {
  const [x, y] = screenToWorld(localPoint(event), camera, viewport);
  return [clampWorld(x), clampWorld(y)];
}

function releaseGesture(cancel: boolean): void {
  const previous = gesture;
  gesture = undefined;
  if (previous?.kind === 'pan' && cancel) setCamera(previous.camera);
  if (previous && canvas.hasPointerCapture(previous.pointerId)) canvas.releasePointerCapture(previous.pointerId);
  renderer.invalidate();
  updateCursor();
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'touch' || (event.button !== 0 && event.button !== 1)) return;
  event.preventDefault();
  if (palette.isOpen) { palette.close(); return; }
  if (gesture) return;
  canvas.focus({ preventScroll: true });
  if (event.button === 1 || space || preferences.tool === 'hand') {
    gesture = { kind: 'pan', pointerId: event.pointerId, origin: localPoint(event), camera: { ...camera } };
  } else if (preferences.tool === 'eraser') {
    const point = worldPoint(event);
    // In this local prototype all drafts belong to this page. Server-backed
    // selection will use only confirmed own:true strokes, ordered by seq.
    const index = localDrafts.findLastIndex((stroke) => hitTest(renderer.context, stroke, point, camera, viewport));
    if (index !== -1) localDrafts.splice(index, 1);
    renderer.invalidate();
    return;
  } else {
    gesture = {
      kind: 'draw', pointerId: event.pointerId,
      stroke: {
        id: crypto.randomUUID(), points: [worldPoint(event)],
        brush: preferences.brush, width: preferences.width, color: preferences.color, opacity: preferences.opacity,
      },
    };
  }
  canvas.setPointerCapture(event.pointerId);
  renderer.invalidate();
  updateCursor();
});

canvas.addEventListener('pointermove', (event) => {
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  if (gesture.kind === 'pan') {
    const [x, y] = localPoint(event);
    setCamera(pan(gesture.camera, gesture.origin[0] - x, gesture.origin[1] - y));
  } else {
    const coalesced = event.getCoalescedEvents?.() ?? [];
    for (const sample of coalesced.length ? coalesced : [event]) appendPoint(gesture.stroke.points, worldPoint(sample));
    renderer.invalidate();
  }
});

canvas.addEventListener('pointerup', (event) => {
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  // Do not complete a left-button gesture when an unrelated button is released.
  if (event.buttons !== 0) return;
  if (gesture.kind === 'draw') {
    appendPoint(gesture.stroke.points, worldPoint(event), true);
    if (localDrafts.length >= MAX_LOCAL_DRAFTS) {
      notify(messages.localLimit(MAX_LOCAL_DRAFTS));
    } else if (!fitsCreateMessage(gesture.stroke)) {
      notify(messages.strokeTooLarge);
    } else {
      localDrafts.push(gesture.stroke);
    }
  }
  releaseGesture(false);
});

canvas.addEventListener('pointercancel', (event) => {
  if (gesture?.pointerId === event.pointerId) releaseGesture(true);
});
canvas.addEventListener('lostpointercapture', (event) => {
  if (gesture?.pointerId === event.pointerId) releaseGesture(true);
});
canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  releaseGesture(true);
  space = false;
  updateCursor();
  palette.open(event.clientX || viewport.width / 2, event.clientY || viewport.height / 2);
});
canvas.addEventListener('auxclick', (event) => { if (event.button === 1) event.preventDefault(); });
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (palette.isOpen) return;
  releaseGesture(true);
  const [dx, dy] = wheelPixels(event.deltaX, event.deltaY, event.deltaMode, viewport);
  setCamera(pan(camera, dx, dy));
}, { passive: false });

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
  } else if (event.code === 'Space' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    space = true;
    updateCursor();
  } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (gesture) releaseGesture(true);
    else {
      localDrafts.pop();
      renderer.invalidate();
    }
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
  space = false;
  palette.close(false);
  updateCursor();
  save(session, STORAGE_KEYS.camera, camera);
}
window.addEventListener('blur', suspend);
window.addEventListener('pagehide', suspend);
document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); });

function resize(): void {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  renderer.resize(viewport, window.devicePixelRatio || 1);
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
