import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApi, ApiError, retryDeadline, uncertainOutcome } from '../../src/admin/api';
import { makeHideOperation, ProtocolError } from '../../src/admin/contracts';

const id = '87a122fa-7537-4b88-9b77-b45d24a29714';
const operation = makeHideOperation([id], 'reason', '4df8a775-7e7e-4707-a747-58d6c87d7019');
const session = { authenticated: true, account: { id, login: 'moderator' }, csrf_token: 'full-csrf',
  expires_at: '2030-01-01T00:00:00Z', idle_expires_at: '2029-12-31T23:00:00Z' };
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });
afterEach(() => vi.useRealTimers());

describe('same-origin admin API client', () => {
  it('uses no-store, same-origin credentials, explicit JSON and memory-provided CSRF', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ operation_id: operation.operation_id, hidden: [id], already_hidden: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new AdminApi(fetcher);
    expect(await api.session()).toEqual({ ...session, auth_method: 'passkey_uv' });
    await api.hide(operation, 'full-csrf');
    await api.logout('full-csrf');
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/admin/session');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty('X-CSRF-Token');
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify(operation),
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'full-csrf' } });
    expect(fetcher.mock.calls[2]?.[1]?.body).toBe('{}');
  });
  it('does not treat a malformed logout success body as confirmed revocation', async () => {
    const api = new AdminApi(vi.fn<typeof fetch>().mockResolvedValue(json({ authenticated: true })));
    await expect(api.logout('csrf')).rejects.toThrow(ProtocolError);
  });
  it('does not convert password acceptance into a session, preserves the credential wrapper', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ status: 'mfa_required', webauthn: { publicKey: { challenge: 'AQID' } }, expires_at: session.expires_at }))
      .mockResolvedValueOnce(json(session));
    const api = new AdminApi(fetcher);
    expect(await api.login('moderator', 'test-password', 'preauth')).not.toHaveProperty('authenticated');
    const credential = { id: 'AQID', extensions: {}, response: { signature: 'AQID' } };
    await api.verify(credential, 'preauth');
    expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string)).toEqual({ credential });
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ 'X-CSRF-Token': 'preauth' });
  });
  it('honors Retry-After without busy-looping or issuing another request early', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: { code: 'rate_limited', message: 'private text' } }, 429, { 'Retry-After': '10' }))
      .mockResolvedValueOnce(json(session));
    const api = new AdminApi(fetcher);
    await expect(api.session()).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
    await expect(api.session()).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_001);
    await api.session();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('never exposes the backend message and treats unknown outcomes conservatively', async () => {
    const api = new AdminApi(vi.fn<typeof fetch>().mockResolvedValue(json({ error: { code: 'unauthorized', message: 'DO NOT DISPLAY password or SQL' } }, 401)));
    await expect(api.session()).rejects.toMatchObject({ message: 'unauthorized' });
    expect(uncertainOutcome(new ApiError(401, 'unauthorized'))).toBe(false);
    expect(uncertainOutcome(new ApiError(503, 'temporarily_unavailable'))).toBe(true);
    expect(uncertainOutcome(new TypeError('network'))).toBe(true);
    expect(uncertainOutcome(new ProtocolError())).toBe(true);
  });
  it('keeps the same UUID/payload on explicit retries and checks operations via GET', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(json({ error: { code: 'operation_not_found' } }, 404))
      .mockResolvedValueOnce(json({ operation_id: operation.operation_id, hidden: [], already_hidden: [id] }));
    const api = new AdminApi(fetcher);
    await expect(api.hide(operation, 'csrf')).rejects.toThrow();
    await expect(api.operation(operation)).rejects.toMatchObject({ status: 404 });
    await api.hide(operation, 'csrf');
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[2]?.[1]?.body);
    expect(fetcher.mock.calls[1]?.[0]).toBe(`/api/admin/operations/${operation.operation_id}`);
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('GET');
  });
});

it('parses both Retry-After seconds and HTTP dates, with a safe fallback', () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  expect(retryDeadline('5', now)).toBe(now + 5000);
  expect(retryDeadline('Tue, 01 Jan 2030 00:00:10 GMT', now)).toBe(now + 10000);
  expect(retryDeadline(null, now)).toBe(now + 30000);
  expect(retryDeadline('-1', now)).toBe(now + 30000);
});
