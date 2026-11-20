import './style.css';
import QRCode from 'qrcode';
import { resolveLocale } from '../i18n';
import { AdminApi, ApiError, uncertainOutcome } from './api';
import { makeHideOperation, ProtocolError, validReason, type AdminSession, type Decision, type HideOperation, type ReportQueue } from './contracts';
import { adminTranslations } from './i18n';
import { AdminView } from './view';
import type { WorldStatus } from './world';
import { authenticate, PasskeyError, register } from './webauthn';

const locale = resolveLocale(navigator.languages, navigator.language);
const t = adminTranslations[locale];
document.documentElement.lang = locale;
document.title = t.title;
const root = document.querySelector<HTMLElement>('#admin-app');
if (!root) throw new Error('Missing admin root');
root.removeAttribute('aria-busy');
const notice = document.createElement('p');
notice.className = 'notice'; notice.setAttribute('role', 'status'); notice.hidden = true;
const content = document.createElement('div'); content.className = 'content';
root.append(notice, content);
const api = new AdminApi();
let epoch = 0;
let lifetime = new AbortController();
let session: AdminSession | undefined;
let view: AdminView | undefined;
let sessionTimer: ReturnType<typeof setTimeout> | undefined;
let focusCheck = false;
// Non-secret setup guidance lives only in RAM. Never retain password/token/assertions.
let rememberedLogin = '';
let enrollmentProgress: { login: string; registered: number; required: number } | undefined;
let authRetryAt = 0;
let authTimer: ReturnType<typeof setTimeout> | undefined;

function rememberCooldown(error: unknown): void {
  if (error instanceof ApiError && error.status === 429) authRetryAt = Math.max(authRetryAt, error.retryAt);
}

function status(message = '', error = false): void {
  notice.textContent = message; notice.hidden = !message;
  notice.classList.toggle('error', error);
}
function errorText(error: unknown): string {
  const code = error instanceof ApiError || error instanceof PasskeyError ? error.code
    : error instanceof ProtocolError ? 'invalid_response' : 'network';
  return t.errors[code as keyof typeof t.errors] ?? t.errors.network;
}
function reset(): number {
  epoch++; lifetime.abort(); lifetime = new AbortController();
  clearTimeout(sessionTimer); clearTimeout(authTimer); session = undefined;
  view?.dispose(); view = undefined;
  content.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach((dialog) => dialog.close());
  content.querySelectorAll<HTMLInputElement>('input[type=password]').forEach((input) => { input.value = ''; });
  content.replaceChildren();
  return epoch;
}
function required<T extends Element>(host: ParentNode, selector: string): T {
  const element = host.querySelector<T>(selector);
  if (!element) throw new Error('Missing admin control');
  return element;
}
function button(label: string, action: () => void): HTMLButtonElement {
  const result = document.createElement('button');
  result.type = 'button'; result.textContent = label; result.addEventListener('click', action);
  return result;
}
function messageCard(message: string): HTMLDivElement {
  const card = document.createElement('div'); card.className = 'auth-card';
  const p = document.createElement('p'); p.textContent = message; card.append(p); content.append(card);
  return card;
}
function scheduleExpiry(value: AdminSession): void {
  const remaining = Math.min(Date.parse(value.expires_at), Date.parse(value.idle_expires_at)) - Date.now();
  if (remaining <= 0) { showAuth('login', t.sessionExpired); return; }
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => showAuth('login', t.sessionExpired), Math.min(remaining, 2_147_483_647));
}

async function bootstrap(): Promise<void> {
  const current = reset(); status(); messageCard(t.checking);
  try {
    const value = await api.session(lifetime.signal);
    if (current === epoch) enterWorld(value);
  } catch (error) {
    if (current !== epoch) return;
    rememberCooldown(error);
    showAuth('login', error instanceof ApiError && error.status === 401 ? '' : errorText(error));
  }
}

