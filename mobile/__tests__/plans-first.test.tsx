import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import Plans from '../app/(public)/plans';
import '@/i18n';

let mockParams: any = {};
jest.mock('expo-router', () => ({ router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() }, useLocalSearchParams: () => mockParams, usePathname: () => '/plans' }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/lib/api', () => ({ api: jest.fn(async () => ({ plans: [] })) }));
const wrap = () => render(<QueryClientProvider client={new QueryClient()}><PaperProvider><Plans /></PaperProvider></QueryClientProvider>);

test('sent here from sign-in, the plans page says to choose a plan first and that the first month is free', () => {
  mockParams = { first: '1' };
  const ui = wrap();
  expect(ui.getByTestId('plan-first-note')).toBeTruthy();
  expect(ui.getByText(/first month is free/i)).toBeTruthy();
});

test('opened normally, there is no such note', () => {
  mockParams = {};
  expect(wrap().queryByTestId('plan-first-note')).toBeNull();
});
