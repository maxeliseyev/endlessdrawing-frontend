import { binary } from './support/admin';
import { expect, test } from '@playwright/test';
import { adminServer, confirm, login, mockPasskeys, review, SECOND_ID, selectStroke, STROKE_ID, TEST_PASSWORD, TEST_TOKEN } from './support/admin';

for (const ru of [false, true]) {
  test.describe(ru ? 'Russian admin' : 'English admin', () => {
    test.use({ locale: ru ? 'ru-RU' : 'en-US' });
    test('requires password then passkey then a verified server session, with no credential storage', async ({ page }) => {
      await mockPasskeys(page);
      const state = await adminServer(page);
      let release!: () => void;
      state.verifyGate = new Promise<void>((resolve) => { release = resolve; });
      const response = await page.goto('/admin/');
      expect(response?.headers()['cache-control']).toBe('no-store');
      expect(response?.headers()['x-frame-options']).toBe('DENY');
      await expect(page.locator('html')).toHaveAttribute('lang', ru ? 'ru' : 'en');
      await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex, nofollow');
      await login(page, ru);
      await expect.poll(() => state.requests.some((r) => r.path === 'login/verify')).toBe(true);
      await expect(page.locator('canvas')).toHaveCount(0);
      expect(state.messages).toHaveLength(0);
      await expect(page.getByLabel(ru ? 'Пароль' : 'Password', { exact: true })).toHaveValue('');
      release();
      await expect(page.locator('canvas')).toBeVisible();
      await expect(page.locator('.world-status')).toHaveText(ru ? 'Общий мир загружен' : 'Shared world loaded');
      const verify = state.requests.find((r) => r.path === 'login/verify')!;
      expect(verify.body).toMatchObject({ credential: { id: 'AQID', rawId: 'AQID', type: 'public-key', extensions: {},
        response: { authenticatorData: 'BAUG', clientDataJSON: 'BwgJ', signature: 'CgsM', userHandle: null } } });
      expect(state.messages.map((m) => m.type)).toEqual(['hello', 'viewport.subscribe']);
      expect(state.messages[0]?.session_secret).toMatch(/^[\w-]{43}$/);
      expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual({ local: {}, session: {} });
      expect(await page.locator('body').innerText()).not.toContain(TEST_PASSWORD);
      await page.getByRole('button', { name: ru ? 'Выйти' : 'Sign out', exact: true }).click();
      await expect(page.locator('canvas')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: ru ? 'Вход администратора' : 'Administrator sign in' })).toBeVisible();
      expect(state.requests.find((r) => r.path === 'logout')?.body).toEqual({});
    });
  });
}

test('cancelled passkey never grants access or submits an assertion; a new password challenge is required', async ({ page }) => {
  await mockPasskeys(page, true);
  const state = await adminServer(page);
  await page.goto('/admin/'); await login(page);
  await expect(page.getByRole('status')).toContainText('cancelled or timed out');
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(state.requests.some((r) => r.path === 'login/verify')).toBe(false);
  await login(page);
  await expect(page.locator('canvas')).toBeVisible();
  expect(state.requests.filter((r) => r.path === 'login')).toHaveLength(2);
  expect(state.requests.filter((r) => r.path === 'login/verify')).toHaveLength(1);
});

