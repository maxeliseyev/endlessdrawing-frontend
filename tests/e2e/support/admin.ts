export const binary = (value: unknown) => Buffer.from(compactServerPacket(value));
import { compactServerPacket } from '../../support/compact';
import { decodeMessagePack } from '../../../src/transport/msgpack';
import { expect, type Page, type WebSocketRoute } from '@playwright/test';

export const TEST_PASSWORD = 'test-only-password-at-least-20-characters';
export const TEST_TOKEN = 'test-only-enrollment-capability';
export const STROKE_ID = '87a122fa-7537-4b88-9b77-b45d24a29714';
export const SECOND_ID = '00000000-0000-4000-8000-000000000002';
export const TEST_STROKES = [
  { id: STROKE_ID, seq: 1, own: false, points: [[-60, 0], [60, 0]], brush: 'round', width: 12, color: '#202020', opacity: 1 },
  { id: SECOND_ID, seq: 2, own: false, points: [[-60, 100], [60, 100]], brush: 'square', width: 12, color: '#E46C60', opacity: 1 },
];

// Test-only WebAuthn stub: adapters/flows, not proof of cryptography or Touch ID.
export async function mockPasskeys(page: Page, cancelFirst = false): Promise<void> {
  await page.addInitScript(({ cancelFirst }) => {
    const record = { get: [] as unknown[], create: [] as unknown[], registrations: 0, cancelled: false };
    Object.defineProperty(window, 'testPasskeys', { value: record });
    const bytes = (...values: number[]) => new Uint8Array(values).buffer;
    const credential = (registration: boolean) => {
      const first = registration ? ++record.registrations : 1;
      const raw = bytes(first, 2, 3);
      const id = btoa(String.fromCharCode(first, 2, 3)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      return { id, rawId: raw, type: 'public-key', getClientExtensionResults: () => ({}), response: registration
        ? { attestationObject: bytes(4, 5, 6), clientDataJSON: bytes(7, 8, 9), getTransports: () => ['internal'] }
        : { authenticatorData: bytes(4, 5, 6), clientDataJSON: bytes(7, 8, 9), signature: bytes(10, 11, 12), userHandle: null } };
    };
    // Replace the test container, not methods on a native WebKit wrapper that
    // can be recreated when concurrent contexts change focus.
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
      get: async (options: CredentialRequestOptions) => {
      record.get.push({ challenge: Array.from(new Uint8Array(options.publicKey!.challenge as ArrayBuffer)),
        uv: options.publicKey!.userVerification, allowId: Array.from(new Uint8Array(options.publicKey!.allowCredentials![0]!.id as ArrayBuffer)) });
      if (cancelFirst && !record.cancelled) { record.cancelled = true; throw new DOMException('Cancelled by test', 'NotAllowedError'); }
      return credential(false);
    },
      create: async (options: CredentialCreationOptions) => {
      record.create.push({ challenge: Array.from(new Uint8Array(options.publicKey!.challenge as ArrayBuffer)),
        userId: Array.from(new Uint8Array(options.publicKey!.user.id as ArrayBuffer)), uv: options.publicKey!.authenticatorSelection!.userVerification });
      return credential(true);
    } } });
  }, { cancelFirst });
}

