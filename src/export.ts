// PNG export of chosen authors only. Everything here is client-side: the v5/v6
// `author` tag is stable per (viewer, author), `own` marks our strokes, and the
// public eraser deletes whole strokes, so a filtered set renders exactly as it
// does on the canvas minus everybody else.
import { drawProjected } from './renderer';
import { strokeExtent, type Extent, type Stroke, type StrokeDraft } from './model';

/** Whose strokes go into the file: ours (`own`) and/or other authors by tag. */
export interface ExportSelection {
  readonly own: boolean;
  readonly authors: readonly string[];
}

export type ExportBackground = 'transparent' | 'white';
export const EXPORT_SCALES = [1, 2, 4] as const;
export type ExportScale = typeof EXPORT_SCALES[number];

/** Safari/iPadOS refuse larger 2D canvases (area), every engine caps a side. */
export const MAX_EXPORT_PIXELS = 16_777_216;
export const MAX_EXPORT_SIDE = 16_384;
const MIN_MARGIN = 16;
const MARGIN_SHARE = 0.04;
const MIN_FRAME = 8;

export const DEFAULT_SELECTION: ExportSelection = { own: true, authors: [] };

/** A tap on our stroke toggles "mine"; on someone else's, toggles that author. */
export function toggleAuthor(selection: ExportSelection, stroke: Pick<Stroke, 'own' | 'author'>): ExportSelection {
  if (stroke.own) return { ...selection, own: !selection.own };
  const author = stroke.author;
  if (author === undefined) return selection; // pre-v5 profile: other authors cannot be told apart
  return selection.authors.includes(author)
    ? { ...selection, authors: selection.authors.filter((tag) => tag !== author) }
    : { ...selection, authors: [...selection.authors, author] };
}

export function isEmptySelection(selection: ExportSelection): boolean {
  return !selection.own && selection.authors.length === 0;
}

export function includes(selection: ExportSelection, stroke: Pick<Stroke, 'own' | 'author'>): boolean {
  if (stroke.own) return selection.own;
  return stroke.author !== undefined && selection.authors.includes(stroke.author);
}

/**
 * Selected strokes in the order the canvas draws them: confirmed by seq, then
 * our unacknowledged creates (only when "mine" is selected) on top.
 */
export function selectStrokes(
  strokes: readonly Stroke[], pending: readonly StrokeDraft[], selection: ExportSelection,
  isHidden: (stroke: Stroke) => boolean,
): StrokeDraft[] {
  const result: StrokeDraft[] = strokes.filter((stroke) => !isHidden(stroke) && includes(selection, stroke));
  if (selection.own) result.push(...pending);
  return result;
}

/** The union of stroke extents (brush width included) plus a proportional margin. */
export function frameFor(strokes: readonly Pick<StrokeDraft, 'points' | 'brush' | 'width'>[]): Extent | undefined {
  let min_x = Infinity, min_y = Infinity, max_x = -Infinity, max_y = -Infinity;
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    const e = strokeExtent(stroke);
    if (e.min_x < min_x) min_x = e.min_x; if (e.max_x > max_x) max_x = e.max_x;
    if (e.min_y < min_y) min_y = e.min_y; if (e.max_y > max_y) max_y = e.max_y;
  }
  if (min_x > max_x) return undefined;
  const margin = Math.max(MIN_MARGIN, Math.max(max_x - min_x, max_y - min_y) * MARGIN_SHARE);
  return { min_x: min_x - margin, min_y: min_y - margin, max_x: max_x + margin, max_y: max_y + margin };
}

/** Normalizes a frame dragged by its corners and keeps it from collapsing. */
export function normalizeFrame(a: readonly [number, number], b: readonly [number, number]): Extent {
  let min_x = Math.min(a[0], b[0]), max_x = Math.max(a[0], b[0]);
  let min_y = Math.min(a[1], b[1]), max_y = Math.max(a[1], b[1]);
  if (max_x - min_x < MIN_FRAME) { const c = (min_x + max_x) / 2; min_x = c - MIN_FRAME / 2; max_x = c + MIN_FRAME / 2; }
  if (max_y - min_y < MIN_FRAME) { const c = (min_y + max_y) / 2; min_y = c - MIN_FRAME / 2; max_y = c + MIN_FRAME / 2; }
  return { min_x, min_y, max_x, max_y };
}

export interface ExportSize { width: number; height: number; scale: number }

/** Pixel size for a frame; the scale is lowered as needed to stay within canvas limits. */
export function exportSize(frame: Extent, requested: number): ExportSize {
  const w = frame.max_x - frame.min_x, h = frame.max_y - frame.min_y;
  let scale = requested;
  scale = Math.min(scale, MAX_EXPORT_SIDE / w, MAX_EXPORT_SIDE / h, Math.sqrt(MAX_EXPORT_PIXELS / (w * h)));
  const width = Math.max(1, Math.min(MAX_EXPORT_SIDE, Math.floor(w * scale)));
  const height = Math.max(1, Math.min(MAX_EXPORT_SIDE, Math.floor(h * scale)));
  return { width, height, scale };
}

/** Strokes that touch the frame at all; parts outside are clipped by the canvas. */
export function inFrame<T extends Pick<StrokeDraft, 'points' | 'brush' | 'width'>>(strokes: readonly T[], frame: Extent): T[] {
  return strokes.filter((stroke) => {
    if (!stroke.points.length) return false;
    const e = strokeExtent(stroke);
    return e.min_x <= frame.max_x && e.max_x >= frame.min_x && e.min_y <= frame.max_y && e.max_y >= frame.min_y;
  });
}

/** Draws into any 2D context: target pixel = (world − frame origin) × scale. */
export function paintExport(
  context: CanvasRenderingContext2D, strokes: readonly StrokeDraft[], frame: Extent, scale: number,
  background: ExportBackground,
): void {
  const { width, height } = context.canvas;
  context.clearRect(0, 0, width, height);
  if (background === 'white') {
    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, width, height);
  }
  for (const stroke of strokes) drawProjected(context, stroke, scale, frame.min_x, frame.min_y);
}

/** Renders the PNG; resolves undefined when the browser cannot allocate or encode it. */
export async function renderPNG(
  strokes: readonly StrokeDraft[], frame: Extent, requested: number, background: ExportBackground,
): Promise<Blob | undefined> {
  const size = exportSize(frame, requested);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  paintExport(context, inFrame(strokes, frame), frame, size.scale, background);
  const blob = await new Promise<Blob | null>((resolve) => {
    try { canvas.toBlob(resolve, 'image/png'); } catch { resolve(null); }
  });
  canvas.width = canvas.height = 0; // free the backing store right away (Safari keeps it otherwise)
  return blob ?? undefined;
}

/** `endless-drawing_<x>_<y>.png` from the frame centre in whole world units, ASCII minus, no -0. */
export function exportFileName(frame: Extent): string {
  const integer = (value: number): string => {
    const magnitude = Math.round(Math.abs(value));
    return value < 0 && magnitude !== 0 ? `-${magnitude}` : String(magnitude);
  };
  return `endless-drawing_${integer((frame.min_x + frame.max_x) / 2)}_${integer((frame.min_y + frame.max_y) / 2)}.png`;
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  // Safari starts the download asynchronously; revoking at once can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
