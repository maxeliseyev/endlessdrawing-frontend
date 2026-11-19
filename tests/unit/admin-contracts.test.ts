import { describe, expect, it } from 'vitest';
import { makeHideOperation, parseBanResult, parseCeremony, parseDismissResult, parseEnrollment, parseHideResult, parseLoginOptions, parseReportQueue, parseSession, ProtocolError, validReason } from '../../src/admin/contracts';

const id = '87a122fa-7537-4b88-9b77-b45d24a29714';
const operationId = '4df8a775-7e7e-4707-a747-58d6c87d7019';
const session = { authenticated: true, account: { id, login: '<moderator>' }, csrf_token: 'session-csrf',
  expires_at: '2030-01-01T00:00:00Z', idle_expires_at: '2029-12-31T23:00:00Z' };

describe('admin contract validation', () => {
  it('accepts only a full validated session, never password-only mfa_required', () => {
    expect(parseSession(session)).toEqual({ ...session, auth_method: 'passkey_uv' });
    for (const input of [{ status: 'mfa_required' }, { ...session, authenticated: false }, { ...session, csrf_token: '' },
      { ...session, idle_expires_at: 'broken' }, { ...session, account: { id: '../secret', login: 'x' } }]) {
      expect(() => parseSession(input)).toThrow(ProtocolError);
    }
  });
  it('requires passkey_uv and standard challenge wrappers', () => {
    const options = { csrf_token: 'preauth-csrf', expires_at: session.expires_at, authenticator_policy: 'passkey_uv' };
    expect(parseLoginOptions(options)).toEqual(options);
    expect(() => parseLoginOptions({ ...options, authenticator_policy: 'password' })).toThrow(ProtocolError);
    const ceremony = { status: 'mfa_required', webauthn: { publicKey: { challenge: 'AQID' } }, expires_at: session.expires_at };
    expect(parseCeremony(ceremony, true).webauthn).toEqual(ceremony.webauthn);
    expect(() => parseCeremony({ ...ceremony, status: 'authenticated' }, true)).toThrow(ProtocolError);
  });
  it('does not confuse enrollment completion with a session', () => {
    expect(parseEnrollment({ registered_credentials: 1, required_credentials: 2, complete: false }).complete).toBe(false);
    const complete = { registered_credentials: 2, required_credentials: 2, complete: true };
    expect(parseEnrollment(complete).complete).toBe(true);
    expect(() => parseSession(complete)).toThrow(ProtocolError);
    expect(() => parseEnrollment({ ...complete, registered_credentials: 1 })).toThrow(ProtocolError);
  });
});

describe('bounded atomic hide operations', () => {
  it('freezes normalized UUIDs/reason and preserves the payload for identical retries', () => {
    const operation = makeHideOperation([id.toUpperCase(), id], '  reason  ', operationId);
    expect(operation).toEqual({ operation_id: operationId, stroke_ids: [id], reason: 'reason' });
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.stroke_ids)).toBe(true);
    expect(parseHideResult({ operation_id: operationId, hidden: [id], already_hidden: [] }, operation).hidden).toEqual([id]);
  });
  it('requires exactly the requested set in a correlated result', () => {
    const operation = makeHideOperation([id], 'reason', operationId);
    for (const input of [
      { operation_id: id, hidden: [id], already_hidden: [] },
      { operation_id: operationId, hidden: [], already_hidden: [] },
      { operation_id: operationId, hidden: [id], already_hidden: [id] },
      { operation_id: operationId, hidden: [operationId], already_hidden: [] },
    ]) expect(() => parseHideResult(input, operation)).toThrow(ProtocolError);
  });
  it('counts Unicode scalar values and UTF-8 bytes rather than UTF-16 units', () => {
    expect(validReason('😀'.repeat(1000))).toBe(true);
    expect(validReason('😀'.repeat(1001))).toBe(false);
    expect(validReason('a'.repeat(1001))).toBe(false);
    expect(validReason(' \n ')).toBe(false);
    expect(validReason(' reason ')).toBe(true);
  });
  it('rejects missing, excessive or invalid IDs before sending', () => {
    expect(() => makeHideOperation([], 'reason')).toThrow();
    expect(() => makeHideOperation(['../../secret'], 'reason')).toThrow();
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(() => makeHideOperation(ids, 'reason')).toThrow();
  });
});

describe('report queue and decision results', () => {
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  const op = { operation_id: '00000000-0000-4000-8000-0000000000ff', stroke_ids: [A], reason: 'x' };
  const item = { stroke_id: A, reports: 3, reporters: 2, reasons: ['hate'], block_requests: 1,
    first_at: '2026-11-19T09:00:00Z', last_at: '2026-11-19T09:05:00Z', held: true, visible: false, x: 1.5, y: -2 };
  it('accepts the documented queue shape and rejects unknown reasons or bad counts', () => {
    expect(parseReportQueue({ open_reports: 3, items: [item] }).items[0]).toEqual(item);
    for (const bad of [{ ...item, reasons: ['<script>'] }, { ...item, reports: -1 }, { ...item, x: Infinity }, { ...item, stroke_id: 'x' }]) {
      expect(() => parseReportQueue({ open_reports: 1, items: [bad] })).toThrow();
    }
    expect(() => parseReportQueue({ open_reports: 0, items: Array(201).fill(item) })).toThrow();
  });
  it('binds dismiss and ban results to their operation', () => {
    expect(parseDismissResult({ operation_id: op.operation_id, restored: [A], dismissed_reports: 3 }, op).restored).toEqual([A]);
    expect(() => parseDismissResult({ operation_id: op.operation_id, restored: [B], dismissed_reports: 3 }, op)).toThrow();
    expect(() => parseDismissResult({ operation_id: B, restored: [], dismissed_reports: 0 }, op)).toThrow();
    expect(parseBanResult({ operation_id: op.operation_id, banned_authors: 1, hidden: [A, B] }, op).hidden).toEqual([A, B]);
    expect(() => parseBanResult({ operation_id: op.operation_id, banned_authors: -1, hidden: [] }, op)).toThrow();
  });
});
