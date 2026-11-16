import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import RemoveRenter from '../app/(app)/owner/remove-renter';
import { queryClient } from '@/lib/queryClient';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('@/lib/api', () => ({ api: jest.fn(), ApiError: class extends Error {}, newIdempotencyKey: () => 'k', API_URL: 'http://api.test' }));
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: { owner_accounts: [{ owner_account_id: 'o1' }] } }), ownerAccountId: () => 'o1' }));
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ get router() { return mockRouter; }, usePathname: () => '/owner/remove-renter' }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native'); const a = jest.requireActual('@/components/ui');
  return { ...a, Screen: ({ children }: any) => R.createElement(RN.View, null, children) };
});

const mockApi = api as jest.Mock;
const wrap = () => render(<QueryClientProvider client={queryClient}><PaperProvider><RemoveRenter /></PaperProvider></QueryClientProvider>);

beforeEach(() => { mockApi.mockReset(); mockRouter.push.mockReset(); queryClient.clear(); });

test('every renter in a unit is listed with a Remove button that opens their page with the removal already open', async () => {
  mockApi.mockResolvedValue({ items: [{ id: 't1', tenant_name: 'Ravi Kumar', identifier: 'S-01', status: 'active' }, { id: 't2', tenant_name: 'Selvi', identifier: 'S-02', status: 'invited' }] });
  const ui = wrap();
  await waitFor(() => ui.getByText('Ravi Kumar'));
  expect(ui.getByText('Selvi')).toBeTruthy();
  fireEvent.press(ui.getByTestId('remove-t2'));
  expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/(app)/owner/tenancy/t2', params: { remove: '1' } });
});

test('with nobody living in the units it says so', async () => {
  mockApi.mockResolvedValue({ items: [] });
  const ui = wrap();
  await waitFor(() => ui.getByTestId('no-live-renters'));
});
