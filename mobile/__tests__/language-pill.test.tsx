import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { LanguagePill } from '@/components/LanguagePill';
import i18n from '@/i18n';
import { loadLanguage } from '@/lib/language';

const store: Record<string, string> = {};
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (k: string, v: string) => { store[k] = v; }),
  getItemAsync: jest.fn(async (k: string) => store[k] ?? null),
}));

afterEach(async () => { await i18n.changeLanguage('en'); });

test('the landing page shows the current language in its own script, lists all 8, switches the app and remembers the choice', async () => {
  await i18n.changeLanguage('en');
  const ui = render(<PaperProvider><LanguagePill top={10} /></PaperProvider>);
  expect(ui.getByText('English')).toBeTruthy();                           // visible without opening anything
  expect(ui.queryByTestId('language-list')).toBeNull();
  fireEvent.press(ui.getByTestId('language-pill'));
  for (const c of ['en', 'ta', 'hi', 'te', 'kn', 'ml', 'mr', 'bn']) expect(ui.getByTestId(`landing-lang-${c}`)).toBeTruthy();
  expect(ui.getByText('தமிழ்')).toBeTruthy();
  fireEvent.press(ui.getByTestId('landing-lang-ta'));
  expect(i18n.language).toBe('ta');                                       // the whole app changes at once
  expect(ui.queryByTestId('language-list')).toBeNull();                   // and the list closes
  expect(ui.getByText('தமிழ்')).toBeTruthy();                             // the pill now shows the new language
  await new Promise((r) => setTimeout(r, 0));
  expect(await loadLanguage()).toBe('ta');                                // remembered for the next time the app opens
});
