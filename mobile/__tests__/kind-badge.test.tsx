import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { KIND_COLORS, KindBadge } from '@/components/KindBadge';
import { PropertyCards } from '@/components/PropertyCards';
import '@/i18n';

// Every screen shows the kind the same way: R on blue (residential), C on orange (commercial), R/C for a property that has both.
jest.mock('expo-router', () => ({ router: { push: jest.fn(), navigate: jest.fn(), replace: jest.fn() } }));
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: { id: 'u1' }, selectOwner: jest.fn() }), ownerAccountId: () => 'o1' }));
jest.mock('@/lib/api', () => ({ api: jest.fn(async () => ({ items: [
  { owner_account_id: 'a1', plan: 'growth', units_capacity: 10, active_units: 2, vacant_units: 1, property: { id: 'p1', name: 'Tower', address: '1 Main Road', city: 'Madurai', pincode: '625001', kind: 'residential', verification_status: 'verified' } },
  { owner_account_id: 'a2', plan: 'growth', units_capacity: 10, active_units: 2, vacant_units: 1, property: { id: 'p2', name: 'Bazaar', address: '2 Main Road', city: 'Madurai', pincode: '625001', kind: 'commercial', verification_status: 'verified' } },
  { owner_account_id: 'a3', plan: 'growth', units_capacity: 10, active_units: 2, vacant_units: 1, property: { id: 'p3', name: 'Plaza', address: '3 Main Road', city: 'Madurai', pincode: '625001', kind: 'mixed', verification_status: 'verified' } }] })), ApiError: class extends Error {} }));

const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}><PaperProvider>{ui}</PaperProvider></QueryClientProvider>);
const bg = (node: any) => JSON.stringify(node.props.style);

test('R is blue, C is orange, a property with both shows R/C, and each has a spoken name', () => {
  const ui = wrap(<><KindBadge kind="residential" testID="r" /><KindBadge kind="shop" testID="c" /><KindBadge kind="mixed" testID="m" /></>);
  expect(ui.getByText('R')).toBeTruthy(); expect(ui.getByText('C')).toBeTruthy(); expect(ui.getByText('R/C')).toBeTruthy();
  expect(bg(ui.getByTestId('r'))).toContain(KIND_COLORS.residential);
  expect(bg(ui.getByTestId('c'))).toContain('#F97316');
  expect(ui.getByTestId('r').props.accessibilityLabel).toBeTruthy();
});

test('Search > Properties shows the kind badge on each property instead of an icon', async () => {
  const ui = wrap(<PropertyCards term="" />);
  await waitFor(() => ui.getByTestId('kind-a1'));
  expect(bg(ui.getByTestId('kind-a1'))).toContain(KIND_COLORS.residential);
  expect(bg(ui.getByTestId('kind-a2'))).toContain('#F97316');
  expect(ui.getByText('R/C')).toBeTruthy();
});

test('Search > Properties does not list an empty account as "New Property" while another account has a property', async () => {
  const api = require('@/lib/api').api as jest.Mock;
  api.mockResolvedValueOnce({ items: [
    { owner_account_id: 'a1', plan: 'growth', units_capacity: 10, active_units: 2, vacant_units: 1, property: { id: 'p1', name: 'Tower', address: '1 Main Road', city: 'Madurai', pincode: '625001', kind: 'residential', verification_status: 'verified' } },
    { owner_account_id: 'a9', plan: null, units_capacity: 0, active_units: 0, vacant_units: 0, property: null }] });
  const ui = wrap(<PropertyCards term="" />);
  await waitFor(() => ui.getByText('Tower'));
  expect(ui.queryByText('New property')).toBeNull();
  expect(ui.queryByTestId('property-card-a9')).toBeNull();
});

test('an owner whose only account is still empty sees it, so the first property can be added', async () => {
  const api = require('@/lib/api').api as jest.Mock;
  api.mockResolvedValueOnce({ items: [{ owner_account_id: 'a9', plan: 'starter', units_capacity: 5, active_units: 0, vacant_units: 0, property: null }] });
  const ui = wrap(<PropertyCards term="" />);
  await waitFor(() => ui.getByText('New property'));
});
