import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import SearchTab from '../app/(app)/search';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('@/lib/api', () => ({ api: jest.fn() }));
jest.mock('@/lib/auth', () => ({
  useAuth: () => ({ me: { id: 'u1', roles: ['owner'], owner_accounts: [{ owner_account_id: 'o1', role: 'owner', property_name: 'Anna Complex' }] }, activeRole: 'owner', selectOwner: jest.fn() }),
  ownerAccountId: () => 'o1',
}));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), navigate: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => false },
  usePathname: () => '/search', useFocusEffect: () => undefined, useRouter: () => ({ push: jest.fn() }),
}));

const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PaperProvider><SearchTab /></PaperProvider></QueryClientProvider>);
const renter = { id: 't1', tenant_name: 'Meena Devi', identifier: 'S-1', status: 'active', start_date: '2026-01-01', balance_paise: 0, unit_kind: 'shop', effective_pay_method: 'upi' };

beforeEach(() => {
  mockPush.mockClear();
  (api as jest.Mock).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/v1/owner/workspaces')) return { items: [{ owner_account_id: 'o1', plan: 'growth', active_units: 2, units_capacity: 100, vacant_units: 0,
      property: { name: 'Anna Complex', address: '12 Market Road', city: 'Madurai', pincode: '625020', verification_status: 'verified' } }] };
    if (path.startsWith('/api/v1/owner/tenancies')) return { items: [renter] };
    return {};
  });
});

test('at first nothing is chosen: a prompt shows, the + is blurred out and the search box is off', () => {
  const ui = show();
  expect(ui.getByText('Choose Properties or Renters above to see the list.')).toBeTruthy();
  expect(ui.getByTestId('search-add').props.accessibilityState.disabled).toBe(true);
  expect(ui.getByTestId('search-input').props.editable).toBe(false);
  fireEvent.press(ui.getByTestId('search-add'));
  expect(mockPush).not.toHaveBeenCalled();
});

test('Properties lists the properties under the search bar, and + adds a property', async () => {
  const ui = show();
  fireEvent.press(ui.getByTestId('search-mode'));
  fireEvent.press(ui.getByTestId('search-mode-properties'));
  await waitFor(() => expect(ui.getByText('Anna Complex')).toBeTruthy());
  expect(ui.getByText('12 Market Road, Madurai 625020')).toBeTruthy();
  expect(ui.getByTestId('search-add').props.accessibilityState.disabled).toBe(false);
  fireEvent.press(ui.getByTestId('search-add'));
  expect(mockPush).toHaveBeenCalledWith('/(app)/owner/add-property');
  // the search bar narrows the properties; the filter button is off here (filters are for renters)
  expect(ui.getByTestId('search-input-filter').props.accessibilityState?.disabled ?? ui.getByTestId('search-input-filter').props.disabled).toBeTruthy();
  fireEvent.changeText(ui.getByTestId('search-input'), 'zzz');
  await act(async () => { await new Promise((r) => setTimeout(r, 700)); });          // the search waits 300 ms after typing
  expect(ui.queryByText('Anna Complex')).toBeNull();
  expect(ui.getByText('No properties found.')).toBeTruthy();
});

test('Renters lists the renters, + adds a renter, and the filter button sits in the search bar', async () => {
  const ui = show();
  fireEvent.press(ui.getByTestId('search-mode'));
  fireEvent.press(ui.getByTestId('search-mode-renters'));
  await waitFor(() => expect(ui.getByText('Meena Devi')).toBeTruthy());
  fireEvent.press(ui.getByTestId('search-add'));
  expect(mockPush).toHaveBeenCalledWith('/(app)/owner/add-tenant');
  expect(ui.queryByTestId('search-filters')).toBeNull();
  fireEvent.press(ui.getByTestId('search-input-filter'));
  expect(ui.getByTestId('search-filters')).toBeTruthy();                 // the chips open from the button inside the search bar
});