function showAuth(mode: 'login' | 'enroll' | 'totp', message = ''): void {
  const current = reset(); status(message);
  const card = document.createElement('section'); card.className = 'auth-card';
  card.innerHTML = `
    <h1>${mode === 'enroll' ? t.enrollment : t.loginTitle}</h1>
    <p class="hint">${mode === 'login' ? t.signInHint : mode === 'totp' ? t.totpLoginHint : t.enrollmentHint}</p>
    ${mode === 'enroll' ? `<ol class="setup-steps"><li>${t.primaryStep}</li><li>${t.backupStep}</li><li>${t.loginStep}</li></ol>` : `<p class="hint">${t.firstTimeHint}</p>`}
    <p class="setup-progress" hidden></p>
    <form method="post">
      <label>${t.login}<input name="login" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="moderator" required maxlength="128" /></label>
      <p class="hint">${t.loginHelp}</p>
      <label>${t.password}<input name="password" type="password" autocomplete="current-password" required minlength="20" /></label>
      ${mode === 'enroll' ? `<label>${t.token}<input name="enrollment_token" type="password" autocomplete="off" required /></label>
        <label>${t.keyLabel}<input name="label" autocomplete="off" required maxlength="64" /></label>` : ''}
      ${mode === 'totp' ? `<label>${t.code}<input name="code" type="password" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required /></label>` : ''}
      <button type="submit">${mode === 'login' ? t.signIn : mode === 'totp' ? t.totpSignIn : t.register}</button>
    </form>
    <p class="hint">${t.httpsHint}</p>
  `;
  content.append(card);
  const form = required<HTMLFormElement>(card, 'form');
  const login = required<HTMLInputElement>(form, '[name=login]');
  const password = required<HTMLInputElement>(form, '[name=password]');
  const submit = required<HTMLButtonElement>(form, '[type=submit]');
  login.value = rememberedLogin;
  if (mode === 'login') card.append(button(t.totpLogin, () => showAuth('totp')));
  card.append(button(mode === 'login' ? t.enrollment : t.back, () => showAuth(mode === 'login' ? 'enroll' : 'login')));
  const retry = button(t.retry, () => { void bootstrap(); }); card.append(retry);
  const progress = required<HTMLParagraphElement>(card, '.setup-progress');
  let busy = false;
  function updateControls(): void {
    if (current !== epoch) return;
    clearTimeout(authTimer);
    const remaining = Math.max(0, authRetryAt - Date.now());
    const unfinished = enrollmentProgress && enrollmentProgress.login === login.value.trim();
    progress.hidden = !unfinished;
    if (unfinished) progress.textContent = t.registered(enrollmentProgress!.registered, enrollmentProgress!.required);
    submit.disabled = busy || remaining > 0 || (mode === 'login' && !!unfinished);
    retry.disabled = busy || remaining > 0;
    form.querySelectorAll<HTMLInputElement>('input').forEach((input) => { input.disabled = busy || remaining > 0; });
    if (remaining > 0) {
      const seconds = Math.ceil(remaining / 1000);
      status(t.retryCountdown(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`), true);
      authTimer = setTimeout(updateControls, Math.min(1000, remaining));
    } else if (authRetryAt > 0) {
      authRetryAt = 0; status(t.retryReady);
    }
  }
  login.addEventListener('input', updateControls);
  updateControls();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy || submit.disabled || current !== epoch) return;
    void (async () => {
      busy = true; updateControls(); status(t.working);
      const token = form.querySelector<HTMLInputElement>('[name=enrollment_token]');
      const label = form.querySelector<HTMLInputElement>('[name=label]');
      const loginName = login.value.trim(); rememberedLogin = loginName;
      const codeField = form.querySelector<HTMLInputElement>('[name=code]');
      let code = codeField?.value ?? '';
      let secret = password.value;
      let enrollmentToken = token?.value ?? '';
      password.value = ''; if (token) token.value = ''; if (codeField) codeField.value = '';
      let ceremonyTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        if ([...secret].length < 20 || new TextEncoder().encode(secret).byteLength > 1024) throw new ApiError(400, 'invalid_request');
        const options = await api.loginOptions(lifetime.signal);
        if (current !== epoch) return;
        if (Date.parse(options.expires_at) <= Date.now()) throw new ProtocolError();
        if (mode === 'totp') {
          if (!/^[0-9]{6}$/.test(code)) throw new ApiError(400, 'invalid_request');
          const value = await api.loginTotp(loginName, secret, code, options.csrf_token, lifetime.signal);
          if (current === epoch) enterWorld(value);
          return;
        }
        const response = mode === 'login'
          ? await api.login(loginName, secret, options.csrf_token, lifetime.signal)
          : await api.enrollmentStart(loginName, secret, enrollmentToken, label?.value ?? '', options.csrf_token, lifetime.signal);
        secret = ''; enrollmentToken = '';
        if (current !== epoch) return;
        const remaining = Date.parse(response.expires_at) - Date.now();
        if (remaining <= 0) throw new ProtocolError();
        const ceremony = new AbortController();
        const abort = () => ceremony.abort();
        lifetime.signal.addEventListener('abort', abort, { once: true });
        ceremonyTimer = setTimeout(abort, Math.min(remaining, 120_000));
        status(t.passkeyPrompt);
        try {
          if (mode === 'login') {
            const credential = await authenticate(response.webauthn, ceremony.signal);
            if (current !== epoch) return;
            const value = await api.verify(credential, options.csrf_token, lifetime.signal);
            if (current === epoch) enterWorld(value);
          } else {
            const credential = await register(response.webauthn, ceremony.signal);
            if (current !== epoch) return;
            const result = await api.enrollmentFinish(credential, options.csrf_token, lifetime.signal);
            if (current === epoch) {
              enrollmentProgress = result.complete ? undefined : { login: loginName, registered: result.registered_credentials, required: result.required_credentials };
              showAuth(result.complete ? 'login' : 'enroll',
                result.complete ? t.enrollmentComplete : t.registered(result.registered_credentials, result.required_credentials));
            }
          }
        } finally { lifetime.signal.removeEventListener('abort', abort); }
      } catch (error) {
        if (current === epoch) { rememberCooldown(error); status(errorText(error), true); }
      } finally {
        secret = ''; enrollmentToken = ''; code = ''; clearTimeout(ceremonyTimer);
        if (current === epoch) { busy = false; updateControls(); }
      }
    })();
  });
}

async function totpSettings(current: number, value: AdminSession): Promise<void> {
  if (content.querySelector('.totp-dialog')) return;
  const dialog = document.createElement('dialog'); dialog.className = 'totp-dialog';
  const heading = document.createElement('h2'); heading.textContent = t.totpSettings;
  const body = document.createElement('div'); const info = document.createElement('p'); info.setAttribute('role', 'status');
  dialog.append(heading, info, body); content.append(dialog);
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const clean = () => {
    clearTimeout(expiry);
    dialog.querySelectorAll<HTMLInputElement>('input').forEach((input) => { input.value = ''; });
    dialog.querySelectorAll('canvas').forEach((canvas) => { canvas.width = 0; canvas.height = 0; });
    dialog.close(); dialog.remove(); lifetime.signal.removeEventListener('abort', clean);
  };
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); clean(); });
  dialog.append(button(t.close, clean)); lifetime.signal.addEventListener('abort', clean, { once: true }); dialog.showModal();
  const active = () => current === epoch && dialog.isConnected;
  const fail = (error: unknown) => { if (active()) info.textContent = errorText(error); };
  try {
    const state = await api.totpStatus(lifetime.signal); if (!active()) return;
    if (!state.available) { info.textContent = t.totpUnavailable; return; }
    if (!state.fresh_passkey) {
      info.textContent = t.totpFresh;
      body.append(button(t.totpReauth, () => { clean(); showAuth('login', t.totpFresh); })); return;
    }
    if (state.enabled) {
      info.textContent = t.totpEnabled;
      body.append(button(t.totpDisable, () => {
        body.replaceChildren(button(t.totpDisableConfirm, () => { void (async () => {
          try { await api.totpDisable(value.csrf_token, lifetime.signal); if (active()) { clean(); status(t.totpDisabled); } }
          catch (error) { fail(error); }
        })(); }));
      })); return;
    }
    body.append(button(t.totpEnable, () => { void (async () => {
      body.querySelectorAll('button').forEach((control) => { control.disabled = true; });
      try {
        const setup = await api.totpStart(value.csrf_token, lifetime.signal);
        if (!active()) { setup.secret = ''; setup.otpauth_uri = ''; return; }
        const remaining = Date.parse(setup.expires_at) - Date.now();
        if (remaining <= 0) { setup.secret = ''; setup.otpauth_uri = ''; info.textContent = t.totpExpired; body.replaceChildren(); return; }
        body.replaceChildren(); info.textContent = t.totpScan;
        const canvas = document.createElement('canvas'); canvas.className = 'totp-qr'; canvas.setAttribute('aria-label', t.totpSettings);
        const manual = document.createElement('label'); manual.textContent = t.totpManual;
        const secret = document.createElement('input'); secret.type = 'password'; secret.readOnly = true; secret.autocomplete = 'off'; secret.value = setup.secret; manual.append(secret);
        const form = document.createElement('form');
        const label = document.createElement('label'); label.textContent = t.code;
        const input = document.createElement('input'); input.name = 'totp_code'; input.type = 'password'; input.inputMode = 'numeric'; input.autocomplete = 'one-time-code'; input.pattern = '[0-9]{6}'; input.minLength = 6; input.maxLength = 6; input.required = true; label.append(input);
        const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = t.totpConfirm;
        form.append(label, submit); body.append(canvas, manual, button(t.revealSetup, () => { secret.type = secret.type === 'password' ? 'text' : 'password'; }), form);
        expiry = setTimeout(() => { if (active()) { body.querySelectorAll('input').forEach((field) => { field.value = ''; }); canvas.width = 0; canvas.height = 0; body.replaceChildren(); info.textContent = t.totpExpired; } }, remaining);
        try { await QRCode.toCanvas(canvas, setup.otpauth_uri, { width: 240, margin: 2 }); }
        finally { setup.secret = ''; setup.otpauth_uri = ''; }
        if (!active()) { canvas.width = 0; canvas.height = 0; return; }
        let busy = false;
        form.addEventListener('submit', (event) => { event.preventDefault(); if (busy) return;
          void (async () => {
            busy = true; submit.disabled = true; let code = input.value; input.value = '';
            try {
              if (!/^[0-9]{6}$/.test(code)) throw new ApiError(400, 'invalid_request');
              await api.totpConfirm(code, value.csrf_token, lifetime.signal);
              if (active()) { clean(); status(t.totpEnabled); }
            } catch (error) { fail(error); }
            finally { code = ''; busy = false; submit.disabled = false; }
          })();
        });
      } catch (error) { fail(error); }
    })(); }));
  } catch (error) { fail(error); }
}

async function refreshSession(current: number): Promise<void> {
  if (!session || focusCheck) return;
  focusCheck = true;
  try {
    const value = await api.session(lifetime.signal);
    if (current === epoch && session) { session = value; scheduleExpiry(value); }
  } catch (error) {
    if (current === epoch && error instanceof ApiError && error.status === 401) showAuth('login', t.sessionExpired);
  } finally { focusCheck = false; }
}

function logout(): void {
  if (!session) return;
  const csrf = session.csrf_token;
  const current = reset(); status();
  const card = messageCard(t.working);
  const retry = button(t.logout, () => { void attempt(); }); retry.disabled = true; card.append(retry);
  async function attempt(): Promise<void> {
    retry.disabled = true;
    try {
      await api.logout(csrf, lifetime.signal);
      if (current === epoch) showAuth('login');
    } catch (error) {
      if (current !== epoch) return;
      if (error instanceof ApiError && error.status === 401) showAuth('login');
      else { status(`${t.logoutFailed} ${errorText(error)}`, true); retry.disabled = false; }
    }
  }
  void attempt();
}

function enterWorld(value: AdminSession): void {
  const current = reset(); session = value; status();
  scheduleExpiry(value);
  if (!session) return;
  const layout = document.createElement('section'); layout.className = 'moderation-layout';
  layout.innerHTML = `
    <header><h1>${t.moderation}</h1><span class="account"></span><div class="toolbar"></div></header>
    <p class="world-status" role="status"></p>
    <div class="workspace"><div class="world-host"></div><aside>
      <section class="reports" aria-labelledby="reports-title"><div class="reports-head"><h2 id="reports-title" class="reports-title"></h2></div>
        <ul class="reports-list"></ul></section>
      <h2 class="selection-count"></h2><p class="hint">${t.selectionHint}</p>
      <div class="selection-actions"></div><ul class="selection-list"></ul><div class="operation-panel"></div>
    </aside></div>
    <dialog aria-labelledby="confirmation-title"><form method="post">
      <h2 id="confirmation-title">${t.confirmTitle}</h2><ul class="confirmation-ids"></ul>
      <label>${t.reason}<textarea name="reason" required rows="5" aria-describedby="reason-hint"></textarea></label>
      <p class="hint" id="reason-hint">${t.reasonHint}</p><p class="form-error" role="status"></p>
      <button type="submit">${t.confirm}</button><button type="button" class="cancel">${t.cancel}</button>
    </form></dialog>
  `;
  content.append(layout);
  required(layout, '.account').textContent = value.account.login;
  const toolbar = required<HTMLElement>(layout, '.toolbar');
  toolbar.append(button(t.totpSettings, () => { void totpSettings(current, value); }));
  const worldStatus = required<HTMLElement>(layout, '.world-status');
  const selectionCount = required<HTMLElement>(layout, '.selection-count');
  const list = required<HTMLElement>(layout, '.selection-list');
  const panel = required<HTMLElement>(layout, '.operation-panel');
  const dialog = required<HTMLDialogElement>(layout, 'dialog');
  const reason = required<HTMLTextAreaElement>(dialog, '[name=reason]');
  const dialogError = required<HTMLElement>(dialog, '.form-error');
  let pending: { kind: Decision; payload: HideOperation; state: 'sending' | 'unknown' | 'rejected'; error?: string } | undefined;
  let confirmedIds: readonly string[] = [];
  // What the open dialog decides: the canvas selection (hide or ban) or one reported stroke (any decision).
  let target: { kind: Decision; fromSelection: boolean } = { kind: 'hide', fromSelection: true };
  const reportsTitle = required<HTMLElement>(layout, '.reports-title');
  const reportsList = required<HTMLElement>(layout, '.reports-list');
  const reportsHead = required<HTMLElement>(layout, '.reports-head');
  let queue: ReportQueue | undefined;
  function openDialog(kind: Decision, ids: readonly string[], fromSelection: boolean): void {
    if (pending || !view) return;
    target = { kind, fromSelection }; confirmedIds = [...ids]; reason.value = ''; dialogError.textContent = '';
    required<HTMLElement>(dialog, '#confirmation-title').textContent = t.decisionTitle[kind] ?? '';
    required<HTMLElement>(dialog, 'button[type=submit]').textContent = t.decisionConfirm[kind] ?? '';
    const list = required<HTMLElement>(dialog, '.confirmation-ids'); list.replaceChildren();
    for (const id of confirmedIds) { const li = document.createElement('li'); li.textContent = id; list.append(li); }
    view.lock(true); dialog.showModal(); reason.focus();
  }
  function renderReports(): void {
    reportsList.replaceChildren();
    if (!queue) { reportsTitle.textContent = t.reports(0); return; }
    reportsTitle.textContent = t.reports(queue.open_reports);
    if (!queue.items.length) { const li = document.createElement('li'); li.textContent = t.reportsEmpty; reportsList.append(li); }
    for (const item of queue.items) {
      const li = document.createElement('li'); li.className = item.held ? 'report held' : 'report';
      const reasons = document.createElement('p'); reasons.className = 'report-reasons';
      reasons.textContent = item.reasons.map((reason) => t.reasonNames[reason] ?? reason).join(', ');
      const meta = document.createElement('p'); meta.className = 'hint';
      meta.textContent = `${t.reportMeta(item.reports, item.reporters, item.block_requests)} · ${new Date(item.last_at).toLocaleString()}`;
      li.append(reasons, meta);
      if (item.held || !item.visible) { const state = document.createElement('p'); state.className = 'report-state'; state.textContent = item.held ? t.reportHeld : t.reportGone; li.append(state); }
      const actions = document.createElement('div'); actions.className = 'report-actions';
      actions.append(
        button(t.reportShow, () => view?.jumpTo(item.x, item.y)),
        button(t.reportHide, () => openDialog('hide', [item.stroke_id], false)),
        button(t.reportDismiss, () => openDialog('dismiss', [item.stroke_id], false)),
        button(t.reportBan, () => openDialog('ban', [item.stroke_id], false)),
      );
      for (const action of actions.querySelectorAll('button')) action.disabled = !!pending;
      li.append(actions); reportsList.append(li);
    }
  }
  async function loadReports(): Promise<void> {
    try { const next = await api.reports(lifetime.signal); if (current === epoch) { queue = next; renderReports(); } }
    catch (error) {
      if (current !== epoch) return;
      if (error instanceof ApiError && error.status === 401) { showAuth('login', t.sessionExpired); return; }
      reportsTitle.textContent = t.reportsFailed;
    }
  }
  reportsHead.append(button(t.reportsRefresh, () => { void loadReports(); }));
  const reportsTimer = setInterval(() => { if (current !== epoch) clearInterval(reportsTimer); else if (!pending) void loadReports(); }, 60_000);
  void loadReports();
  let mode: 'select' | 'hand' = 'select';
  const select = button(t.select, () => { mode = 'select'; view?.setMode(mode); updateModes(); });
  const hand = button(t.hand, () => { mode = 'hand'; view?.setMode(mode); updateModes(); });
  function updateModes(): void { select.setAttribute('aria-pressed', String(mode === 'select')); hand.setAttribute('aria-pressed', String(mode === 'hand')); }
  const reload = button(t.refresh, () => view?.refresh());
  const zoomOut = button('−', () => view?.zoomOut()); zoomOut.setAttribute('aria-label', t.zoomOut);
  const zoomLabel = document.createElement('span'); zoomLabel.className = 'zoom-label'; zoomLabel.textContent = '100%';
  const zoomIn = button('+', () => view?.zoomIn()); zoomIn.setAttribute('aria-label', t.zoomIn);
  const jumpX = document.createElement('input'); jumpX.type = 'number'; jumpX.inputMode = 'decimal'; jumpX.placeholder = 'X'; jumpX.title = t.jumpTitle;
  const jumpY = document.createElement('input'); jumpY.type = 'number'; jumpY.inputMode = 'decimal'; jumpY.placeholder = 'Y'; jumpY.title = t.jumpTitle;
  const jump = button(t.jump, () => {
    if (jumpX.value === '' || jumpY.value === '') return;
    const x = Number(jumpX.value); const y = Number(jumpY.value);
    if (Number.isFinite(x) && Number.isFinite(y)) view?.jumpTo(x, y);
  });
  jump.title = t.jumpTitle;
  toolbar.append(select, hand, reload, zoomOut, zoomLabel, zoomIn, jumpX, jumpY, jump, button(t.logout, logout)); updateModes();
  const clear = button(t.clear, () => view?.clear());
  const review = button(t.hide, () => {
    if (!view || view.status !== 'ready' || pending || !view.selection.length) return;
    openDialog('hide', view.selection, true);
  });
  // Any selected stroke, reported or not: bans its author(s) and hides all their strokes (POST /api/admin/bans).
  const banAuthors = button(t.banSelection, () => {
    if (!view || view.status !== 'ready' || pending || !view.selection.length) return;
    openDialog('ban', view.selection, true);
  });
  banAuthors.className = 'danger';
  required(layout, '.selection-actions').append(clear, review, banAuthors);
  required<HTMLButtonElement>(dialog, '.cancel').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    // close is asynchronous: an old event must not clear a newly reopened form.
    if (!dialog.open) { reason.value = ''; view?.lock(!!pending); }
  });
  required<HTMLFormElement>(dialog, 'form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!view || pending || (target.fromSelection && (view.status !== 'ready' || view.selection.join() !== confirmedIds.join()))) {
      dialogError.textContent = t.selectionChanged; return;
    }
    if (!validReason(reason.value)) { dialogError.textContent = t.invalidReason; return; }
    pending = { kind: target.kind, payload: makeHideOperation(confirmedIds, reason.value), state: 'sending' };
    dialog.close(); void execute('send');
  });
  function update(ids: readonly string[], state: WorldStatus): void {
    selectionCount.textContent = t.selection(ids.length);
    worldStatus.textContent = t[state];
    list.replaceChildren();
    if (!ids.length) { const li = document.createElement('li'); li.textContent = t.emptySelection; list.append(li); }
    for (const id of ids) {
      const li = document.createElement('li'); const code = document.createElement('code'); code.textContent = id;
      const remove = button('×', () => view?.deselect(id)); remove.setAttribute('aria-label', t.removeSelection(id)); remove.disabled = !!pending;
      li.append(code, remove); list.append(li);
    }
    clear.disabled = !!pending || !ids.length;
    review.disabled = banAuthors.disabled = !!pending || !ids.length || state !== 'ready';
    reload.disabled = select.disabled = hand.disabled = !!pending;
    view?.lock(!!pending || dialog.open);
  }
  function operationPanel(): void {
    panel.replaceChildren();
    if (!pending) return;
    const p = document.createElement('p'); p.textContent = pending.state === 'sending' ? t.sending : pending.state === 'unknown' ? t.unknown : pending.error ?? '';
    const code = document.createElement('code'); code.textContent = `${t.operation}: ${pending.payload.operation_id}`;
    panel.append(p, code);
    if (pending.error && pending.state === 'unknown') { const error = document.createElement('p'); error.textContent = pending.error; panel.append(error); }
    if (pending.state !== 'sending') {
      panel.append(button(t.checkOperation, () => { void execute('check'); }));
      panel.append(button(t.retryOperation, () => { void execute('send'); }));
      if (pending.state === 'rejected') panel.append(button(t.editSelection, () => {
        pending = undefined; operationPanel(); if (view) update(view.selection, view.status);
      }));
    }
  }
  async function execute(kind: 'send' | 'check'): Promise<void> {
    if (!pending || !session || current !== epoch) return;
    const operation = pending.payload;
    const decision = pending.kind;
    const wasUnknown = pending.state === 'unknown';
    pending.state = 'sending'; pending.error = undefined;
    operationPanel(); renderReports(); if (view) update(view.selection, view.status);
    try {
      const csrf = session.csrf_token;
      const result = kind === 'check' ? await api.decision(decision, operation, lifetime.signal)
        : decision === 'hide' ? await api.hide(operation, csrf, lifetime.signal)
          : decision === 'dismiss' ? await api.dismiss(operation, csrf, lifetime.signal)
            : await api.ban(operation, csrf, lifetime.signal);
      if (current !== epoch) return;
      pending = undefined;
      if ('already_hidden' in result) {
        view?.remove([...result.hidden, ...result.already_hidden]);
        status(t.success(result.hidden.length, result.already_hidden.length));
      } else if ('restored' in result) {
        status(t.dismissed(result.dismissed_reports, result.restored.length));
      } else {
        view?.remove(result.hidden);
        status(t.banned(result.banned_authors, result.hidden.length));
      }
      void loadReports();
      void refreshSession(current);
    } catch (error) {
      if (current !== epoch) return;
      if (error instanceof ApiError && error.status === 401) { showAuth('login', t.sessionExpired); return; }
      if (!pending) return;
      pending.state = wasUnknown || kind === 'check' || uncertainOutcome(error) ? 'unknown' : 'rejected';
      pending.error = kind === 'check' && error instanceof ApiError && error.status === 404 ? t.operationMissing : errorText(error);
    } finally {
      if (current === epoch) { operationPanel(); renderReports(); if (view) update(view.selection, view.status); }
    }
  }
  try {
    view = new AdminView(required(layout, '.world-host'), t.canvas, (ids, state) => update(ids, state), () => status(t.limit, true), (camera) => {
      zoomLabel.textContent = `${Math.round((camera.zoom ?? 1) * 100)}%`;
    });
    update(view.selection, view.status);
  } catch (error) { showAuth('login', errorText(error)); }
}

window.addEventListener('focus', () => { if (session) void refreshSession(epoch); });
window.addEventListener('pagehide', () => { reset(); status(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) void bootstrap(); });
void bootstrap();
