import { decodeMessagePack, encodeMessagePack, SERVER_MESSAGE_BYTES } from '../../../src/transport/msgpack';
import type { BrowserContext, Page, WebSocketRoute } from '@playwright/test';

// Deterministic in-memory WS v1 server for public-canvas E2E. Mirrors the
// backend semantics that the client relies on (own per secret, idempotent
// create by UUID, owner-only delete, snapshot begin/chunk/end). It is a test
// double, not proof of backend integration.
interface WireStroke { id: string; seq: number; points: number[][]; brush: string; width: number; color: string; opacity: number }
interface Client { route: WebSocketRoute; secret: string; subscription: string;
  manifest?: { token: string; strokes: Map<string, WireStroke & { own: boolean }>; events: unknown[] } }

export interface MockWorld {
  strokes: Map<string, WireStroke & { owner: string; deleted: boolean }>;
  // stroke.report requests (v5), in arrival order.
  reports: { reporter: string; stroke_ids: string[]; reason: string; block_author: boolean }[];
  clients: Set<Client>;
  messages: Record<string, unknown>[];
  // Test controls.
  holdAcks: boolean;
  // Entry hint sent in hello.ack (none when undefined).
  spawn: { x: number; y: number } | undefined;
  // Delay of hello.ack in ms (simulates a slow connection).
  helloDelay: number;
  held: (() => void)[];
  dropSockets(): void;
  releaseAcks(): void;
  seed(stroke: Omit<WireStroke, 'seq'>, owner?: string): void;
}

