// Reports and local hiding, the same as the iPad app (App Review 1.2 parity).
// Wire: ../endless-drawing-backend/docs/protocol-v5-safety.md; product: docs/ugc-safety.md.
import type { Stroke } from './model';

export const REPORT_REASONS = ['sexual', 'violence', 'hate', 'illegal', 'spam', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
/** Protocol maximum of stroke ids in one stroke.report. */
export const MAX_REPORT_STROKES = 20;
const MAX_HIDDEN_STROKES = 5000;
const MAX_HIDDEN_AUTHORS = 1000;

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);
}

/**
 * Reported strokes and blocked authors, hidden on this device only. Stroke ids
 * are global and kept in localStorage; author tags are per viewer secret, which
 * lives in sessionStorage, so blocked authors share that lifetime.
 */
export class HiddenContent {
  private readonly strokes: string[];
  private readonly authors: string[];
  private readonly strokeSet: Set<string>;
  private readonly authorSet: Set<string>;

  constructor(strokes: readonly string[] = [], authors: readonly string[] = []) {
    this.strokes = [...new Set(strokes)].slice(-MAX_HIDDEN_STROKES);
    this.authors = [...new Set(authors)].slice(-MAX_HIDDEN_AUTHORS);
    this.strokeSet = new Set(this.strokes);
    this.authorSet = new Set(this.authors);
  }

  get isEmpty(): boolean { return this.strokes.length === 0 && this.authors.length === 0; }
  get storedStrokes(): readonly string[] { return this.strokes; }
  get storedAuthors(): readonly string[] { return this.authors; }

  hides(stroke: Pick<Stroke, 'id' | 'author'>): boolean {
    return this.strokeSet.has(stroke.id) || (stroke.author !== undefined && this.authorSet.has(stroke.author));
  }

  /** Oldest entries are forgotten first when a cap is reached. */
  hide(strokes: readonly string[], authors: readonly string[]): HiddenContent {
    return new HiddenContent([...this.strokes, ...strokes], [...this.authors, ...authors]);
  }
}

export interface ReportTarget { id: string; author: string | undefined }

/** Adds or removes a target; the selection never exceeds the protocol maximum. */
export function toggleTarget(selection: readonly ReportTarget[], target: ReportTarget): ReportTarget[] {
  if (selection.some((item) => item.id === target.id)) return selection.filter((item) => item.id !== target.id);
  return selection.length < MAX_REPORT_STROKES ? [...selection, target] : [...selection];
}

/** Explicit menu choice wins; otherwise fingers draw until a pen is first used (as on iPad). */
export function fingersDraw(choice: boolean | undefined, penSeen: boolean): boolean {
  return choice ?? !penSeen;
}
