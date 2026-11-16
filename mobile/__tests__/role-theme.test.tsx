import { render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { AppButton } from '@/components/Buttons';
import { brand, setBrandRole, themeFor } from '@/theme';

afterEach(() => setBrandRole('owner'));

test('owners see the logo-green set and renters see the logo-blue one, through the same names', () => {
  setBrandRole('owner');
  expect([brand.teal900, brand.teal700, brand.teal50, brand.canvas]).toEqual(['#0F4D00', '#1F8A02', '#F1F9EE', '#F4F7F4']);
  setBrandRole('tenant');
  expect([brand.teal900, brand.teal700, brand.teal600, brand.teal100, brand.teal50, brand.canvas]).toEqual(['#001F4D', '#003472', '#003472', '#DCE8F7', '#EEF4FB', '#EEF3FA']);
  setBrandRole('owner');
  expect(brand.teal700).toBe('#1F8A02');                                        // and back again
});

test('the Paper theme follows the role: primary colour and window background', () => {
  expect(themeFor('owner').colors.primary).toBe('#1F8A02');
  expect(themeFor('tenant').colors.primary).toBe('#003472');
  expect(themeFor('tenant').colors.background).toBe('#EEF3FA');
  expect(themeFor('owner').colors.background).toBe('#F4F7F4');
});

test('a button is drawn in the colours of the role in use', () => {
  const colorsOf = (ui: ReturnType<typeof render>) => JSON.stringify(ui.toJSON());
  setBrandRole('owner');
  const owner = colorsOf(render(<PaperProvider theme={themeFor('owner')}><AppButton label="Pay" onPress={() => undefined} /></PaperProvider>));
  setBrandRole('tenant');
  const renter = colorsOf(render(<PaperProvider theme={themeFor('tenant')}><AppButton label="Pay" onPress={() => undefined} /></PaperProvider>));
  expect(owner).toContain('#1F8A02');                                           // owner: green glow under the button
  expect(renter).toContain('#003472');                                          // renter: blue glow under the button
  expect(renter).not.toContain('#1F8A02');
  expect(owner).not.toBe(renter);                                               // the gradient itself differs too
});
