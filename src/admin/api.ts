import {
  object, parseBanResult, parseCeremony, parseDismissResult, parseEnrollment, parseHideResult, parseLoginOptions,
  parseReportQueue, parseSession, ProtocolError, type Decision, type HideOperation,
} from './contracts';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAt = 0) {
    // Never put server message, credentials, body or URL into errors/logs.
    super(code);
  }
}

export function retryDeadline(header: string | null, now = Date.now()): number {
  if (!header) return now + 30_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds < 0) return now + 30_000;
  const deadline = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(header);
  return Number.isFinite(deadline) ? Math.max(now, deadline) : now + 30_000;
}

export function uncertainOutcome(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

export class AdminApi {
  private retryAt = 0;
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  private async request(path: string, body?: unknown, csrf?: string, signal?: AbortSignal): Promise<unknown> {
    if (Date.now() < this.retryAt) throw new ApiError(429, 'rate_limited', this.retryAt);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && new TextEncoder().encode(serialized).byteLength > 64 * 1024) throw new ApiError(413, 'payload_too_large');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (serialized !== undefined) {
      if (!csrf) throw new ProtocolError();
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = csrf;
    }
    // Compose manually: AbortSignal.any is missing in some supported Safari/Firefox versions.
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15_000);
    try {
      const response = await this.fetcher(`/api/admin/${path}`, {
        method: serialized === undefined ? 'GET' : 'POST', headers, body: serialized,
        credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) {
        let code = 'unknown_error';
        try {
          const error = object(object(await response.json()).error);
          if (typeof error.code === 'string' && /^[a-z_]{1,64}$/.test(error.code)) code = error.code;
        } catch { /* No raw response content enters the UI. */ }
        if (response.status === 429) this.retryAt = retryDeadline(response.headers.get('Retry-After'));
        throw new ApiError(response.status, code, response.status === 429 ? this.retryAt : 0);
      }
      if (response.status === 204) return undefined;
      const raw = await response.text();
      if (raw.length > 1_048_576) throw new ProtocolError();
      try { return JSON.parse(raw) as unknown; } catch { throw new ProtocolError(); }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async session(signal?: AbortSignal) { return parseSession(await this.request('session', undefined, undefined, signal)); }
  async loginOptions(signal?: AbortSignal) { return parseLoginOptions(await this.request('login/options', undefined, undefined, signal)); }
  async login(login: string, password: string, csrf: string, signal?: AbortSignal) {
    return parseCeremony(await this.request('login', { login, password }, csrf, signal), true);
  }
  async verify(credential: unknown, csrf: string, signal?: AbortSignal) {
    return parseSession(await this.request('login/verify', { credential }, csrf, signal));
  }
  async enrollmentStart(login: string, password: string, enrollment_token: string, label: string, csrf: string, signal?: AbortSignal) {
    return parseCeremony(await this.request('enrollment/start', { login, password, enrollment_token, label }, csrf, signal), false);
  }
  async enrollmentFinish(credential: unknown, csrf: string, signal?: AbortSignal) {
    return parseEnrollment(await this.request('enrollment/finish', { credential }, csrf, signal));
  }
  async loginTotp(login: string, password: string, code: string, csrf: string, signal?: AbortSignal) {
    return parseSession(await this.request('login/totp', { login, password, code }, csrf, signal));
  }
  async totpStatus(signal?: AbortSignal) {
    const v = object(await this.request('totp/status', undefined, undefined, signal));
    if (typeof v.available !== 'boolean' || typeof v.enabled !== 'boolean' || typeof v.fresh_passkey !== 'boolean') throw new ProtocolError();
    return { available: v.available, enabled: v.enabled, fresh_passkey: v.fresh_passkey };
  }
  async totpStart(csrf: string, signal?: AbortSignal) {
    const v = object(await this.request('totp/setup/start', {}, csrf, signal));
    if (typeof v.secret !== 'string' || !/^[A-Z2-7]{32}$/.test(v.secret) || typeof v.otpauth_uri !== 'string' || typeof v.expires_at !== 'string' || !Number.isFinite(Date.parse(v.expires_at))) throw new ProtocolError();
    const uri = new URL(v.otpauth_uri);
    if (uri.protocol !== 'otpauth:' || uri.hostname !== 'totp' || uri.searchParams.get('secret') !== v.secret) throw new ProtocolError();
    return { secret: v.secret, otpauth_uri: v.otpauth_uri, expires_at: v.expires_at };
  }
  async totpConfirm(code: string, csrf: string, signal?: AbortSignal) {
    if (await this.request('totp/setup/confirm', { code }, csrf, signal) !== undefined) throw new ProtocolError();
  }
  async totpDisable(csrf: string, signal?: AbortSignal) {
    if (await this.request('totp/disable', {}, csrf, signal) !== undefined) throw new ProtocolError();
  }
  async logout(csrf: string, signal?: AbortSignal) {
    if (await this.request('logout', {}, csrf, signal) !== undefined) throw new ProtocolError();
  }
  async hide(operation: HideOperation, csrf: string, signal?: AbortSignal) {
    return parseHideResult(await this.request('strokes/hide', operation, csrf, signal), operation);
  }
  async operation(operation: HideOperation, signal?: AbortSignal) {
    // The ID came from makeHideOperation(), never from an arbitrary path input.
    return parseHideResult(await this.request(`operations/${operation.operation_id}`, undefined, undefined, signal), operation);
  }
  async reports(signal?: AbortSignal) { return parseReportQueue(await this.request('reports', undefined, undefined, signal)); }
  async dismiss(operation: HideOperation, csrf: string, signal?: AbortSignal) {
    return parseDismissResult(await this.request('reports/dismiss', operation, csrf, signal), operation);
  }
  async ban(operation: HideOperation, csrf: string, signal?: AbortSignal) {
    return parseBanResult(await this.request('bans', operation, csrf, signal), operation);
  }
  /** Result of any decision by its operation ID (hide, dismiss or ban share the operation log). */
  async decision(kind: Decision, operation: HideOperation, signal?: AbortSignal) {
    const raw = await this.request(`operations/${operation.operation_id}`, undefined, undefined, signal);
    return kind === 'hide' ? parseHideResult(raw, operation) : kind === 'dismiss' ? parseDismissResult(raw, operation) : parseBanResult(raw, operation);
  }
}