export function createMockWorld(): MockWorld {
  let seq = 0;
  const world: MockWorld = {
    strokes: new Map(), reports: [], clients: new Set(), messages: [], holdAcks: false, held: [], spawn: undefined, helloDelay: 0,
    dropSockets() { for (const client of [...this.clients]) { this.clients.delete(client); void client.route.close({ code: 1012 }); } },
    releaseAcks() { const held = this.held.splice(0); for (const send of held) send(); },
    seed(stroke, owner = 'someone-else') { this.strokes.set(stroke.id, { ...stroke, seq: ++seq, owner, deleted: false }); },
  };
  // v5 author tag: stable per (viewer, author), 22 base64url chars (not the real hash).
  const authorTag = (viewer: string, owner: string) =>
    Buffer.from(`${viewer}|${owner}`).toString('base64url').padEnd(22, 'A').slice(-22);
  const publicStroke = (stroke: WireStroke & { owner: string }, secret: string) => ({
    id: stroke.id, seq: stroke.seq, points: stroke.points, brush: stroke.brush, width: stroke.width,
    color: stroke.color, opacity: stroke.opacity, own: stroke.owner === secret, author: authorTag(secret, stroke.owner),
  });
  const send = (client: Client, message: unknown) => { try { client.route.send(Buffer.from(encodeMessagePack(message, SERVER_MESSAGE_BYTES))); } catch { /* closed */ } };
  const broadcast = (client: Client, message: unknown) => { if (client.manifest) client.manifest.events.push(message); else send(client, message); };
  (world as MockWorld & { attach(route: WebSocketRoute): void }).attach = (route: WebSocketRoute) => {
    const client: Client = { route, secret: '', subscription: '' };
    world.clients.add(client);
    route.onClose(() => world.clients.delete(client));
    route.onMessage((data) => {
      const message = typeof data === 'string' ? JSON.parse(data) as Record<string, unknown> : decodeMessagePack(data);
      world.messages.push(message);
      if (message.type === 'hello') {
        client.secret = String(message.session_secret);
        const ack = world.spawn ? { type: 'hello.ack', protocol_version: 5, spawn: world.spawn } : { type: 'hello.ack', protocol_version: 5 };
        if (world.helloDelay) setTimeout(() => send(client, ack), world.helloDelay); else send(client, ack);
      } else if (message.type === 'viewport.subscribe' || message.type === 'viewport.subscribe.cached') {
        const id = String(message.subscription_id);
        client.subscription = id; client.manifest = undefined;
        send(client, { type: 'viewport.snapshot.begin', subscription_id: id });
        const visible = [...world.strokes.values()].filter((s) => !s.deleted).sort((a, b) => a.seq - b.seq);
        if (message.type === 'viewport.subscribe.cached') {
          const token = crypto.randomUUID();
          client.manifest = { token, strokes: new Map(visible.map((s) => [s.id, publicStroke(s, client.secret)])), events: [] };
          send(client, { type: 'viewport.manifest.begin', subscription_id: id, snapshot_token: token,
            stroke_count: visible.length, point_count: visible.reduce((sum, s) => sum + s.points.length, 0) });
          for (let i = 0; i < visible.length; i += 1000) send(client, { type: 'viewport.manifest.chunk', subscription_id: id,
            snapshot_token: token, stroke_ids: visible.slice(i, i + 1000).map((s) => s.id) });
          send(client, { type: 'viewport.manifest.end', subscription_id: id, snapshot_token: token });
          return;
        }
        for (let i = 0; i < visible.length; i += 2) {
          send(client, { type: 'viewport.snapshot.chunk', subscription_id: id, strokes: visible.slice(i, i + 2).map((s) => publicStroke(s, client.secret)) });
        }
        send(client, { type: 'viewport.snapshot.end', subscription_id: id });
      } else if (message.type === 'viewport.fetch') {
        const snapshot = client.manifest;
        if (!snapshot || message.subscription_id !== client.subscription || message.snapshot_token !== snapshot.token) return;
        const ids = message.stroke_ids as string[];
        for (let i = 0; i < ids.length; i += 2) send(client, { type: 'viewport.snapshot.chunk', subscription_id: client.subscription,
          strokes: ids.slice(i, i + 2).map((id) => snapshot.strokes.get(id)) });
        if (message.final) {
          client.manifest = undefined;
          send(client, { type: 'viewport.snapshot.end', subscription_id: client.subscription });
          for (const event of snapshot.events) send(client, event);
        } else send(client, { type: 'viewport.fetch.end', subscription_id: client.subscription, snapshot_token: snapshot.token, batch: message.batch });
      } else if (message.type === 'stroke.create') {
        const input = message.stroke as Omit<WireStroke, 'seq'>;
        let stroke = world.strokes.get(input.id);
        const fresh = !stroke;
        if (!stroke) {
          stroke = { ...input, color: input.color.toUpperCase(), seq: ++seq, owner: client.secret, deleted: false };
          world.strokes.set(input.id, stroke);
        } else if (stroke.owner !== client.secret) {
          send(client, { type: 'error', request_id: message.request_id, code: 'id_conflict', message: 'conflict' }); return;
        } else if (stroke.deleted) {
          send(client, { type: 'error', request_id: message.request_id, code: 'stroke_deleted', message: 'deleted' }); return;
        }
        const saved = stroke;
        const deliver = () => {
          send(client, { type: 'ack', request_id: message.request_id, operation: 'stroke.create', stroke: publicStroke(saved, client.secret) });
          if (fresh) for (const other of world.clients) {
            if (other.subscription) broadcast(other, { type: 'stroke.created', subscription_id: other.subscription, stroke: publicStroke(saved, other.secret) });
          }
        };
        if (world.holdAcks) world.held.push(deliver); else deliver();
      } else if (message.type === 'stroke.report') {
        const ids = message.stroke_ids as string[];
        const bad = ids.find((id) => { const s = world.strokes.get(id); return !s || s.deleted || s.owner === client.secret; });
        if (bad) { send(client, { type: 'error', request_id: message.request_id, code: 'not_found', message: 'gone' }); return; }
        world.reports.push({ reporter: client.secret, stroke_ids: ids, reason: String(message.reason), block_author: message.block_author === true });
        send(client, { type: 'ack', request_id: message.request_id, operation: 'stroke.report', report_id: crypto.randomUUID() });
      } else if (message.type === 'stroke.delete') {
        const stroke = world.strokes.get(String(message.stroke_id));
        if (!stroke) { send(client, { type: 'error', request_id: message.request_id, code: 'not_found', message: 'missing' }); return; }
        if (stroke.owner !== client.secret) { send(client, { type: 'error', request_id: message.request_id, code: 'forbidden', message: 'foreign' }); return; }
        const already = stroke.deleted;
        stroke.deleted = true;
        send(client, { type: 'ack', request_id: message.request_id, operation: 'stroke.delete', stroke_id: stroke.id, seq: stroke.seq, already_deleted: already });
        if (!already) for (const other of world.clients) {
          if (other.subscription) broadcast(other, { type: 'stroke.deleted', subscription_id: other.subscription, stroke_id: stroke.id, seq: stroke.seq });
        }
      }
    });
  };
  return world;
}

export async function useMockWorld(target: Page | BrowserContext, world = createMockWorld()): Promise<MockWorld> {
  await target.routeWebSocket('**/ws', (route) => (world as MockWorld & { attach(route: WebSocketRoute): void }).attach(route));
  return world;
}
