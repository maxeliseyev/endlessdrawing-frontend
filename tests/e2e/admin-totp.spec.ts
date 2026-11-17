import { expect, test } from '@playwright/test';
import { adminServer, mockPasskeys, TEST_PASSWORD, TEST_TOKEN } from './support/admin';

const session = { authenticated: true, account: { id: '87a122fa-7537-4b88-9b77-b45d24a29714', login: 'moderator' }, csrf_token: 'fixture-csrf', expires_at: '2030-01-01T00:00:00Z', idle_expires_at: '2030-01-01T00:00:00Z' };

test('one primary passkey completes the new setup and preserves only the non-secret login', async ({ page }) => {
  await mockPasskeys(page); await adminServer(page);
  await page.route('**/api/admin/enrollment/finish', (route) => route.fulfill({ json: { registered_credentials: 1, required_credentials: 1, complete: true } }));
  await page.goto('/admin/');
  await page.getByRole('button', { name: 'Register administrator passkeys', exact: true }).click();
  await expect(page.locator('.setup-steps')).toContainText('Google Authenticator');
  await page.getByLabel('Login', { exact: true }).fill('moderator');
  await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
  await page.getByLabel('Enrollment token', { exact: true }).fill(TEST_TOKEN);
  await page.getByLabel('Passkey label', { exact: true }).fill('Touch ID');
  await page.getByRole('button', { name: 'Register passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Administrator sign in' })).toBeVisible();
  await expect(page.getByLabel('Login', { exact: true })).toHaveValue('moderator');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.getByRole('status')).toContainText('Passkey setup complete');
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(await page.evaluate(() => ({ ...localStorage, ...sessionStorage }))).toEqual({});
});

test('auth cooldown shows a countdown, blocks controls and never automatically retries', async ({ page }) => {
  await page.clock.install(); await adminServer(page);
  let requests = 0;
  await page.route('**/api/admin/login/options', (route) => { requests++; return route.fulfill({ status: 429, headers: { 'Retry-After': '2' }, json: { error: { code: 'rate_limited' } } }); });
  await page.goto('/admin/');
  await page.getByLabel('Login', { exact: true }).fill('moderator'); await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in with passkey', exact: true }).click();
  await expect(page.locator('.notice')).toContainText('0:02');
  await expect(page.getByRole('button', { name: 'Sign in with passkey', exact: true })).toBeDisabled();
  await page.locator('form').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(requests).toBe(1);
  await page.clock.fastForward(2100);
  await expect(page.getByRole('button', { name: 'Sign in with passkey', exact: true })).toBeEnabled();
  expect(requests).toBe(1);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
});

test('backup sign-in uses password plus code, not WebAuthn or credential storage', async ({ page }) => {
  const state = await adminServer(page);
  await page.route('**/api/admin/login/totp', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ login: 'moderator', password: TEST_PASSWORD, code: '123456' });
    state.authenticated = true;
    await route.fulfill({ json: { ...session, auth_method: 'totp' } });
  });
  await page.goto('/admin/'); await page.getByRole('button', { name: 'Use Google Authenticator backup', exact: true }).click();
  await page.getByLabel('Login', { exact: true }).fill('moderator'); await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
  await page.getByLabel('Six-digit code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Sign in with backup code', exact: true }).click();
  await expect(page.locator('canvas')).toBeVisible();
  expect(await page.evaluate(() => ({ ...localStorage, ...sessionStorage }))).toEqual({});
});

test('QR is generated locally for fresh primary login and all setup material disappears on close', async ({ page }) => {
  await adminServer(page, true);
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // TEST ONLY, never an operator secret.
  const urls: string[] = []; page.on('request', (request) => urls.push(request.url()));
  await page.route('**/api/admin/totp/status', (route) => route.fulfill({ json: { available: true, enabled: false, fresh_passkey: true } }));
  await page.route('**/api/admin/totp/setup/start', (route) => route.fulfill({ json: { secret, otpauth_uri: `otpauth://totp/Endless%20Drawing:moderator?secret=${secret}&issuer=Endless%20Drawing`, expires_at: new Date(Date.now() + 120000).toISOString() } }));
  await page.goto('/admin/'); await page.getByRole('button', { name: 'Google Authenticator backup', exact: true }).click();
  await page.getByRole('button', { name: 'Connect Google Authenticator', exact: true }).click();
  await expect(page.locator('.totp-qr')).toBeVisible();
  await expect(page.getByLabel('Manual setup key (keep private)', { exact: true })).toHaveValue(secret);
  expect(urls.some((url) => url.includes(secret) || url.includes('otpauth:'))).toBe(false);
  expect(await page.evaluate(() => ({ ...localStorage, ...sessionStorage }))).toEqual({});
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.totp-dialog')).toHaveCount(0); await expect(page.locator('canvas')).toHaveCount(1);
  expect(await page.locator('body').innerText()).not.toContain(secret);
});
