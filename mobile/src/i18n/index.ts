import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import kk from './locales/kk.json';
import ru from './locales/ru.json';

export type Language = 'ru' | 'kk';
export const LANGUAGES: Language[] = ['ru', 'kk'];
export const DEFAULT_LANGUAGE: Language = 'ru';

export const resources = {
  ru: { translation: ru },
  // KK is a DRAFT — see kk.json `_meta` and 2-design §7.3.
  kk: { translation: kk },
} as const;

/** First launch: KK if the phone is in Kazakh, otherwise RU (default). User can switch on welcome frame 1. */
export function detectDeviceLanguage(): Language {
  try {
    return getLocales()[0]?.languageCode === 'kk' ? 'kk' : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/** Server value `{N}` for the consent text (GET /consents/text). Placeholder until the backend provides it. */
export const CONSENT_RETENTION_DAYS_PLACEHOLDER = 30;

if (!i18n.isInitialized) {
  // eslint-disable-next-line import/no-named-as-default-member -- instance API is intended
  void i18n.use(initReactI18next).init({
    resources,
    lng: detectDeviceLanguage(),
    fallbackLng: DEFAULT_LANGUAGE,
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  });
}

export function setLanguage(lang: Language): void {
  void i18n.changeLanguage(lang); // eslint-disable-line import/no-named-as-default-member
}

export default i18n;
