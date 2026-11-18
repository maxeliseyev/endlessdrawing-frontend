import type { Stroke } from '../model';
import { object, parseStroke, ProtocolError, text, uuid } from '../wire';
export { parseStroke };

export class SceneLimitError extends Error {}
export type ScenePhase = 'loading' | 'ready';
export const MAX_SCENE_STROKES = 20_000;
export const MAX_SCENE_POINTS = 1_000_000;

// Authoritative read-only scene. No create/delete requests and no fake ownership.
export class AdminScene {
  strokes = new Map<string, Stroke>();
  phase: ScenePhase = 'loading';
  subscriptionId = '';
  private staging: Map<string, Stroke> | undefined;
  private deleted = new Set<string>();
  private stagedPoints = 0;
  private livePoints = 0;

  subscribe(id: string, preserveCache = false): void {
    this.subscriptionId = id;
    if (!preserveCache) this.clear();
    else { this.staging = undefined; this.stagedPoints = 0; this.phase = 'loading'; }
  }

  get(id: string): Stroke | undefined { return this.staging?.get(id) ?? this.strokes.get(id); }

  retain(strokes: readonly Stroke[]): void {
    if (!this.staging) throw new ProtocolError();
    for (const stroke of strokes) this.put(stroke);
  }
  clear(): void {
    this.strokes = new Map(); this.staging = undefined; this.deleted.clear();
    this.stagedPoints = this.livePoints = 0; this.phase = 'loading';
  }
  remove(ids: Iterable<string>): void {
    for (const id of ids) {
      this.deleted.add(id);
      if (this.deleted.size > MAX_SCENE_STROKES) throw new SceneLimitError();
      const live = this.strokes.get(id);
      const staged = this.staging?.get(id);
      if (live) this.livePoints -= live.points.length;
      if (staged) this.stagedPoints -= staged.points.length;
      this.strokes.delete(id); this.staging?.delete(id);
    }
  }
  private put(stroke: Stroke): void {
    if (this.deleted.has(stroke.id)) return;
    const target = this.staging ?? this.strokes;
    const points = stroke.points.length - (target.get(stroke.id)?.points.length ?? 0);
    const total = (this.staging ? this.stagedPoints : this.livePoints) + points;
    if ((!target.has(stroke.id) && target.size >= MAX_SCENE_STROKES) || total > MAX_SCENE_POINTS) throw new SceneLimitError();
    target.set(stroke.id, stroke);
    if (this.staging) this.stagedPoints = total;
    else this.livePoints = total;
  }
  accept(value: unknown): 'changed' | 'ignored' | 'resync' {
    const message = object(value);
    const type = text(message.type, 64);
    if (message.subscription_id !== this.subscriptionId || !this.subscriptionId) return 'ignored';
    if (type === 'error') {
      if (message.code === 'resync_required') return 'resync';
      throw new ProtocolError();
    }
    if (type === 'viewport.snapshot.begin') {
      if (this.staging || this.phase === 'ready') throw new ProtocolError();
      this.staging = new Map(); this.stagedPoints = 0;
    } else if (type === 'viewport.snapshot.chunk') {
      if (!this.staging || !Array.isArray(message.strokes) || message.strokes.length > 1000) throw new ProtocolError();
      for (const stroke of message.strokes) this.put(parseStroke(stroke));
    } else if (type === 'viewport.snapshot.end') {
      if (!this.staging) throw new ProtocolError();
      this.strokes = this.staging; this.livePoints = this.stagedPoints;
      this.staging = undefined; this.stagedPoints = 0; this.phase = 'ready';
    } else if (type === 'stroke.created') {
      if (!this.staging && this.phase !== 'ready') throw new ProtocolError();
      this.put(parseStroke(message.stroke));
    } else if (type === 'stroke.deleted') {
      this.remove([uuid(message.stroke_id)]);
    } else throw new ProtocolError();
    return 'changed';
  }
}
