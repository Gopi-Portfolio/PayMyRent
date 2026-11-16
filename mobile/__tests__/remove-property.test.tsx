import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import MyProperties from '../app/(app)/owner/properties';
import { queryClient } from '@/lib/queryClient';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('@/lib/api', () => ({ api: jest.fn(), ApiError: class extends Error {}, newIdempotencyKey: () => 'k', API_URL: 'http://api.test' }));
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: { id: 'u1', owner_accounts: [{ owner_account_id: 'o1' }] }, selectOwner: jest.fn() }), ownerAccountId: () => 'o1' }));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }, usePathname: () => '/owner/properties' }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native'); const a = jest.requireActual('@/components/ui');
  return { ...a, Screen: ({ children }: any) => R.createElement(RN.View, null, children) };
});

const mockApi = api as jest.Mock;
const W = { items: [{ owner_account_id: 'o1', role: 'owner', state: 'active', plan: 'growth', units_capacity: 10, active_units: 2, vacant_units: 2,
                      property: { id: 'p1', name: 'Tower', address: '1 Main Road', city: 'Madurai', pincode: '625001', verification_status: 'verified' } }] };
const wrap = () => render(<QueryClientProvider client={queryClient}><PaperProvider><MyProperties /></PaperProvider></QueryClientProvider>);

beforeEach(() => { mockApi.mockReset(); queryClient.clear(); mockApi.mockImplementation(async (path: string) => (path.endsWith('/remove') ? { removed: true } : W)); });

test('Remove property asks once; nothing is sent until it is confirmed, and Cancel does nothing', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const ui = wrap();
  await waitFor(() => ui.getByTestId('remove-property-p1'));
  fireEvent.press(ui.getByTestId('remove-property-p1'));
  expect(alert).toHaveBeenCalledWith('Remove Tower?', expect.stringContaining('no renter lives in it'), expect.any(Array));
  expect(mockApi.mock.calls.some((c) => String(c[0]).endsWith('/remove'))).toBe(false);
  const buttons = alert.mock.calls[0][2] as any[];
  expect(buttons.map((b) => b.text)).toEqual(['Cancel', 'Remove property']);
  await act(async () => { await buttons[1].onPress(); });
  const call = mockApi.mock.calls.find((c) => String(c[0]).endsWith('/remove'))!;
  expect(call[0]).toBe('/api/v1/owner/properties/p1/remove');
  expect(call[1]).toMatchObject({ method: 'POST', ownerAccount: 'o1' });
  alert.mockRestore();
});

test('when renters still live in the property the server says so, and the message is shown', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  mockApi.mockImplementation(async (path: string) => { if (path.endsWith('/remove')) throw Object.assign(new Error('renters still live here (S-01). Remove them first, then remove the property.'), { status: 409, code: 'CONFLICT' }); return W; });
  const ui = wrap();
  await waitFor(() => ui.getByTestId('remove-property-p1'));
  fireEvent.press(ui.getByTestId('remove-property-p1'));
  await act(async () => { await (alert.mock.calls[0][2] as any[])[1].onPress(); });
  await waitFor(() => expect(ui.getByText(/renters still live here \(S-01\)/)).toBeTruthy());
  alert.mockRestore();
});
