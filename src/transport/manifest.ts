import type { Stroke } from '../model';
import { parseStroke, ProtocolError, uuid } from '../wire';

export const MAX_MANIFEST_STROKES = 20_000;
export const MAX_MANIFEST_POINTS = 1_000_000;
const FETCH_BATCH = 1000;

interface ManifestOptions {
  get(id: string): Stroke | undefined;
  retain(strokes: readonly Stroke[]): void;
  send(message: Record<string, unknown>): void;
}

/** One subscription's authoritative ids; geometry references are pinned in scene staging. */
export class ManifestLoader {
  private subscription = '';
  private phase: 'none' | 'begin' | 'manifest' | 'fetch' = 'none';
  private token = '';
  private count = 0;
  private pointCount = 0;
  private points = 0;
  private readonly ids = new Set<string>();
  private missing: string[] = [];
  private readonly expected = new Set<string>();
  private offset = 0;
  private batch = 0;
  private final = false;

  constructor(private readonly options: ManifestOptions) {}

  start(subscription: string, cached: boolean): void {
    this.subscription = subscription;
    this.phase = cached ? 'begin' : 'none';
    this.token = ''; this.count = 0; this.pointCount = 0; this.points = 0; this.ids.clear(); this.missing = [];
    this.expected.clear(); this.offset = 0; this.batch = 0; this.final = false;
  }

  /** True for messages consumed here; ordinary snapshot begin/end still reach the scene. */
  accept(message: Record<string, unknown>): boolean {
    if (message.subscription_id !== this.subscription || this.phase === 'none') return false;
    if (message.type === 'viewport.manifest.begin') {
      if (this.phase !== 'begin' || this.token) throw new ProtocolError();
      const count = message.stroke_count, points = message.point_count;
      if (!Number.isInteger(count) || (count as number) < 0 || (count as number) > MAX_MANIFEST_STROKES ||
          !Number.isInteger(points) || (points as number) < (count as number) ||
          (points as number) > Math.min(MAX_MANIFEST_POINTS, (count as number) * 2000)) throw new ProtocolError();
      this.token = uuid(message.snapshot_token); this.count = count as number; this.pointCount = points as number; this.phase = 'manifest';
      return true;
    }
    if (message.type === 'viewport.manifest.chunk') {
      this.checkToken(message, 'manifest');
      if (!Array.isArray(message.stroke_ids) || message.stroke_ids.length > FETCH_BATCH) throw new ProtocolError();
      const ids = message.stroke_ids.map(uuid);
      for (const id of ids) {
        if (this.ids.has(id) || this.ids.size >= this.count) throw new ProtocolError();
        this.ids.add(id);
      }
      return true;
    }
    if (message.type === 'viewport.manifest.end') {
      this.checkToken(message, 'manifest');
      if (this.ids.size !== this.count) throw new ProtocolError();
      const retained: Stroke[] = [];
      for (const id of this.ids) {
        const cached = this.options.get(id);
        if (cached) { retained.push(cached); this.points += cached.points.length; } else this.missing.push(id);
      }
      this.options.retain(retained);
      this.phase = 'fetch'; this.sendBatch();
      return true;
    }
    if (message.type === 'viewport.snapshot.chunk') {
      if (this.phase !== 'fetch' || !Array.isArray(message.strokes)) throw new ProtocolError();
      const strokes = message.strokes.map(parseStroke);
      const seen = new Set<string>();
      for (const stroke of strokes) {
        if (!this.expected.has(stroke.id) || seen.has(stroke.id)) throw new ProtocolError();
        seen.add(stroke.id);
      }
      this.points += strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
      if (this.points > this.pointCount) throw new ProtocolError();
      this.options.retain(strokes);
      for (const id of seen) this.expected.delete(id);
      return true;
    }
    if (message.type === 'viewport.fetch.end') {
      this.checkToken(message, 'fetch');
      if (message.batch !== this.batch || this.final || this.expected.size) throw new ProtocolError();
      this.batch++; this.sendBatch(); return true;
    }
    if (message.type === 'viewport.snapshot.end') {
      if (this.phase !== 'fetch' || !this.final || this.expected.size || this.points !== this.pointCount) throw new ProtocolError();
      this.start('', false);
    }
    return false;
  }

  private checkToken(message: Record<string, unknown>, phase: 'manifest' | 'fetch'): void {
    if (this.phase !== phase || message.snapshot_token !== this.token) throw new ProtocolError();
  }

  private sendBatch(): void {
    const ids = this.missing.slice(this.offset, this.offset + FETCH_BATCH);
    this.offset += ids.length;
    for (const id of ids) this.expected.add(id);
    this.final = this.offset === this.missing.length;
    this.options.send({ type: 'viewport.fetch', subscription_id: this.subscription,
      snapshot_token: this.token, batch: this.batch, stroke_ids: ids, final: this.final });
  }
}
