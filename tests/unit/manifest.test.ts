import { describe, expect, it } from 'vitest';
import { ManifestLoader } from '../../src/transport/manifest';
import { SharedScene } from '../../src/scene';
import { ProtocolError } from '../../src/wire';
import type { Stroke } from '../../src/model';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const token = '00000000-0000-4000-8000-000000000001';
const stroke = (id: string, seq: number): Stroke => ({ id, seq, own: true,
  points: Object.freeze([[0, 0], [1, 1]]) as unknown as Stroke['points'], brush: 'round', width: 6, color: '#202020', opacity: 1 });
const message = (type: string, extra = {}, subscription_id = 'new') => ({ type, subscription_id, ...extra });

function setup(ids = [A, B]) {
  const scene = new SharedScene();
  const a = stroke(A, 1), b = stroke(B, 2);
  scene.confirm(a); scene.confirm(b);
  scene.subscribe('new', true);
  scene.accept(message('viewport.snapshot.begin'));
  const sent: Record<string, unknown>[] = [];
  const loader = new ManifestLoader({ get: (id) => scene.get(id), retain: (strokes) => scene.retain(strokes), send: (m) => sent.push(m) });
  loader.start('new', true);
  loader.accept(message('viewport.manifest.begin', { snapshot_token: token, stroke_count: ids.length, point_count: ids.length * 2 }));
  loader.accept(message('viewport.manifest.chunk', { snapshot_token: token, stroke_ids: ids }));
  const end = () => loader.accept(message('viewport.manifest.end', { snapshot_token: token }));
  const commit = () => { const m = message('viewport.snapshot.end'); expect(loader.accept(m)).toBe(false); scene.accept(m); };
  return { scene, loader, sent, end, commit, a, b };
}

describe('manifest membership and immutable cache reuse', () => {
  it('preserves a create acknowledged after subscribe but before snapshot.begin', () => {
    const scene = new SharedScene();
    scene.subscribe('new', true);
    const own = stroke(C, 3); scene.confirm(own);
    scene.accept(message('viewport.snapshot.begin'));
    scene.accept(message('viewport.snapshot.end'));
    expect(scene.get(C)).toBe(own);
  });

  it('requests zero geometry for a warm area and preserves object identity without renderer churn', () => {
    const { scene, sent, end, commit, a, b } = setup();
    const added: Stroke[] = [], removed: Stroke[] = [];
    scene.listener = { added: (s) => added.push(s), removed: (s) => removed.push(s) };
    end();
    expect(sent).toEqual([message('viewport.fetch', { snapshot_token: token, batch: 0, stroke_ids: [], final: true })]);
    commit();
    expect(scene.get(A)).toBe(a); expect(scene.get(B)).toBe(b);
    expect(added).toEqual([]); expect(removed).toEqual([]);
  });

  it('fetches only missing geometry and removes absent cached ids only at authoritative end', () => {
    const { scene, loader, sent, end, commit, a } = setup([A, C]);
    end();
    expect(sent[0]?.stroke_ids).toEqual([C]);
    expect(scene.get(B)).toBeDefined();
    loader.accept(message('viewport.snapshot.chunk', { strokes: [stroke(C, 3)] }));
    expect(scene.strokes().map((s) => s.id)).toEqual([A, B, C]);
    commit();
    expect(scene.strokes().map((s) => s.id)).toEqual([A, C]);
    expect(scene.get(A)).toBe(a);
  });

  it('keeps own acks received during loading and never resurrects a known delete', () => {
    const { scene, loader, end, commit } = setup([A, B]);
    scene.remove(A); scene.confirm(stroke(C, 3));
    end();
    loader.accept(message('viewport.snapshot.chunk', { strokes: [stroke(A, 1)] }));
    expect(scene.get(A)).toBeUndefined();
    commit();
    expect(scene.strokes().map((s) => s.id)).toEqual([B, C]);
  });

  it('ignores cancelled subscriptions and rejects unrequested, duplicate, incomplete or wrong-token responses', () => {
    const { loader, end } = setup([C]);
    expect(loader.accept(message('viewport.manifest.chunk', { snapshot_token: token, stroke_ids: [A] }, 'old'))).toBe(false);
    end();
    expect(() => loader.accept(message('viewport.snapshot.chunk', { strokes: [stroke(A, 1)] }))).toThrow(ProtocolError);
    expect(() => loader.accept(message('viewport.snapshot.end'))).toThrow(ProtocolError);
    expect(() => loader.accept(message('viewport.fetch.end', { snapshot_token: 'wrong', batch: 0 }))).toThrow(ProtocolError);
    expect(() => loader.accept(message('viewport.snapshot.chunk', { strokes: [stroke(C, 3), stroke(C, 3)] }))).toThrow(ProtocolError);
    loader.start('replacement', false);
    expect(loader.accept(message('viewport.snapshot.chunk', { strokes: [stroke(C, 3)] }))).toBe(false);
  });

  it('limits manifest cardinality and catches duplicate ids before retaining geometry', () => {
    const { loader } = setup([C]);
    expect(() => loader.accept(message('viewport.manifest.chunk', { snapshot_token: token, stroke_ids: [C] }))).toThrow(ProtocolError);
    loader.start('new', true);
    expect(() => loader.accept(message('viewport.manifest.begin', { snapshot_token: token, stroke_count: 20_001, point_count: 20_001 }))).toThrow(ProtocolError);
    expect(() => loader.accept(message('viewport.manifest.begin', { snapshot_token: token, stroke_count: 1, point_count: 1_000_001 }))).toThrow(ProtocolError);
  });

  it('fetches more than 1000 missing ids with bounded stop-and-wait batches', () => {
    const scene = new SharedScene(); scene.subscribe('new', true);
    scene.accept(message('viewport.snapshot.begin'));
    const sent: Record<string, unknown>[] = [];
    const loader = new ManifestLoader({ get: (id) => scene.get(id), retain: (strokes) => scene.retain(strokes), send: (m) => sent.push(m) });
    const ids = Array.from({ length: 1001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    loader.start('new', true);
    loader.accept(message('viewport.manifest.begin', { snapshot_token: token, stroke_count: ids.length, point_count: 2002 }));
    for (let i = 0; i < ids.length; i += 1000) loader.accept(message('viewport.manifest.chunk', { snapshot_token: token, stroke_ids: ids.slice(i, i + 1000) }));
    loader.accept(message('viewport.manifest.end', { snapshot_token: token }));
    expect(sent).toHaveLength(1); expect(sent[0]?.final).toBe(false);
    expect(sent[0]?.stroke_ids).toHaveLength(1000);
    loader.accept(message('viewport.snapshot.chunk', { strokes: ids.slice(0, 1000).map((id, i) => stroke(id, i + 1)) }));
    expect(sent).toHaveLength(1);
    loader.accept(message('viewport.fetch.end', { snapshot_token: token, batch: 0 }));
    expect(sent[1]?.stroke_ids).toEqual([ids[1000]]); expect(sent[1]?.final).toBe(true);
    loader.accept(message('viewport.snapshot.chunk', { strokes: [stroke(ids[1000]!, 1001)] }));
    loader.accept(message('viewport.snapshot.end')); scene.accept(message('viewport.snapshot.end'));
    expect(scene.strokes()).toHaveLength(1001);
  });
});
