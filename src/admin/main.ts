import './style.css';
import { resolveLocale } from '../i18n';
import { AdminApi, ApiError, uncertainOutcome } from './api';
import { makeHideOperation, ProtocolError, validReason, type AdminSession, type HideOperation } from './contracts';
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
  clearTimeout(sessionTimer); session = undefined;
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
    showAuth('login', error instanceof ApiError && error.status === 401 ? '' : errorText(error));
  }
}

function showAuth(mode: 'login' | 'enroll', message = ''): void {
  const current = reset(); status(message);
  const card = document.createElement('section'); card.className = 'auth-card';
  card.innerHTML = `
    <h1>${mode === 'login' ? t.loginTitle : t.enrollment}</h1>
    <p class="hint">${mode === 'login' ? t.signInHint : t.enrollmentHint}</p>
    <form method="post">
      <label>${t.login}<input name="login" autocomplete="username" required maxlength="128" /></label>
      <label>${t.password}<input name="password" type="password" autocomplete="current-password" required minlength="20" /></label>
      ${mode === 'enroll' ? `<label>${t.token}<input name="enrollment_token" type="password" autocomplete="off" required /></label>
        <label>${t.keyLabel}<input name="label" autocomplete="off" required maxlength="128" /></label>` : ''}
      <button type="submit">${mode === 'login' ? t.signIn : t.register}</button>
    </form>
    <p class="hint">${t.httpsHint}</p>
  `;
  content.append(card);
  const form = required<HTMLFormElement>(card, 'form');
  const login = required<HTMLInputElement>(form, '[name=login]');
  const password = required<HTMLInputElement>(form, '[name=password]');
  const submit = required<HTMLButtonElement>(form, '[type=submit]');
  card.append(button(mode === 'login' ? t.enrollment : t.back, () => showAuth(mode === 'login' ? 'enroll' : 'login')));
  card.append(button(t.retry, () => { void bootstrap(); }));
  let busy = false;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy || current !== epoch) return;
    void (async () => {
      busy = true; submit.disabled = true; status(t.working);
      const token = form.querySelector<HTMLInputElement>('[name=enrollment_token]');
      const label = form.querySelector<HTMLInputElement>('[name=label]');
      let secret = password.value;
      let enrollmentToken = token?.value ?? '';
      password.value = ''; if (token) token.value = '';
      let ceremonyTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        if ([...secret].length < 20 || new TextEncoder().encode(secret).byteLength > 1024) throw new ApiError(400, 'invalid_request');
        const options = await api.loginOptions(lifetime.signal);
        if (current !== epoch) return;
        if (Date.parse(options.expires_at) <= Date.now()) throw new ProtocolError();
        const response = mode === 'login'
          ? await api.login(login.value, secret, options.csrf_token, lifetime.signal)
          : await api.enrollmentStart(login.value, secret, enrollmentToken, label?.value ?? '', options.csrf_token, lifetime.signal);
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
            if (current === epoch) showAuth(result.complete ? 'login' : 'enroll',
              result.complete ? t.enrollmentComplete : t.registered(result.registered_credentials, result.required_credentials));
          }
        } finally { lifetime.signal.removeEventListener('abort', abort); }
      } catch (error) {
        if (current === epoch) status(errorText(error), true);
      } finally {
        secret = ''; enrollmentToken = ''; clearTimeout(ceremonyTimer);
        if (current === epoch) { busy = false; submit.disabled = false; }
      }
    })();
  });
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
  const worldStatus = required<HTMLElement>(layout, '.world-status');
  const selectionCount = required<HTMLElement>(layout, '.selection-count');
  const list = required<HTMLElement>(layout, '.selection-list');
  const panel = required<HTMLElement>(layout, '.operation-panel');
  const dialog = required<HTMLDialogElement>(layout, 'dialog');
  const reason = required<HTMLTextAreaElement>(dialog, '[name=reason]');
  const dialogError = required<HTMLElement>(dialog, '.form-error');
  let pending: { payload: HideOperation; state: 'sending' | 'unknown' | 'rejected'; error?: string } | undefined;
  let confirmedIds: readonly string[] = [];
  let mode: 'select' | 'hand' = 'select';
  const select = button(t.select, () => { mode = 'select'; view?.setMode(mode); updateModes(); });
  const hand = button(t.hand, () => { mode = 'hand'; view?.setMode(mode); updateModes(); });
  function updateModes(): void { select.setAttribute('aria-pressed', String(mode === 'select')); hand.setAttribute('aria-pressed', String(mode === 'hand')); }
  const reload = button(t.refresh, () => view?.refresh());
  toolbar.append(select, hand, reload, button(t.logout, logout)); updateModes();
  const clear = button(t.clear, () => view?.clear());
  const review = button(t.hide, () => {
    if (!view || view.status !== 'ready' || pending || !view.selection.length) return;
    confirmedIds = [...view.selection]; reason.value = ''; dialogError.textContent = '';
    const ids = required<HTMLElement>(dialog, '.confirmation-ids'); ids.replaceChildren();
    for (const id of confirmedIds) { const li = document.createElement('li'); li.textContent = id; ids.append(li); }
    view.lock(true); dialog.showModal(); reason.focus();
  });
  required(layout, '.selection-actions').append(clear, review);
  required<HTMLButtonElement>(dialog, '.cancel').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    // close is asynchronous: an old event must not clear a newly reopened form.
    if (!dialog.open) { reason.value = ''; view?.lock(!!pending); }
  });
  required<HTMLFormElement>(dialog, 'form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!view || pending || view.status !== 'ready' || view.selection.join() !== confirmedIds.join()) {
      dialogError.textContent = t.selectionChanged; return;
    }
    if (!validReason(reason.value)) { dialogError.textContent = t.invalidReason; return; }
    pending = { payload: makeHideOperation(confirmedIds, reason.value), state: 'sending' };
    dialog.close(); void execute('hide');
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
    review.disabled = !!pending || !ids.length || state !== 'ready';
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
      panel.append(button(t.retryOperation, () => { void execute('hide'); }));
      if (pending.state === 'rejected') panel.append(button(t.editSelection, () => {
        pending = undefined; operationPanel(); if (view) update(view.selection, view.status);
      }));
    }
  }
  async function execute(kind: 'hide' | 'check'): Promise<void> {
    if (!pending || !session || current !== epoch) return;
    const operation = pending.payload;
    const wasUnknown = pending.state === 'unknown';
    pending.state = 'sending'; pending.error = undefined;
    operationPanel(); if (view) update(view.selection, view.status);
    try {
      const result = kind === 'hide' ? await api.hide(operation, session.csrf_token, lifetime.signal)
        : await api.operation(operation, lifetime.signal);
      if (current !== epoch) return;
      pending = undefined; view?.remove([...result.hidden, ...result.already_hidden]);
      status(t.success(result.hidden.length, result.already_hidden.length));
      void refreshSession(current);
    } catch (error) {
      if (current !== epoch) return;
      if (error instanceof ApiError && error.status === 401) { showAuth('login', t.sessionExpired); return; }
      if (!pending) return;
      pending.state = wasUnknown || kind === 'check' || uncertainOutcome(error) ? 'unknown' : 'rejected';
      pending.error = kind === 'check' && error instanceof ApiError && error.status === 404 ? t.operationMissing : errorText(error);
    } finally {
      if (current === epoch) { operationPanel(); if (view) update(view.selection, view.status); }
    }
  }
  try {
    view = new AdminView(required(layout, '.world-host'), t.canvas, (ids, state) => update(ids, state), () => status(t.limit, true));
    update(view.selection, view.status);
  } catch (error) { showAuth('login', errorText(error)); }
}

window.addEventListener('focus', () => { if (session) void refreshSession(epoch); });
window.addEventListener('pagehide', () => { reset(); status(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) void bootstrap(); });
void bootstrap();
