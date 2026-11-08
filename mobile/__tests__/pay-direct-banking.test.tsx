import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { PayFlow } from '@/components/PayFlow';
import '@/i18n';

const mockApi = jest.fn(async (path: string) => {
  if (path.includes('/payments/checkout')) return { id: 'p1', status: 'pending', checkout: {} };
  if (path.includes('/tenant/rentals')) return { items: [{ id: 't1', pay_mode: 'online', owner_name: 'Ravi', identifier: 'S-01' }] };
  if (path.includes('/bill')) return { summary: { payable_now_paise: 500000, total_due_paise: 500000 } };
  return {};
});
jest.mock('@/lib/api', () => ({ api: (...a: any[]) => (mockApi as any)(...a), newIdempotencyKey: () => 'idem-key-12345', reachable: (u: string) => u, ApiError: class extends Error {} }));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn(), canGoBack: () => false } }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

const wrap = () => <QueryClientProvider client={new QueryClient()}><PaperProvider><PayFlow id="t1" /></PaperProvider></QueryClientProvider>;

test('Direct banking is a small button; tapping it states the 2% + GST charge before anything is started', async () => {
  const ui = render(wrap());
  await waitFor(() => expect((ui.getByTestId('pay-now').props.accessibilityState ?? {}).disabled).not.toBe(true));
  expect(ui.queryByTestId('fee-note')).toBeNull();
  fireEvent.press(ui.getByTestId('pay-now'));
  expect(ui.getByTestId('fee-note').props.children).toContain('2% plus service tax');
  expect(mockApi.mock.calls.some((c: any[]) => String(c[0]).includes('/payments/checkout'))).toBe(false);   // nothing started yet
  fireEvent.press(ui.getByTestId('fee-cancel'));
  expect(ui.queryByTestId('fee-note')).toBeNull();
  fireEvent.press(ui.getByTestId('pay-now'));
  fireEvent.press(ui.getByTestId('fee-continue'));
  await waitFor(() => expect(mockApi.mock.calls.some((c: any[]) => String(c[0]).includes('/payments/checkout'))).toBe(true));
});
