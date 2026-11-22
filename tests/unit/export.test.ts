import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SELECTION, exportFileName, exportSize, frameFor, inFrame, isEmptySelection, MAX_EXPORT_PIXELS, MAX_EXPORT_SIDE,
  normalizeFrame, selectStrokes, toggleAuthor,
} from '../../src/export';
import { translations } from '../../src/i18n';
import type { Point, Stroke, StrokeDraft } from '../../src/model';

const TAG_A = 'aaaaaaaaaaaaaaaaaaaaaa';
const TAG_B = 'bbbbbbbbbbbbbbbbbbbbbb';

function stroke(id: string, seq: number, own: boolean, author: string | undefined, points: Point[] = [[0, 0], [10, 0]], width = 4): Stroke {
  return { id, seq, own, ...(author ? { author } : {}), points, brush: 'round', width, color: '#202020', opacity: 1 };
}

const mine = stroke('m', 3, true, 'mmmmmmmmmmmmmmmmmmmmmm');
const a1 = stroke('a1', 1, false, TAG_A);
const b1 = stroke('b1', 2, false, TAG_B);
const a2 = stroke('a2', 4, false, TAG_A);
const ordered = [a1, b1, mine, a2];
const pending: StrokeDraft = { id: 'p', points: [[1, 1]], brush: 'round', width: 4, color: '#202020', opacity: 1 };
const visible = () => false;

describe('export selection', () => {
  it('starts with my strokes and toggles mine or another author by tapping their stroke', () => {
    expect(DEFAULT_SELECTION).toEqual({ own: true, authors: [] });
    let selection = toggleAuthor(DEFAULT_SELECTION, a2);
    expect(selection).toEqual({ own: true, authors: [TAG_A] });
    selection = toggleAuthor(selection, b1);
    selection = toggleAuthor(selection, mine);
    expect(selection).toEqual({ own: false, authors: [TAG_A, TAG_B] });
    selection = toggleAuthor(selection, a1);
    expect(selection).toEqual({ own: false, authors: [TAG_B] });
    expect(isEmptySelection(toggleAuthor(selection, b1))).toBe(true);
  });

  it('cannot pick an author without a v5 tag', () => {
    const untagged = stroke('x', 9, false, undefined);
    expect(toggleAuthor(DEFAULT_SELECTION, untagged)).toBe(DEFAULT_SELECTION);
    expect(selectStrokes([untagged], [], { own: true, authors: [] }, visible)).toEqual([]);
  });

  it('keeps only the chosen authors in canvas order, my pending strokes on top', () => {
    expect(selectStrokes(ordered, [pending], DEFAULT_SELECTION, visible)).toEqual([mine, pending]);
    expect(selectStrokes(ordered, [pending], { own: false, authors: [TAG_A] }, visible)).toEqual([a1, a2]);
    expect(selectStrokes(ordered, [pending], { own: true, authors: [TAG_A] }, visible)).toEqual([a1, mine, a2, pending]);
    expect(selectStrokes(ordered, [pending], { own: false, authors: [] }, visible)).toEqual([]);
  });

  it('never exports hidden strokes (reported, blocked author, delete in flight)', () => {
    const hidden = (s: Stroke) => s.id === 'a1';
    expect(selectStrokes(ordered, [], { own: false, authors: [TAG_A] }, hidden)).toEqual([a2]);
  });
});

describe('export frame', () => {
  it('wraps the brush extent with at least a 16 unit margin', () => {
    // round width 4: extent pad = 4/2 + 1 = 3
    expect(frameFor([stroke('s', 1, true, undefined, [[0, 0], [100, 50]])])).toEqual({ min_x: -19, min_y: -19, max_x: 119, max_y: 69 });
    expect(frameFor([])).toBeUndefined();
  });

  it('grows the margin with the drawing and accounts for square brushes', () => {
    const big = { ...stroke('s', 1, true, undefined, [[0, 0], [1000, 0]], 10), brush: 'square' as const };
    const pad = 10 / Math.SQRT2 + 1;
    const margin = (1000 + 2 * pad) * 0.04;
    const frame = frameFor([big])!;
    expect(frame.min_x).toBeCloseTo(-pad - margin);
    expect(frame.max_y).toBeCloseTo(pad + margin);
  });

  it('normalizes a dragged frame and keeps a minimum size', () => {
    expect(normalizeFrame([10, 20], [-10, -20])).toEqual({ min_x: -10, min_y: -20, max_x: 10, max_y: 20 });
    expect(normalizeFrame([5, 5], [5, 6])).toEqual({ min_x: 1, min_y: 1.5, max_x: 9, max_y: 9.5 });
  });

  it('keeps strokes that touch the frame and drops those entirely outside', () => {
    const inside = stroke('i', 1, true, undefined, [[0, 0]]);
    const edge = stroke('e', 2, true, undefined, [[52, 0]]);
    const outside = stroke('o', 3, true, undefined, [[100, 0]]);
    expect(inFrame([inside, edge, outside], { min_x: -50, min_y: -50, max_x: 50, max_y: 50 })).toEqual([inside, edge]);
  });
});

describe('export size', () => {
  it('multiplies the frame by the chosen scale', () => {
    expect(exportSize({ min_x: 0, min_y: 0, max_x: 300.5, max_y: 200 }, 2)).toEqual({ width: 601, height: 400, scale: 2 });
  });

  it('lowers the scale to stay within the area and side limits of a 2D canvas', () => {
    const wide = exportSize({ min_x: 0, min_y: 0, max_x: 30_000, max_y: 100 }, 4);
    expect(wide.width).toBeLessThanOrEqual(MAX_EXPORT_SIDE);
    expect(wide.scale).toBeCloseTo(MAX_EXPORT_SIDE / 30_000);
    const square = exportSize({ min_x: 0, min_y: 0, max_x: 10_000, max_y: 10_000 }, 4);
    expect(square.width * square.height).toBeLessThanOrEqual(MAX_EXPORT_PIXELS);
    expect(square.width).toBe(4096);
  });
});

describe('export naming and texts', () => {
  it('names the file by the rounded frame centre without negative zero', () => {
    expect(exportFileName({ min_x: -10.4, min_y: -0.8, max_x: 10, max_y: 0 })).toBe('endless-drawing_0_0.png');
    expect(exportFileName({ min_x: -3002, min_y: 10, max_x: -1000, max_y: 20 })).toBe('endless-drawing_-2001_15.png');
  });

  it('summarizes the selection in English and Russian plurals', () => {
    expect(translations.en.exportSummary(true, 0)).toBe('My drawings');
    expect(translations.en.exportSummary(true, 1)).toBe('My drawings + 1 author');
    expect(translations.en.exportSummary(false, 2)).toBe('2 authors');
    expect(translations.en.exportSummary(false, 0)).toBe('Nothing selected');
    expect([1, 2, 5, 11, 21, 22, 112].map((n) => translations.ru.exportSummary(false, n))).toEqual(
      ['1 автор', '2 автора', '5 авторов', '11 авторов', '21 автор', '22 автора', '112 авторов']);
    expect(translations.ru.exportSummary(true, 3)).toBe('Мои рисунки + 3 автора');
  });
});
