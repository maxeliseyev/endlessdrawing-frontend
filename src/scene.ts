import type { Stroke, StrokeDraft } from './model';
import { object, parseStroke, ProtocolError, text, uuid } from './wire';

export const MAX_SCENE_STROKES = 20_000;
export const MAX_SCENE_POINTS = 1_000_000;
export const MAX_PENDING = 64;
const MAX_TOMBSTONES = 20_000;

export type SceneResult = 'changed' | 'ignored' | 'resync';

export interface Pending {
  readonly draft: StrokeDraft;
  // Sent at least once on some connection: a commit may exist even without an ack.
  sent: boolean;
  // Undo/eraser requested before the create was confirmed.
  cancelled: boolean;
}

/**
 * Changes of the drawn set: (confirmed ∪ staging) minus hidden. Every stroke
 * id is reported `added` once when it starts being drawn and `removed` once
 * when it stops; pending creates are not part of this set.
 */
export interface SceneListener {
  added(stroke: Stroke): void;
  removed(stroke: Stroke): void;
}

/**
 * Public world state for one tab. Pure: no DOM, no sockets.
 *
 * - `confirmed` is the authoritative cache for the current subscription, drawn by seq.
 * - A snapshot is staged and replaces `confirmed` atomically on end. Staged
 *   strokes are drawn as soon as their chunk arrives (they are committed
 *   server state); only the removal of strokes missing from the new snapshot
 *   waits for end.
 * - `pending` are own creates without an ack; never part of undo.
 * - `hidden` are own confirmed strokes with a delete in flight (optimistic).
 */
export class SharedScene {
  confirmed = new Map<string, Stroke>();
  readonly pending = new Map<string, Pending>();
  readonly hidden = new Set<string>();
  subscriptionId = '';
  phase: 'loading' | 'ready' = 'loading';
  // The area was denser than the client cache; the oldest strokes were kept.
  truncated = false;
  listener: SceneListener | undefined;
  private staging: Map<string, Stroke> | undefined;
  private stagedPoints = 0;
  private livePoints = 0;
  private readonly tombstones = new Set<string>();
  private ordered: Stroke[] | undefined;
  revision = 0;

  /** A new subscription: keep drawing the old cache until its snapshot ends. */
  subscribe(id: string): void {
    this.subscriptionId = id;
    this.abandonStaging();
    this.phase = 'loading';
  }

  /** A new connection. Tombstones refer to the previous event stream. */
  reconnected(): void {
    this.subscriptionId = '';
    this.abandonStaging();
    this.tombstones.clear();
    this.phase = 'loading';
  }

  /** A drawn (or hidden) stroke by id, staged or confirmed. */
  get(id: string): Stroke | undefined {
    return this.staging?.get(id) ?? this.confirmed.get(id);
  }

  /** Drawn candidates in server order (seq), cached until the next change. */
  strokes(): readonly Stroke[] {
    if (!this.ordered) {
      let all: Iterable<Stroke> = this.confirmed.values();
      if (this.staging?.size) {
        const union = new Map(this.confirmed);
        for (const [id, stroke] of this.staging) union.set(id, stroke);
        all = union.values();
      }
      this.ordered = [...all].sort((a, b) => a.seq - b.seq);
    }
    return this.ordered;
  }

  /** Pending creates in local creation order, excluding cancelled ones. */
  visiblePending(): StrokeDraft[] {
    const result: StrokeDraft[] = [];
    for (const item of this.pending.values()) if (!item.cancelled) result.push(item.draft);
    return result;
  }

  addPending(draft: StrokeDraft): boolean {
    if (this.pending.size >= MAX_PENDING) return false;
    this.pending.set(draft.id, { draft, sent: false, cancelled: false });
    this.touch();
    return true;
  }

  /** Create ack: the stroke is ours, confirmed and has a seq. */
  confirm(stroke: Stroke): void {
    this.pending.delete(stroke.id);
    if (this.tombstones.has(stroke.id)) { this.touch(); return; }
    const before = this.drawn(stroke.id);
    this.put(stroke, this.confirmed, true);
    if (this.staging) this.put(stroke, this.staging, false);
    this.report(stroke.id, before);
    this.touch();
  }

  dropPending(id: string): void {
    if (this.pending.delete(id)) this.touch();
  }

  hide(id: string): void {
    const before = this.drawn(id);
    this.hidden.add(id);
    this.report(id, before);
    this.touch();
  }

  unhide(id: string): void {
    if (!this.hidden.has(id)) return;
    this.hidden.delete(id);
    this.report(id, undefined);
    this.touch();
  }