test('enrolls two credentials through explicit buffer adapters, then requires a fresh login', async ({ page }) => {
  await mockPasskeys(page);
  const state = await adminServer(page);
  await page.goto('/admin/');
  await page.getByRole('button', { name: 'Register administrator passkeys', exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await page.getByLabel('Login', { exact: true }).fill('moderator');
    await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
    await page.getByLabel('Enrollment token', { exact: true }).fill(TEST_TOKEN);
    await page.getByLabel('Passkey label', { exact: true }).fill(i === 0 ? 'Primary' : 'Independent backup');
    await page.getByRole('button', { name: 'Register passkey', exact: true }).click();
    if (i === 0) {
      await expect(page.getByRole('status')).toContainText('Registered 1 of 2');
      await expect(page.getByLabel('Enrollment token', { exact: true })).toHaveValue('');
    }
  }
  await expect(page.getByRole('heading', { name: 'Administrator sign in' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('enrollment does not grant a session');
  expect(state.authenticated).toBe(false); expect(state.messages).toHaveLength(0);
  const finishes = state.requests.filter((r) => r.path === 'enrollment/finish');
  expect(finishes[0]?.body).toMatchObject({ credential: { id: 'AQID', response: { attestationObject: 'BAUG', clientDataJSON: 'BwgJ', transports: ['internal'] } } });
  expect(finishes[1]?.body).toMatchObject({ credential: { id: 'AgID' } });
  expect(await page.evaluate(() => ({ ...localStorage, ...sessionStorage }))).toEqual({});
  await login(page);
  await expect(page.locator('canvas')).toBeVisible();
});

test('selects foreign strokes, requires review/reason, cancels without a request and hides the explicit atomic batch', async ({ page }) => {
  const state = await adminServer(page, true);
  await page.goto('/admin/');
  await selectStroke(page); await selectStroke(page, 100);
  await expect(page.getByRole('heading', { name: 'Selected strokes: 2 / 100' })).toBeVisible();
  await review(page);
  await expect(page.getByRole('dialog')).toContainText(STROKE_ID);
  await expect(page.getByRole('dialog')).toContainText(SECOND_ID);
  await page.keyboard.press('Escape');
  expect(state.requests.filter((r) => r.path === 'strokes/hide')).toHaveLength(0);
  await review(page, '   '); await confirm(page);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('nonempty reason');
  await page.getByRole('dialog').getByLabel('Reason', { exact: true }).fill('  Illegal material  ');
  await confirm(page);
  await expect(page.getByRole('status').first()).toContainText('Confirmed: 2 hidden');
  const operation = state.requests.find((r) => r.path === 'strokes/hide')!;
  expect(operation.body?.stroke_ids).toEqual([SECOND_ID, STROKE_ID].sort());
  expect(operation.body?.reason).toBe('Illegal material');
  expect(state.strokes.size).toBe(0);
  // Resizing or refreshing may reuse the manifest; all WS operations stay read-only.
  const readOnlyMessages = ['hello', 'viewport.subscribe', 'viewport.subscribe.cached', 'viewport.fetch'];
  expect(state.messages.every((m) => readOnlyMessages.includes(String(m.type)))).toBe(true);
});

test('a possibly committed 503 is resolved by GET operation, not a false success or new UUID', async ({ page }) => {
  const state = await adminServer(page, true); state.hideMode = 'uncertain';
  await page.goto('/admin/'); await selectStroke(page); await review(page); await confirm(page);
  await expect(page.locator('.operation-panel')).toContainText('outcome is unknown');
  await expect(page.getByRole('status').first()).not.toContainText('Confirmed:');
  await page.getByRole('button', { name: 'Check result', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('Confirmed: 1 hidden');
  expect(state.requests.filter((r) => r.path === 'strokes/hide')).toHaveLength(1);
  const operation = state.requests.find((r) => r.path === 'strokes/hide')!.body!.operation_id;
  expect(state.requests.some((r) => r.path === `operations/${operation}`)).toBe(true);
});

test('missing operation after an uncertain response allows only explicit identical retry', async ({ page }) => {
  const state = await adminServer(page, true); state.hideMode = 'unknown';
  await page.goto('/admin/'); await selectStroke(page); await review(page); await confirm(page);
  await expect(page.locator('.operation-panel')).toContainText('outcome is unknown');
  await page.getByRole('button', { name: 'Check result', exact: true }).click();
  await expect(page.locator('.operation-panel')).toContainText('No recorded result yet');
  state.hideMode = 'success';
  await page.getByRole('button', { name: 'Retry same operation', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('Confirmed: 1 hidden');
  const requests = state.requests.filter((r) => r.path === 'strokes/hide');
  expect(requests).toHaveLength(2); expect(requests[0]?.body).toEqual(requests[1]?.body);
});

test('401 closes the world and discards pending hide; a later login does not replay it', async ({ page }) => {
  await mockPasskeys(page);
  const state = await adminServer(page, true); state.hideMode = 'unauthorized';
  await page.goto('/admin/'); await selectStroke(page); await review(page); await confirm(page);
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Administrator sign in' })).toBeVisible();
  state.hideMode = 'success'; await login(page);
  await expect(page.locator('canvas')).toBeVisible();
  expect(state.requests.filter((r) => r.path === 'strokes/hide')).toHaveLength(1);
  await expect(page.getByRole('heading', { name: 'Selected strokes: 0 / 100' })).toBeVisible();
});

test('unavailable backend never enables local moderation or leaks backend diagnostics', async ({ page }) => {
  const state = await adminServer(page); state.enabled = false;
  await page.goto('/admin/');
  await expect(page.getByRole('status')).toContainText('disabled or not configured');
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(state.messages).toHaveLength(0);
  expect(await page.locator('body').innerText()).not.toContain('Backend private diagnostics');
});

test('failed server logout closes local tools but visibly requires a retry of revocation', async ({ page }) => {
  const state = await adminServer(page, true); state.failLogout = true;
  await page.goto('/admin/'); await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('server sign-out could not be confirmed');
  expect(state.authenticated).toBe(true);
  state.failLogout = false;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Administrator sign in' })).toBeVisible();
  expect(state.authenticated).toBe(false);
});

test('resync replaces the scene and ignores messages from the previous subscription', async ({ page }) => {
  const state = await adminServer(page, true);
  await page.goto('/admin/'); await selectStroke(page);
  const connection = state.sockets[0]!;
  const oldId = connection.subscription;
  state.strokes.delete(STROKE_ID);
  connection.route.send(binary({ type: 'error', subscription_id: oldId, code: 'resync_required', message: 'Resync' }));
  // Late chunks from the invalidated subscription must not stop the new load.
  connection.route.send(binary({ type: 'viewport.snapshot.chunk', subscription_id: oldId, strokes: [] }));
  await expect.poll(() => connection.subscription).not.toBe(oldId);
  await expect(page.locator('.world-status')).toHaveText('Shared world loaded');
  await expect(page.getByRole('heading', { name: 'Selected strokes: 0 / 100' })).toBeVisible();
  await selectStroke(page);
  await expect(page.getByRole('heading', { name: 'Selected strokes: 0 / 100' })).toBeVisible();
});

test('failed passkey verification never opens the world despite accepted password', async ({ page }) => {
  await mockPasskeys(page);
  const state = await adminServer(page); state.rejectVerify = true;
  await page.goto('/admin/'); await login(page);
  await expect(page.getByRole('status')).toContainText('Authentication required or failed');
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(state.messages).toHaveLength(0);
});

test('403 cannot hide locally and server diagnostics are not rendered', async ({ page }) => {
  const state = await adminServer(page, true); state.hideMode = 'forbidden';
  await page.goto('/admin/'); await selectStroke(page); await review(page); await confirm(page);
  await expect(page.locator('.operation-panel')).toContainText('Origin or CSRF');
  expect(state.strokes.has(STROKE_ID)).toBe(true);
  expect(await page.locator('body').innerText()).not.toContain('Backend private diagnostics');
  expect(state.messages.some((message) => message.type === 'stroke.delete')).toBe(false);
});

test('429 prevents network retry before Retry-After, without an automatic loop', async ({ page }) => {
  const state = await adminServer(page, true); state.hideMode = 'rate-limited';
  await page.goto('/admin/'); await selectStroke(page); await review(page); await confirm(page);
  await expect(page.locator('.operation-panel')).toContainText('Too many requests');
  await page.getByRole('button', { name: 'Retry same operation', exact: true }).click();
  await expect(page.locator('.operation-panel')).toContainText('Too many requests');
  expect(state.requests.filter((request) => request.path === 'strokes/hide')).toHaveLength(1);
});

test('session idle deadline removes tools without another hide request', async ({ page }) => {
  await page.clock.install();
  const state = await adminServer(page, true);
  await page.goto('/admin/'); await selectStroke(page);
  await page.clock.fastForward(15 * 60_000 + 5000);
  await expect(page.getByRole('heading', { name: 'Administrator sign in' })).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(state.requests.some((request) => request.path === 'strokes/hide')).toBe(false);
});

test('reconnect redoes hello and loads a fresh snapshot, without resurrecting old geometry', async ({ page }) => {
  const state = await adminServer(page, true);
  state.accountLogin = '<img src=x onerror=alert(1)>';
  await page.goto('/admin/'); await selectStroke(page);
  await expect(page.locator('.account')).toHaveText(state.accountLogin);
  await expect(page.locator('.account img')).toHaveCount(0);
  state.strokes.delete(STROKE_ID);
  state.sockets[0]!.route.close({ code: 1001 });
  await expect.poll(() => state.sockets.length).toBe(2);
  await expect(page.locator('.world-status')).toHaveText('Shared world loaded');
  expect(state.messages.filter((message) => message.type === 'hello')).toHaveLength(2);
  await selectStroke(page);
  await expect(page.getByRole('heading', { name: 'Selected strokes: 0 / 100' })).toBeVisible();
});

test('the public entry never loads admin code, checks admin session, or exposes login controls', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  expect(requests.some((url) => url.includes('/api/admin') || url.includes('/src/admin/'))).toBe(false);
  await expect(page.locator('a[href*="admin"], form, [name=password]')).toHaveCount(0);
  await page.mouse.click(500, 300, { button: 'right' });
  expect(await page.getByRole('dialog').innerText()).not.toMatch(/admin|moderation|администрат|модерац/i);
});

test('panning within the prefetched area neither resubscribes nor drops the selection', async ({ page }) => {
  const state = await adminServer(page, true);
  await page.goto('/admin/'); await selectStroke(page);
  const selected = page.locator('.selection-list code');
  await expect(selected).toHaveCount(1);
  await expect(page.locator('.reports')).toContainText('No open reports.');
  const subscriptions = () => state.messages.filter((m) => String(m.type).startsWith('viewport.subscribe')).length;
  const before = subscriptions();
  for (let i = 0; i < 20; i++) await page.mouse.wheel(10, 6);
  await page.waitForTimeout(700); // longer than the 260 ms subscription debounce
  expect(subscriptions()).toBe(before);
  await expect(selected).toHaveCount(1);
  // Far enough to leave the prefetch margin: a new snapshot, and the selection survives it.
  for (let i = 0; i < 40; i++) await page.mouse.wheel(60, 0);
  await expect.poll(subscriptions).toBeGreaterThan(before);
  await expect(page.locator('.world-status')).toHaveText('Shared world loaded');
  await expect(selected).toHaveCount(1);
});

test('report queue: show, dismiss a held stroke, ban an author; decisions use the operation log', async ({ page }) => {
  const state = await adminServer(page, true);
  state.reported = [{ stroke_id: SECOND_ID, held: true, reasons: ['hate', 'spam'] }, { stroke_id: STROKE_ID, held: false, reasons: ['sexual'] }];
  await page.goto('/admin/');
  const reports = page.locator('.reports');
  await expect(reports.getByRole('heading')).toHaveText('Reports: 10 open');
  await expect(reports.locator('li.report')).toHaveCount(2);
  await expect(reports.locator('li.report').first()).toContainText('hate or harassment, spam');
  await expect(reports.locator('li.report').first()).toContainText('Hidden by reports — awaiting decision');

  await reports.locator('li.report').first().getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText('Confirm dismissing the reports');
  await page.getByRole('dialog').getByLabel('Reason', { exact: true }).fill('Not abusive');
  await page.getByRole('dialog').getByRole('button', { name: 'Dismiss reports and restore', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('5 reports dismissed, 1 strokes restored');
  await expect(reports.locator('li.report')).toHaveCount(1);
  const dismiss = state.requests.find((r) => r.path === 'reports/dismiss')!;
  expect(dismiss.body).toMatchObject({ stroke_ids: [SECOND_ID], reason: 'Not abusive' });

  await reports.locator('li.report').first().getByRole('button', { name: 'Ban author', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Reason', { exact: true }).fill('Explicit content');
  await page.getByRole('dialog').getByRole('button', { name: 'Ban author and hide all their strokes', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('1 author banned, 2 strokes hidden');
  await expect(reports.locator('li.report')).toHaveCount(0);
  await expect(reports).toContainText('No open reports.');
  expect(state.banned).toBe(1);
  // Only read-only WS traffic; decisions go through the authenticated HTTP API.
  expect(state.messages.every((m) => ['hello', 'viewport.subscribe', 'viewport.subscribe.cached', 'viewport.fetch'].includes(String(m.type)))).toBe(true);
});