type WireStroke = typeof TEST_STROKES[number];
export async function adminServer(page: Page, authenticated = false) {
  const state = {
    authenticated, enabled: true, rejectVerify: false, rejectSession: false, accountLogin: 'moderator',
    failLogout: false, hideMode: 'success' as 'success' | 'uncertain' | 'unknown' | 'unauthorized' | 'forbidden' | 'not-found' | 'rate-limited',
    verifyGate: undefined as Promise<void> | undefined,
    requests: [] as { path: string; method: string; body: Record<string, unknown> | undefined; csrf: string | undefined }[],
    messages: [] as Record<string, unknown>[],
    sockets: [] as { route: WebSocketRoute; subscription: string }[],
    strokes: new Map<string, WireStroke>(TEST_STROKES.map((stroke) => [stroke.id, stroke])),
    operations: new Map<string, Record<string, unknown>>(),
    /** Open reported strokes (backend aggregates per stroke). Empty unless a test adds some. */
    reported: [] as { stroke_id: string; held: boolean; reasons: string[] }[],
    banned: 0,
    enrollmentCount: 0, credentialIds: [] as string[], challenge: 'AQIDBA',
  };
  const session = () => ({ authenticated: true, account: { id: SECOND_ID, login: state.accountLogin }, csrf_token: 'test-full-csrf',
    expires_at: new Date(Date.now() + 8 * 3600_000).toISOString(), idle_expires_at: new Date(Date.now() + 15 * 60_000).toISOString() });
  const fail = (code: string, message = 'Backend private diagnostics MUST NOT be displayed') => ({ error: { code, message } });
  await page.route('**/api/admin/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/admin/', '');
    const body = request.method() === 'POST' ? request.postDataJSON() as Record<string, unknown> : undefined;
    state.requests.push({ path, method: request.method(), body, csrf: request.headers()['x-csrf-token'] });
    const reply = (value: unknown, status = 200, headers?: Record<string, string>) => route.fulfill({ status,
      contentType: 'application/json', body: JSON.stringify(value), headers: { 'Cache-Control': 'no-store', ...headers } });
    if (!state.enabled) { await reply(fail('admin_unavailable'), 503); return; }
    if (path === 'session') {
      await reply(state.authenticated && !state.rejectSession ? session() : fail('unauthorized'), state.authenticated && !state.rejectSession ? 200 : 401); return;
    }
    if (path === 'login/options') {
      await reply({ csrf_token: 'test-preauth-csrf', expires_at: new Date(Date.now() + 300_000).toISOString(), authenticator_policy: 'passkey_uv' }); return;
    }
    if (path === 'login') {
      expect(request.headers()['x-csrf-token']).toBe('test-preauth-csrf');
      expect(body?.password).toBe(TEST_PASSWORD);
      await reply({ status: 'mfa_required', expires_at: new Date(Date.now() + 120_000).toISOString(), webauthn: {
        publicKey: { challenge: state.challenge, rpId: new URL(request.url()).hostname, userVerification: 'required', timeout: 120000,
          allowCredentials: (state.credentialIds.length ? state.credentialIds : ['AQID']).map((id) => ({ type: 'public-key', id, transports: ['internal'] })) },
      } }); return;
    }
    if (path === 'login/verify') {
      expect(request.headers()['x-csrf-token']).toBe('test-preauth-csrf');
      if (state.verifyGate) await state.verifyGate;
      if (state.rejectVerify) { await reply(fail('unauthorized'), 401); return; }
      state.authenticated = true; await reply(session()); return;
    }
    if (path === 'enrollment/start') {
      expect(request.headers()['x-csrf-token']).toBe('test-preauth-csrf');
      expect(body?.enrollment_token).toBe(TEST_TOKEN);
      expect(body?.password).toBe(TEST_PASSWORD);
      await reply({ expires_at: new Date(Date.now() + 120_000).toISOString(), webauthn: { publicKey: {
        challenge: state.challenge, rp: { id: new URL(request.url()).hostname, name: 'Endless Drawing' },
        user: { id: 'BAUG', name: 'moderator', displayName: 'Moderator' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' }, attestation: 'none',
        excludeCredentials: state.credentialIds.map((id) => ({ type: 'public-key', id })),
      } } }); return;
    }
    if (path === 'enrollment/finish') {
      expect(request.headers()['x-csrf-token']).toBe('test-preauth-csrf');
      state.enrollmentCount++;
      state.credentialIds.push((body!.credential as { id: string }).id);
      await reply({ registered_credentials: state.enrollmentCount, required_credentials: 2, complete: state.enrollmentCount === 2 }); return;
    }
    if (!state.authenticated) { await reply(fail('unauthorized'), 401); return; }
    if (path === 'logout') {
      if (state.failLogout) { await reply(fail('temporarily_unavailable'), 503); return; }
      expect(request.headers()['x-csrf-token']).toBe('test-full-csrf');
      state.authenticated = false; await route.fulfill({ status: 204 }); return;
    }
    if (path.startsWith('operations/')) {
      const result = state.operations.get(path.slice('operations/'.length));
      await reply(result ?? fail('operation_not_found'), result ? 200 : 404); return;
    }
    if (path === 'reports') {
      const items = state.reported.map((item) => {
        const stroke = TEST_STROKES.find((s) => s.id === item.stroke_id)!;
        return { stroke_id: item.stroke_id, reports: 5, reporters: 5, reasons: item.reasons, block_requests: 4,
          first_at: '2026-11-19T09:00:00Z', last_at: '2026-11-19T09:05:00Z', held: item.held, visible: !item.held && state.strokes.has(item.stroke_id),
          x: 0, y: stroke.points[0]![1] };
      });
      await reply({ open_reports: items.length * 5, items }); return;
    }
    if (path === 'reports/dismiss' || path === 'bans') {
      expect(request.headers()['x-csrf-token']).toBe('test-full-csrf');
      const id = body!.operation_id as string; const ids = body!.stroke_ids as string[];
      let result = state.operations.get(id);
      if (!result) {
        if (path === 'reports/dismiss') {
          const restored = ids.filter((stroke) => state.reported.some((item) => item.stroke_id === stroke && item.held));
          result = { operation_id: id, restored, dismissed_reports: 5 * ids.length };
        } else {
          // Test fixture: both strokes belong to one author.
          const hidden = [...state.strokes.keys()];
          for (const stroke of hidden) {
            const seq = state.strokes.get(stroke)!.seq; state.strokes.delete(stroke);
            for (const socket of state.sockets) if (socket.subscription) socket.route.send(binary({ type: 'stroke.deleted', subscription_id: socket.subscription, stroke_id: stroke, seq }));
          }
          state.banned++; result = { operation_id: id, banned_authors: 1, hidden };
        }
        state.reported = state.reported.filter((item) => !ids.includes(item.stroke_id));
        state.operations.set(id, result);
      }
      await reply(result); return;
    }
    if (path === 'strokes/hide') {
      expect(request.headers()['x-csrf-token']).toBe('test-full-csrf');
      const mode = state.hideMode;
      if (mode === 'unauthorized') { state.authenticated = false; await reply(fail('unauthorized'), 401); return; }
      if (mode === 'forbidden') { await reply(fail('forbidden'), 403); return; }
      if (mode === 'not-found') { await reply(fail('stroke_not_found'), 404); return; }
      if (mode === 'rate-limited') { await reply(fail('rate_limited'), 429, { 'Retry-After': '30' }); return; }
      if (mode === 'unknown') { await reply(fail('temporarily_unavailable'), 503); return; }
      const id = body!.operation_id as string;
      let result = state.operations.get(id);
      if (!result) {
        const ids = body!.stroke_ids as string[];
        const hidden = ids.filter((id) => state.strokes.has(id));
        result = { operation_id: id, hidden, already_hidden: ids.filter((id) => !state.strokes.has(id)) };
        for (const id of hidden) {
          const stroke = state.strokes.get(id)!; state.strokes.delete(id);
          for (const socket of state.sockets) if (socket.subscription) socket.route.send(binary({ type: 'stroke.deleted', subscription_id: socket.subscription, stroke_id: id, seq: stroke.seq }));
        }
        state.operations.set(id, result);
      }
      if (mode === 'uncertain') { await reply(fail('temporarily_unavailable'), 503); return; }
      await reply(result); return;
    }
    await reply(fail('invalid_request'), 400);
  });
  await page.routeWebSocket('**/ws', (route) => {
    const socket = { route, subscription: '' }; state.sockets.push(socket);
    route.onMessage((data) => {
      const message = typeof data === 'string' ? JSON.parse(data) as Record<string, unknown> : decodeMessagePack(data); state.messages.push(message);
      if (message.type === 'hello') route.send(binary({ type: 'hello.ack', protocol_version: 6 }));
      if (message.type === 'viewport.subscribe' || message.type === 'viewport.subscribe.cached') {
        socket.subscription = message.subscription_id as string;
        if (message.type === 'viewport.subscribe.cached') { route.send(binary({ type: 'viewport.snapshot.fallback', subscription_id: socket.subscription, reason: 'busy' })); return; }
        route.send(binary({ type: 'viewport.snapshot.begin', subscription_id: socket.subscription }));
        for (const stroke of state.strokes.values()) route.send(binary({ type: 'viewport.snapshot.chunk', subscription_id: socket.subscription, strokes: [stroke] }));
        route.send(binary({ type: 'viewport.snapshot.end', subscription_id: socket.subscription }));
      }
    });
  });
  return state;
}

export async function login(page: Page, ru = false) {
  await page.getByLabel(ru ? 'Логин' : 'Login', { exact: true }).fill('moderator');
  await page.getByLabel(ru ? 'Пароль' : 'Password', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: ru ? 'Войти с passkey' : 'Sign in with passkey', exact: true }).click();
}
export async function selectStroke(page: Page, y = 0) {
  await expect(page.locator('.world-status')).toHaveText(/Shared world loaded|Общий мир загружен/);
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + y);
}
export async function review(page: Page, reason = 'Test moderation reason') {
  await page.getByRole('button', { name: 'Review hiding', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Reason', { exact: true }).fill(reason);
}
export async function confirm(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Hide selected strokes', exact: true }).click();
}
