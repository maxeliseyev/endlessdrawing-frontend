// Wire source: ../endless-drawing-backend/docs/admin-api.md (from repo root).
import { object, ProtocolError, text, uuid } from '../wire';
export { object, ProtocolError, text, uuid };

export function timestamp(value: unknown): string {
  const result = text(value, 64);
  if (!Number.isFinite(Date.parse(result))) throw new ProtocolError();
  return result;
}

export interface AdminSession {
  authenticated: true;
  account: { id: string; login: string };
  csrf_token: string;
  expires_at: string;
  idle_expires_at: string;
  auth_method: 'passkey_uv' | 'totp';
}
export interface LoginOptions { csrf_token: string; expires_at: string; authenticator_policy: 'passkey_uv' }
export interface Ceremony { webauthn: Record<string, unknown>; expires_at: string }
export interface EnrollmentResult { registered_credentials: number; required_credentials: number; complete: boolean }
export interface HideOperation { operation_id: string; stroke_ids: readonly string[]; reason: string }
export interface HideResult { operation_id: string; hidden: string[]; already_hidden: string[] }

export function parseSession(value: unknown): AdminSession {
  const v = object(value);
  const account = object(v.account);
  if (v.authenticated !== true || (v.auth_method !== undefined && v.auth_method !== 'passkey_uv' && v.auth_method !== 'totp')) throw new ProtocolError();
  return { authenticated: true, account: { id: uuid(account.id), login: text(account.login, 128) },
    csrf_token: text(v.csrf_token), expires_at: timestamp(v.expires_at), idle_expires_at: timestamp(v.idle_expires_at), auth_method: v.auth_method === 'totp' ? 'totp' : 'passkey_uv' };
}
export function parseLoginOptions(value: unknown): LoginOptions {
  const v = object(value);
  if (v.authenticator_policy !== 'passkey_uv') throw new ProtocolError();
  return { csrf_token: text(v.csrf_token), expires_at: timestamp(v.expires_at), authenticator_policy: 'passkey_uv' };
}
export function parseCeremony(value: unknown, login: boolean): Ceremony {
  const v = object(value);
  if (login && v.status !== 'mfa_required') throw new ProtocolError();
  const webauthn = object(v.webauthn);
  object(webauthn.publicKey);
  return { webauthn, expires_at: timestamp(v.expires_at) };
}
export function parseEnrollment(value: unknown): EnrollmentResult {
  const v = object(value);
  if (!Number.isSafeInteger(v.registered_credentials) || !Number.isSafeInteger(v.required_credentials) ||
      typeof v.complete !== 'boolean') throw new ProtocolError();
  const registered = v.registered_credentials as number;
  const required = v.required_credentials as number;
  if (registered < 1 || (required !== 1 && required !== 2) || registered > 2 || v.complete !== (registered >= required)) throw new ProtocolError();
  return { registered_credentials: registered, required_credentials: required, complete: v.complete };
}
export function parseHideResult(value: unknown, expected: HideOperation): HideResult {
  const v = object(value);
  if (uuid(v.operation_id) !== expected.operation_id || !Array.isArray(v.hidden) || !Array.isArray(v.already_hidden)) throw new ProtocolError();
  const hidden = v.hidden.map(uuid);
  const already = v.already_hidden.map(uuid);
  const all = [...hidden, ...already];
  if (all.length !== expected.stroke_ids.length || new Set(all).size !== all.length ||
      all.some((id) => !expected.stroke_ids.includes(id))) throw new ProtocolError();
  return { operation_id: expected.operation_id, hidden, already_hidden: already };
}

export type Decision = 'hide' | 'dismiss' | 'ban';
export interface DismissResult { operation_id: string; restored: string[]; dismissed_reports: number }
export interface BanResult { operation_id: string; banned_authors: number; hidden: string[] }
export const REPORT_REASONS = ['sexual', 'violence', 'hate', 'illegal', 'spam', 'other'] as const;
export type ReportReason = typeof REPORT_REASONS[number];
export interface ReportItem {
  stroke_id: string; reports: number; reporters: number; reasons: ReportReason[]; block_requests: number;
  first_at: string; last_at: string; held: boolean; visible: boolean; x: number; y: number;
}
export interface ReportQueue { open_reports: number; items: ReportItem[] }

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ProtocolError();
  return value as number;
}

export function parseDismissResult(value: unknown, expected: HideOperation): DismissResult {
  const v = object(value);
  if (uuid(v.operation_id) !== expected.operation_id || !Array.isArray(v.restored)) throw new ProtocolError();
  const restored = v.restored.map(uuid);
  if (restored.some((id) => !expected.stroke_ids.includes(id))) throw new ProtocolError();
  return { operation_id: expected.operation_id, restored, dismissed_reports: count(v.dismissed_reports) };
}

export function parseBanResult(value: unknown, expected: HideOperation): BanResult {
  const v = object(value);
  if (uuid(v.operation_id) !== expected.operation_id || !Array.isArray(v.hidden) || v.hidden.length > 20_000) throw new ProtocolError();
  return { operation_id: expected.operation_id, banned_authors: count(v.banned_authors), hidden: v.hidden.map(uuid) };
}

export function parseReportQueue(value: unknown): ReportQueue {
  const v = object(value);
  if (!Array.isArray(v.items) || v.items.length > 200) throw new ProtocolError();
  const items = v.items.map((raw): ReportItem => {
    const item = object(raw);
    if (!Array.isArray(item.reasons) || !item.reasons.every((r) => (REPORT_REASONS as readonly unknown[]).includes(r)) ||
        typeof item.held !== 'boolean' || typeof item.visible !== 'boolean' ||
        !Number.isFinite(item.x) || !Number.isFinite(item.y)) throw new ProtocolError();
    return { stroke_id: uuid(item.stroke_id), reports: count(item.reports), reporters: count(item.reporters),
      reasons: item.reasons as ReportReason[], block_requests: count(item.block_requests),
      first_at: timestamp(item.first_at), last_at: timestamp(item.last_at), held: item.held, visible: item.visible,
      x: item.x as number, y: item.y as number };
  });
  return { open_reports: count(v.open_reports), items };
}

export function validReason(reason: string): boolean {
  const normalized = reason.trim();
  return normalized.length > 0 && [...normalized].length <= 1000 && new TextEncoder().encode(normalized).byteLength <= 4000;
}
export function makeHideOperation(ids: Iterable<string>, reason: string, id = crypto.randomUUID()): HideOperation {
  const strokeIds = [...new Set(Array.from(ids, uuid))].sort();
  if (!validReason(reason) || strokeIds.length < 1 || strokeIds.length > 100) throw new ProtocolError();
  return Object.freeze({ operation_id: uuid(id), stroke_ids: Object.freeze(strokeIds), reason: reason.trim() });
}
