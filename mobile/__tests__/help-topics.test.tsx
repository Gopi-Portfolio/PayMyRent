import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import Help from '../app/help';
import en from '@/i18n/locales/en.json';
import '@/i18n';

jest.mock('expo-router', () => ({ usePathname: () => '/help', router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }, useFocusEffect: () => undefined }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native'); const a = jest.requireActual('@/components/ui');
  return { ...a, Screen: ({ children }: any) => R.createElement(RN.View, null, children) };
});

// every feature the app has should have a help topic; this list is what a person can do in the app today
const FEATURES = ['start', 'places', 'bills', 'pay', 'relief', 'vacate', 'agree', 'notify', 'message', 'download', 'remind', 'pricing', 'verify', 'roles', 'ai', 'account', 'more'];

test('the help screen has a topic for every feature, each with a title and text in English', () => {
  const ui = render(<Help />);
  for (const k of FEATURES) {
    expect(ui.getByTestId(`help-${k}`)).toBeTruthy();
    expect((en.help as any)[`s_${k}`]).toBeTruthy();
    expect((en.help as any)[`b_${k}`]).toBeTruthy();
  }
});

test('opening a topic shows its text, including the plan prices', () => {
  const ui = render(<Help />);
  fireEvent.press(ui.getByTestId('help-pricing'));
  expect(ui.getByText(/Starter ₹10: up to 10 places/)).toBeTruthy();
});

test('the help no longer claims a renter sees a masked owner phone number', () => {
  expect(JSON.stringify(en.help)).not.toMatch(/masked owner phone/i);
});
