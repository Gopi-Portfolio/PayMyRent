import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import bn from './locales/bn.json';
import en from './locales/en.json';
import hi from './locales/hi.json';
import kn from './locales/kn.json';
import ml from './locales/ml.json';
import mr from './locales/mr.json';
import ta from './locales/ta.json';
import te from './locales/te.json';

export const LANGUAGES = [
  { code: 'en', label: 'English' }, { code: 'ta', label: 'தமிழ்' }, { code: 'hi', label: 'हिन्दी' }, { code: 'te', label: 'తెలుగు' },
  { code: 'kn', label: 'ಕನ್ನಡ' }, { code: 'ml', label: 'മലയാളം' }, { code: 'mr', label: 'मराठी' }, { code: 'bn', label: 'বাংলা' },
] as const;

const deviceLang = getLocales()[0]?.languageCode ?? 'en';

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ta: { translation: ta }, hi: { translation: hi }, te: { translation: te },
               kn: { translation: kn }, ml: { translation: ml }, mr: { translation: mr }, bn: { translation: bn } },
  lng: LANGUAGES.some((l) => l.code === deviceLang) ? deviceLang : 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export default i18n;
