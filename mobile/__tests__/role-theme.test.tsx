import { render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { AppButton } from '@/components/Buttons';
import { brand, setBrandRole, themeFor } from '@/theme';

afterEach(() => setBrandRole('owner'));

test('owners see the teal set and renters see the blue one, through the same names', () => {
  setBrandRole('owner');
  expect([brand.teal900, brand.teal700, brand.teal50, brand.canvas]).toEqual(['#064E45', '#0B6E5F', '#EDF9F6', '#F4F7F6']);
  setBrandRole('tenant');
  expect([brand.teal900, brand.teal700, brand.teal600, brand.teal100, brand.teal50, brand.canvas]).toEqual(['#1E3A8A', '#1D4ED8', '#2563EB', '#DBEAFE', '#EFF6FF', '#EEF3FD']);
  setBrandRole('owner');
  expect(brand.teal700).toBe('#0B6E5F');                                        // and back again
});

test('the Paper theme follows the role: primary colour and window background', () => {
  expect(themeFor('owner').colors.primary).toBe('#0B6E5F');
  expect(themeFor('tenant').colors.primary).toBe('#1D4ED8');
  expect(themeFor('tenant').colors.background).toBe('#EEF3FD');
  expect(themeFor('owner').colors.background).toBe('#F4F7F6');
});

test('a button is drawn in the colours of the role in use', () => {
  const colorsOf = (ui: ReturnType<typeof render>) => JSON.stringify(ui.toJSON());
  setBrandRole('owner');
  const owner = colorsOf(render(<PaperProvider theme={themeFor('owner')}><AppButton label="Pay" onPress={() => undefined} /></PaperProvider>));
  setBrandRole('tenant');
  const renter = colorsOf(render(<PaperProvider theme={themeFor('tenant')}><AppButton label="Pay" onPress={() => undefined} /></PaperProvider>));
  expect(owner).toContain('#0B6E5F');                                           // owner: teal glow under the button
  expect(renter).toContain('#1D4ED8');                                          // renter: blue glow under the button
  expect(renter).not.toContain('#0B6E5F');
  expect(owner).not.toBe(renter);                                               // the gradient itself differs too
});
