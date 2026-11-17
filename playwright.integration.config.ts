import { defineConfig, devices } from '@playwright/test';

// Joint frontend ↔ real backend check. Start the backend with this repo's
// dist/ first (see README "Совместная проверка"); no mocks, no Vite server.
export default defineConfig({
  testDir: './tests/integration',
  workers: 1,
  use: {
    baseURL: process.env.E2E_BACKEND_URL ?? 'http://127.0.0.1:3000',
    locale: 'en-US',
    viewport: { width: 1000, height: 700 },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1000, height: 700 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1000, height: 700 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1000, height: 700 } } },
  ],
});