  /** Delete ack or a stroke.deleted event. */
  remove(id: string): void {
    const before = this.drawn(id);
    this.tombstone(id);
    this.hidden.delete(id);
    const live = this.confirmed.get(id);
    if (live) { this.livePoints -= live.points.length; this.confirmed.delete(id); }
    const staged = this.staging?.get(id);
    if (staged) { this.stagedPoints -= staged.points.length; this.staging?.delete(id); }
    this.report(id, before);
    this.touch();
  }

  accept(value: unknown): SceneResult {
    const message = object(value);
    const type = text(message.type, 64);
    if (!this.subscriptionId || message.subscription_id !== this.subscriptionId) return 'ignored';
    if (type === 'error') {
      if (message.code === 'resync_required') { this.abandonStaging(); return 'resync'; }
      throw new ProtocolError();
    }
    if (type === 'viewport.snapshot.begin') {
      if (this.staging || this.phase === 'ready') throw new ProtocolError();
      this.staging = new Map(); this.stagedPoints = 0; this.truncated = false;
      return 'ignored';
    }
    if (type === 'viewport.snapshot.chunk') {
      const staging = this.staging;
      if (!staging || !Array.isArray(message.strokes) || message.strokes.length > 1000) throw new ProtocolError();
      const strokes = message.strokes.map(parseStroke);
      let changed = false;
      for (const stroke of strokes) {
        const before = this.drawn(stroke.id);
        this.put(stroke, staging, false);
        changed = this.report(stroke.id, before) || changed;
      }
      if (!changed) return 'ignored';
      this.touch();
      return 'changed';
    }
    if (type === 'viewport.snapshot.end') {
      if (!this.staging) throw new ProtocolError();
      // Own acks that arrived during staging were added to both maps.
      const previous = this.confirmed;
      this.confirmed = this.staging; this.livePoints = this.stagedPoints;
      this.staging = undefined; this.stagedPoints = 0; this.phase = 'ready';
      for (const [id, stroke] of previous) {
        if (!this.confirmed.has(id) && !this.hidden.has(id)) this.listener?.removed(stroke);
      }
      for (const id of this.hidden) if (!this.confirmed.has(id)) this.hidden.delete(id);
      this.touch();
      return 'changed';
    }
    if (type === 'stroke.created') {
      if (!this.staging && this.phase !== 'ready') throw new ProtocolError();
      const stroke = parseStroke(message.stroke);
      // Our own event may arrive before the ack; the ack still owns the undo entry.
      if (this.tombstones.has(stroke.id)) return 'ignored';
      const before = this.drawn(stroke.id);
      this.put(stroke, this.staging ?? this.confirmed, !this.staging);
      if (this.staging && this.confirmed.has(stroke.id)) this.put(stroke, this.confirmed, true);
      this.report(stroke.id, before);
      this.touch();
      return 'changed';
    }
    if (type === 'stroke.deleted') {
      this.remove(uuid(message.stroke_id));
      return 'changed';
    }
    throw new ProtocolError();
  }

  /**
   * An unfinished snapshot is cancelled (new subscription, resync, reconnect).
   * Its strokes were real server state and are already on screen: keep them in
   * the stale cache, which the next completed snapshot replaces as a whole.
   */
  private abandonStaging(): void {
    const staging = this.staging;
    this.staging = undefined;
    this.stagedPoints = 0;
    if (!staging?.size) return;
    for (const [id, stroke] of staging) {
      if (this.confirmed.has(id)) continue;
      if (!this.put(stroke, this.confirmed, true) && !this.hidden.has(id)) this.listener?.removed(stroke);
    }
    this.touch();
  }

  private drawn(id: string): Stroke | undefined {
    return this.hidden.has(id) ? undefined : this.get(id);
  }

  // Tell the listener whether `id` entered or left the drawn set.
  private report(id: string, before: Stroke | undefined): boolean {
    const after = this.drawn(id);
    if (!before && after) this.listener?.added(after);
    else if (before && !after) this.listener?.removed(before);
    else return false;
    return true;
  }

  private put(stroke: Stroke, target: Map<string, Stroke>, live: boolean): boolean {
    const previous = target.get(stroke.id);
    const delta = stroke.points.length - (previous?.points.length ?? 0);
    const total = (live ? this.livePoints : this.stagedPoints) + delta;
    if ((!previous && target.size >= MAX_SCENE_STROKES) || total > MAX_SCENE_POINTS) {
      // Keep the client bounded instead of failing the whole world.
      this.truncated = true;
      return false;
    }
    target.set(stroke.id, stroke);
    if (live) this.livePoints = total; else this.stagedPoints = total;
    return true;
  }

  private tombstone(id: string): void {
    this.tombstones.add(id);
    if (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = this.tombstones.values().next().value;
      if (oldest !== undefined) this.tombstones.delete(oldest);
    }
  }

  private touch(): void {
    this.ordered = undefined;
    this.revision++;
  }
}
