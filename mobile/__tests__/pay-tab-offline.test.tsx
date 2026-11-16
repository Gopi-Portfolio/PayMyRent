import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { PayTabButton } from '@/components/PayTab';
import { setOnline } from '@/lib/network';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('@/lib/api', () => ({ api: jest.fn(), ApiError: class extends Error {}, newIdempotencyKey: () => 'k', API_URL: 'http://api.test' }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() }, usePathname: () => '/tenant' }));

const wrap = () => render(<QueryClientProvider client={new QueryClient()}><PaperProvider><PayTabButton payer /></PaperProvider></QueryClientProvider>);
beforeEach(() => { setOnline(true); (api as jest.Mock).mockReset(); (api as jest.Mock).mockResolvedValue({ items: [{ id: 't1', status: 'active', owner_account_id: 'o1', payable_now_paise: 500000 }] }); });

test('online with something due: the Pay slider is ready', async () => {
  const ui = wrap();
  await waitFor(() => expect(ui.getByTestId('tab-pay').props.accessibilityState.disabled).toBe(false));
  expect(ui.getByTestId('tab-pay').props.accessibilityLabel).toBe('Pay');
});

test('offline, even with something due: the slider is switched off and says paying needs the internet', async () => {
  const ui = wrap();
  await waitFor(() => expect(ui.getByTestId('tab-pay').props.accessibilityState.disabled).toBe(false));
  act(() => setOnline(false));
  expect(ui.getByTestId('tab-pay').props.accessibilityState.disabled).toBe(true);
  expect(ui.getByTestId('tab-pay').props.accessibilityLabel).toBe('Pay: Paying needs the internet');
  act(() => setOnline(true));
  expect(ui.getByTestId('tab-pay').props.accessibilityState.disabled).toBe(false);            // and ready again when the connection returns
});
