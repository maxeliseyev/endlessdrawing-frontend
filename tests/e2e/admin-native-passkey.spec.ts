import { expect, test } from '@playwright/test';
import { adminServer, login, TEST_PASSWORD, TEST_TOKEN } from './support/admin';

test('uses the native Chromium WebAuthn API with a virtual UV authenticator (HTTP backend still mocked)', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP virtual authenticators are Chromium-specific, not physical Touch ID.');
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const add = () => cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });
  let { authenticatorId } = await add();
  try {
    const state = await adminServer(page);
    state.challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    await page.goto('http://localhost:5173/admin/');
    await page.getByRole('button', { name: 'Register administrator passkeys', exact: true }).click();
    for (let i = 0; i < 2; i++) {
      await page.getByLabel('Login', { exact: true }).fill('moderator');
      await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
      await page.getByLabel('Enrollment token', { exact: true }).fill(TEST_TOKEN);
      await page.getByLabel('Passkey label', { exact: true }).fill(`Virtual credential ${i + 1}`);
      await page.getByRole('button', { name: 'Register passkey', exact: true }).click();
      if (i === 0) {
        await expect(page.getByRole('status')).toContainText('Registered 1 of 2');
        await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
        ({ authenticatorId } = await add());
      }
    }
    await expect(page.getByRole('heading', { name: 'Administrator sign in' })).toBeVisible();
    expect(new Set(state.credentialIds).size).toBe(2);
    // Two virtual authenticators exercise independent registration serialization,
    // not physical devices or real synced passkey provider independence.
    await login(page);
    await expect(page.locator('.world-status')).toHaveText('Shared world loaded');
    const credential = state.requests.find((r) => r.path === 'login/verify')!.body!.credential as {
      rawId: string; response: { signature: string; authenticatorData: string; clientDataJSON: string };
    };
    expect(state.credentialIds).toContain(credential.rawId);
    expect(Buffer.from(credential.response.signature, 'base64url').length).toBeGreaterThan(50);
    expect(Buffer.from(credential.response.authenticatorData, 'base64url').length).toBeGreaterThanOrEqual(37);
    const clientData = JSON.parse(Buffer.from(credential.response.clientDataJSON, 'base64url').toString());
    expect(clientData).toMatchObject({ type: 'webauthn.get', challenge: state.challenge, origin: 'http://localhost:5173' });
  } finally { await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }); }
});
