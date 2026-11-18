import { infoTranslations, resolveLocale } from './i18n';

const locale = resolveLocale(navigator.languages, navigator.language);
const messages = infoTranslations[locale];
document.documentElement.lang = locale;

for (const element of document.querySelectorAll<HTMLElement>('[data-copy]')) {
  const key = element.dataset.copy;
  if (key && Object.hasOwn(messages, key)) {
    element.textContent = messages[key as keyof typeof messages];
  }
}

const privacy = document.body.dataset.page === 'privacy';
document.title = privacy ? messages.privacyTitle : messages.aboutTitle;
document.querySelector('meta[name="description"]')?.setAttribute('content',
  privacy ? messages.privacyDescription : messages.aboutDescription);
