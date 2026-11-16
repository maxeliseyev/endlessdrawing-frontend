import { expect, test } from '@playwright/test';

const labels = {
  en: {
    dialog: 'Drawing tools', brush: 'Brush', hand: 'Hand', eraser: 'Eraser',
    round: 'Round brush', square: 'Square brush', width: 'Width', opacity: 'Opacity',
    color: 'Choose color', hex: 'HEX color', swatch: 'Color #E46C60',
    prototype: 'Local prototype · not saved', pan: 'Space + drag — pan',
    undo: 'Ctrl / ⌘ Z — undo', canvas: /canvas\. Right-click/,
  },
  ru: {
    dialog: 'Инструменты рисования', brush: 'Кисть', hand: 'Рука', eraser: 'Ластик',
    round: 'Круглая кисть', square: 'Квадратная кисть', width: 'Толщина', opacity: 'Непрозрачность',
    color: 'Выбрать цвет', hex: 'Цвет HEX', swatch: 'Цвет #E46C60',
    prototype: 'Локальный прототип · без сохранения', pan: 'Space + drag — перемещение',
    undo: 'Ctrl / ⌘ Z — отмена', canvas: /холст\. Правый клик/,
  },
};

const scenarios: { locale: string; languages?: string[]; expected: 'en' | 'ru' }[] = [
  { locale: 'en-US', expected: 'en' },
  { locale: 'en-GB', expected: 'en' },
  { locale: 'ru-RU', expected: 'ru' },
  { locale: 'ru', expected: 'ru' },
  { locale: 'fr-FR', expected: 'en' },
  { locale: 'de-DE', languages: ['de-DE', 'ru-RU', 'en-US'], expected: 'ru' },
  { locale: 'en-GB', languages: ['en-GB', 'ru-RU'], expected: 'en' },
];

for (const scenario of scenarios) {
  test.describe(`${scenario.languages?.join(', ') ?? scenario.locale} → ${scenario.expected}`, () => {
    test.use({ locale: scenario.locale });

    test('localizes visible UI and accessibility without introducing a start screen', async ({ page }) => {
      if (scenario.languages) {
        await page.addInitScript((languages) => {
          Object.defineProperty(navigator, 'languages', { get: () => languages });
        }, scenario.languages);
      }
      await page.goto('/');
      const ui = labels[scenario.expected];
      await expect(page.locator('html')).toHaveAttribute('lang', scenario.expected);
      await expect(page).toHaveTitle('Endless Drawing');
      await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'One drawing. Everyone. Forever.');
      expect(await page.locator('body').innerText()).toBe('');
      await expect(page.locator('canvas')).toHaveAccessibleName(ui.canvas);

      await page.locator('canvas').focus();
      await page.keyboard.press('Shift+F10');
      const dialog = page.getByRole('dialog', { name: ui.dialog, exact: true });
      await expect(dialog).toBeVisible();
      await expect(page.getByRole('button', { name: ui.brush, exact: true })).toBeFocused();
      await expect(page.getByRole('button', { name: ui.eraser, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: ui.round, exact: true })).toBeVisible();
      await expect(page.getByRole('slider', { name: ui.width })).toBeVisible();
      await expect(page.getByLabel(ui.color, { exact: true })).toBeVisible();
      await expect(dialog.getByText(ui.prototype, { exact: true })).toBeVisible();
      await expect(dialog.locator('.palette-hint')).toContainText(ui.pan);
      await expect(dialog.locator('.palette-hint')).toContainText(ui.undo);
      await page.getByRole('button', { name: ui.square, exact: true }).click();
      await page.getByRole('button', { name: ui.swatch, exact: true }).click();
      await expect(page.getByRole('textbox', { name: ui.hex })).toHaveValue('#E46C60');
      await page.getByRole('slider', { name: ui.opacity }).focus();
      await page.keyboard.press('Home');
      await expect(dialog.locator('#opacity-output')).toHaveText(scenario.expected === 'ru' ? '1 %' : '1%');
      await page.getByRole('button', { name: ui.hand, exact: true }).click();
      await expect(dialog).toBeHidden();
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', scenario.expected);
      await page.mouse.click(400, 300, { button: 'right' });
      await expect(page.getByRole('button', { name: ui.hand, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('button', { name: ui.square, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('textbox', { name: ui.hex })).toHaveValue('#E46C60');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      expect(await page.locator('body').innerText()).toBe('');
    });
  });
}
