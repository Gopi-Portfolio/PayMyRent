import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import TenantHome from '../app/(app)/tenant/index';
import '@/i18n';

let mockRentals: any[] = [];
jest.mock('@/lib/api', () => ({ api: async (path: string) => (path.includes('/tenant/rentals') ? { items: mockRentals } : { items: [] }), ApiError: class extends Error {} }));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...a: any[]) => mockPush(...a), replace: jest.fn(), canGoBack: () => false }, useFocusEffect: () => {}, usePathname: () => '/', useLocalSearchParams: () => ({}) }));
jest.mock('@/components/ui', () => ({ ...jest.requireActual('@/components/ui'), DemoBanner: () => null }));

const rental = (id: string, ident: string, due: number, owner = 'Ravi Kumar') => ({ id, identifier: ident, owner_ref: `o-${owner}`, owner_name: owner, owner_verification: 'verified', your_mobile: '+919000000001',
  status: 'active', kind: 'residential', address: 'MG Road', property_name: 'Lake View', monthly_rent_paise: 1000000, deposit_held_paise: 0, balance_paise: due, payable_now_paise: due, start_date: '2026-01-01' });
const wrap = () => <QueryClientProvider client={new QueryClient()}><PaperProvider><TenantHome /></PaperProvider></QueryClientProvider>;

test('one rental: no dropdown, and no owner-verified badge or owner-updates panel on the dashboard', async () => {
  mockRentals = [rental('r1', 'S-01', 500000)];
  const ui = render(wrap());
  await waitFor(() => ui.getByText('S-01'));
  expect(ui.queryByTestId('rental-select')).toBeNull();
  expect(ui.queryByText('Verified')).toBeNull();                       // the owner's status lives on the rental's own page
  expect(ui.queryByTestId('owner-updates')).toBeNull();                // the owner's updates are in the bell
  expect(ui.getByTestId('owner-line')).toBeTruthy();                   // the owner is one slim line: name + the locked mobile in small type
  expect(ui.getByText('+919000000001')).toBeTruthy();
  expect(ui.getByLabelText('Owner')).toBeTruthy();                      // the owner's icon, not the first letter of the name
});

test('several rentals: a dropdown, and only the chosen rental (the first with a balance due) is shown', async () => {
  mockRentals = [rental('r1', 'S-01', 0), rental('r2', 'S-02', 800000, 'Meena Iyer'), rental('r3', 'S-03', 300000)];
  const ui = render(wrap());
  await waitFor(() => ui.getByTestId('rental-select'));
  expect(ui.getAllByText('S-02').length).toBeGreaterThan(0);        // opens on the first rental with money due
  expect(ui.queryByText('S-01')).toBeNull();                          // the others are not listed on the page
  expect(ui.queryByText('S-03')).toBeNull();
});

test('the top boxes are tappable: Total Due pays, Deposit opens the rental', async () => {
  mockPush.mockClear();
  mockRentals = [rental('r1', 'S-01', 500000), rental('r2', 'S-02', 300000, 'Meena Iyer')];
  const ui = render(wrap());
  await waitFor(() => ui.getByTestId('rental-select'));
  fireEvent.press(ui.getByLabelText(/^Total Due/));                       // two rentals owe money: the pay-together screen
  expect(mockPush).toHaveBeenCalledWith('/(app)/tenant/pay');
  fireEvent.press(ui.getByLabelText(/^Deposit/));
  expect(mockPush).toHaveBeenLastCalledWith('/(app)/tenant/rental/r1');   // the chosen rental
});
