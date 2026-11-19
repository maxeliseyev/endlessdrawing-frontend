import { expect, test } from '@playwright/test';

// App Review 1.2: the terms state zero tolerance, how to report/block and the 24-hour review.
for (const ru of [false, true]) test.describe(ru ? 'Russian terms' : 'English terms', () => {
  test.use({ locale: ru ? 'ru-RU' : 'en-US' });

  test('terms page explains zero tolerance, reporting, moderation and contact', async ({ page }) => {
    const response = await page.goto('/terms');
    expect(response?.ok()).toBe(true);
    expect(new URL(page.url()).pathname).toBe('/terms/');
    await expect(page.locator('html')).toHaveAttribute('lang', ru ? 'ru' : 'en');
    await expect(page).toHaveTitle(ru ? 'Условия использования — Endless Drawing' : 'Terms of Use — Endless Drawing');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(ru ? 'Условия использования' : 'Terms of Use');
    await expect(page.getByRole('heading', { name: ru ? 'Нулевая терпимость' : 'Zero tolerance' })).toBeVisible();
    await expect(page.locator('main li')).toHaveCount(6);
    await expect(page.locator('main')).toContainText(ru ? 'в течение 24 часов' : 'within 24 hours');
    await expect(page.getByRole('link', { name: 'support@endlessdrawing.com' })).toHaveAttribute('href', 'mailto:support@endlessdrawing.com');
    await expect(page.locator('footer').getByRole('link', { name: ru ? 'Условия' : 'Terms of Use' })).toHaveAttribute('href', '/terms');
    await expect(page.locator('main a[href="/privacy"]')).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
  });
});

test('about and privacy link to the terms', async ({ page }) => {
  for (const path of ['/about/', '/privacy/']) {
    await page.goto(path);
    await expect(page.locator('footer a[href="/terms"]')).toHaveText('Terms of Use');
  }
});
