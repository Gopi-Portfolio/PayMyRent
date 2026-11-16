import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import RemoveRenter from '../app/(app)/owner/remove-renter';
import { queryClient } from '@/lib/queryClient';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('@/lib/api', () => ({ api: jest.fn(), ApiError: class extends Error {}, newIdempotencyKey: () => 'k', API_URL: 'http://api.test' }));
const mockSelect = jest.fn();
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: { owner_accounts: [{ owner_account_id: 'o1', role: 'owner', property_name: 'Tower' }, { owner_account_id: 'o2', role: 'owner', property_name: 'Villa' }] }, selectOwner: mockSelect }), ownerAccountId: () => 'o1' }));
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ get router() { return mockRouter; }, usePathname: () => '/owner/remove-renter' }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native'); const a = jest.requireActual('@/components/ui');
  return { ...a, Screen: ({ children }: any) => R.createElement(RN.View, null, children) };
});

const mockApi = api as jest.Mock;
const wrap = () => render(<QueryClientProvider client={queryClient}><PaperProvider><RemoveRenter /></PaperProvider></QueryClientProvider>);

beforeEach(() => { mockSelect.mockReset(); mockApi.mockReset(); mockRouter.push.mockReset(); queryClient.clear(); });

test('renters of every property are listed together, each with a Remove button that picks that property and opens the removal', async () => {
  mockApi.mockImplementation(async (_p: string, o: any) => ({ items: o.ownerAccount === 'o1'
    ? [{ id: 't1', tenant_name: 'Ravi Kumar', identifier: 'S-01', status: 'active' }] : [{ id: 't2', tenant_name: 'Selvi', identifier: 'V-1', status: 'invited' }] }));
  const ui = wrap();
  await waitFor(() => ui.getByText('Ravi Kumar'));
  await waitFor(() => ui.getByText('Selvi'));
  expect(ui.getByText('V-1 · Villa · Invitation Pending')).toBeTruthy();        // which property each renter is in
  fireEvent.press(ui.getByTestId('remove-t2'));
  expect(mockSelect).toHaveBeenCalledWith('o2');
  expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/(app)/owner/tenancy/t2', params: { remove: '1' } });
});

test('with nobody living in the units it says so', async () => {
  mockApi.mockResolvedValue({ items: [] });
  const ui = wrap();
  await waitFor(() => ui.getByTestId('no-live-renters'));
});

const TWO = async (path: string, o: any) => {
  if (path.includes('/tenancies?status=live')) return { items: o.ownerAccount === 'o1'
    ? [{ id: 't1', tenant_name: 'Ravi Kumar', identifier: 'S-01', status: 'active' }, { id: 't3', tenant_name: 'Anand', identifier: 'S-03', status: 'invited' }]
    : [{ id: 't2', tenant_name: 'Selvi', identifier: 'V-1', status: 'active' }] };
  return {};
};

test('a property can be chosen to show only its renters, and All properties shows everyone', async () => {
  mockApi.mockImplementation(TWO);
  const ui = wrap();
  await waitFor(() => ui.getByText('Selvi'));
  fireEvent.press(ui.getByText('All properties (2)'));                      // the property list opens
  await waitFor(() => ui.getByText('Tower'));
  fireEvent.press(ui.getAllByText('Tower').slice(-1)[0]);
  await waitFor(() => expect(ui.queryByText('Selvi')).toBeNull());
  expect(ui.getByText('Ravi Kumar')).toBeTruthy();
});

test('several renters can be ticked and removed together: living-in renters are moved out, invitations cancelled, and one refusal does not stop the rest', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  mockApi.mockImplementation(async (path: string, o: any) => {
    if (path.includes('/tenancies/t2/end')) throw new Error('cannot end');
    return TWO(path, o);
  });
  const ui = wrap();
  await waitFor(() => ui.getByText('Selvi'));
  expect(ui.queryByTestId('remove-selected')).toBeNull();                    // nothing ticked: no bulk button
  fireEvent.press(ui.getByTestId('select-all'));
  expect(ui.getByText('Remove selected (3)')).toBeTruthy();
  fireEvent.press(ui.getByTestId('remove-selected'));
  expect(alert).toHaveBeenCalledWith('Remove 3 renters?', expect.stringContaining('moved out today'), expect.any(Array));
  expect(mockApi.mock.calls.some((c) => /\/(end|cancel-invite)/.test(String(c[0])))).toBe(false);       // nothing until confirmed
  await act(async () => { await (alert.mock.calls[0][2] as any[])[1].onPress(); });
  const calls = mockApi.mock.calls.map((c) => [String(c[0]), c[1]?.ownerAccount]);
  expect(calls.some(([p, o]) => /\/tenancies\/t1\/end\?end_date=\d{4}-\d{2}-\d{2}$/.test(p) && o === 'o1')).toBe(true);
  expect(calls.some(([p, o]) => p === '/api/v1/owner/tenancies/t3/cancel-invite' && o === 'o1')).toBe(true);
  expect(calls.some(([p, o]) => p.includes('/tenancies/t2/end') && o === 'o2')).toBe(true);              // tried even after another was done
  await waitFor(() => ui.getByTestId('bulk-result'));
  expect(ui.getByText('2 removed.')).toBeTruthy();
  expect(ui.getByText('Could not remove: Selvi. Open them one by one to see why.')).toBeTruthy();
  alert.mockRestore();
});
