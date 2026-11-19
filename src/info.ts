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

const page = document.body.dataset.page;
const [title, description] = page === 'privacy' ? [messages.privacyTitle, messages.privacyDescription]
  : page === 'terms' ? [messages.termsTitle, messages.termsDescription]
    : [messages.aboutTitle, messages.aboutDescription];
document.title = title;
document.querySelector('meta[name="description"]')?.setAttribute('content', description);
