import { describe, expect, it } from 'vitest';
import { AdminScene, MAX_SCENE_STROKES, parseStroke, SceneLimitError } from '../../src/admin/scene';
import { ProtocolError } from '../../src/admin/contracts';

const id = '87a122fa-7537-4b88-9b77-b45d24a29714';
const stroke = { id, seq: 1, own: false, points: [[0, 0], [10, 10]], brush: 'round', width: 6, color: '#202020', opacity: 1 };
const message = (type: string, extra = {}, subscription_id = 'view-1') => ({ type, subscription_id, ...extra });
function begin() {
  const scene = new AdminScene(); scene.subscribe('view-1');
  scene.accept(message('viewport.snapshot.begin')); return scene;
}

describe('read-only authoritative world scene', () => {
  it('waits for all snapshot chunks and deduplicates by ID regardless of ownership', () => {
    const scene = begin();
    scene.accept(message('viewport.snapshot.chunk', { strokes: [stroke] }));
    expect(scene.phase).toBe('loading'); expect(scene.strokes.size).toBe(0);
    scene.accept(message('viewport.snapshot.chunk', { strokes: [stroke, { ...stroke, id: '00000000-0000-4000-8000-000000000002', seq: 2 }] }));
    scene.accept(message('viewport.snapshot.end'));
    expect(scene.phase).toBe('ready'); expect(scene.strokes.size).toBe(2);
    expect(scene.strokes.get(id)?.own).toBe(false);
  });
  it('ignores old subscriptions and replaces stale geometry after reconnect/resync', () => {
    const scene = begin();
    scene.accept(message('viewport.snapshot.chunk', { strokes: [stroke] }));
    scene.accept(message('viewport.snapshot.end'));
    scene.subscribe('view-2');
    expect(scene.accept(message('stroke.created', { stroke }))).toBe('ignored');
    scene.accept(message('viewport.snapshot.begin', {}, 'view-2'));
    scene.accept(message('viewport.snapshot.end', {}, 'view-2'));
    expect(scene.strokes.size).toBe(0);
    expect(scene.accept(message('error', { code: 'resync_required' }, 'view-2'))).toBe('resync');
  });
  it('does not resurrect a hide acknowledged before a late snapshot chunk', () => {
    const scene = begin(); scene.remove([id]);
    scene.accept(message('viewport.snapshot.chunk', { strokes: [stroke] }));
    scene.accept(message('viewport.snapshot.end'));
    expect(scene.strokes.size).toBe(0);
    scene.accept(message('stroke.created', { stroke }));
    expect(scene.strokes.size).toBe(0);
  });
  it('handles live created/deleted and empty snapshots without duplicates', () => {
    const scene = begin(); scene.accept(message('viewport.snapshot.end'));
    scene.accept(message('stroke.created', { stroke }));
    scene.accept(message('stroke.created', { stroke }));
    expect(scene.strokes.size).toBe(1);
    scene.accept(message('stroke.deleted', { stroke_id: id, seq: 1 }));
    scene.accept(message('stroke.deleted', { stroke_id: id, seq: 1 }));
    expect(scene.strokes.size).toBe(0);
  });
  it('rejects unsafe geometry/ordering and malformed chunk sequences', () => {
    for (const input of [{ ...stroke, seq: Number.MAX_SAFE_INTEGER + 1 }, { ...stroke, own: 'true' },
      { ...stroke, points: [[Infinity, 0]] }, { ...stroke, points: [] }, { ...stroke, brush: 'unknown' }]) {
      expect(() => parseStroke(input)).toThrow(ProtocolError);
    }
    const scene = new AdminScene(); scene.subscribe('view-1');
    expect(() => scene.accept(message('viewport.snapshot.end'))).toThrow(ProtocolError);
  });
  it('limits snapshot cardinality rather than collecting an unlimited world', () => {
    const scene = begin();
    for (let offset = 0; offset < MAX_SCENE_STROKES; offset += 1000) {
      const strokes = Array.from({ length: 1000 }, (_, i) => ({ ...stroke,
        id: `00000000-0000-4000-8000-${String(offset + i).padStart(12, '0')}`, seq: offset + i + 1 }));
      scene.accept(message('viewport.snapshot.chunk', { strokes }));
    }
    expect(() => scene.accept(message('viewport.snapshot.chunk', { strokes: [stroke] }))).toThrow(SceneLimitError);
  });
});
