import { describe, expect, it } from 'vitest';
import { resolveLocale, translations } from '../../src/i18n';

describe('browser language preferences', () => {
  it.each([
    { languages: ['en'], expected: 'en' },
    { languages: ['en-US'], expected: 'en' },
    { languages: ['en-GB'], expected: 'en' },
    { languages: ['ru'], expected: 'ru' },
    { languages: ['ru-RU'], expected: 'ru' },
    { languages: ['ru-KZ'], expected: 'ru' },
    { languages: [' RU-ru '], expected: 'ru' },
    { languages: ['de-DE', 'ru-RU', 'en-US'], expected: 'ru' },
    { languages: ['en-GB', 'ru-RU'], expected: 'en' },
    { languages: ['ru', 'en-US'], expected: 'ru' },
    { languages: ['fr-FR', 'de-DE'], expected: 'en' },
    { languages: ['russian', 'english'], expected: 'en' },
    { languages: [''], expected: 'en' },
    { languages: [], expected: 'en' },
  ])('$languages → $expected', ({ languages, expected }) => {
    expect(resolveLocale(languages)).toBe(expected);
  });

  it('uses navigator.language only when the preference list is empty', () => {
    expect(resolveLocale([], 'ru-RU')).toBe('ru');
    expect(resolveLocale([], 'en-US')).toBe('en');
    expect(resolveLocale([], 'fr-FR')).toBe('en');
    expect(resolveLocale(['en-US'], 'ru-RU')).toBe('en');
  });
});

describe('translation catalogues', () => {
  it('has matching nonempty keys for both languages', () => {
    expect(Object.keys(translations.ru).sort()).toEqual(Object.keys(translations.en).sort());
    for (const messages of Object.values(translations)) {
      for (const value of Object.values(messages)) {
        if (typeof value === 'string') expect(value.trim()).not.toBe('');
      }
    }
  });

  it('localizes interpolated errors and accessible swatch labels', () => {
    expect(translations.en.localLimit(500)).toBe('Local prototype limit: 500 strokes. Remove unwanted strokes with the eraser.');
    expect(translations.ru.localLimit(500)).toBe('Лимит локального прототипа: 500 штрихов. Удалите ненужные ластиком.');
    expect(translations.en.colorSwatch('#202020')).toBe('Color #202020');
    expect(translations.ru.colorSwatch('#202020')).toBe('Цвет #202020');
    expect(translations.en.strokeTooLarge).toBe('This stroke is too large. Try drawing a shorter one.');
    expect(translations.ru.strokeTooLarge).toBe('Штрих слишком большой. Попробуйте нарисовать его короче.');
  });
});
