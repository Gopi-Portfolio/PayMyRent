import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import AddTenant from '../app/(app)/owner/add-tenant';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('@/lib/api', () => {
  function ApiError(this: any, status: number, code: string, message: string) { this.status = status; this.code = code; this.message = message; }
  ApiError.prototype = Object.create(Error.prototype);
  return { api: jest.fn(), ApiError, newIdempotencyKey: () => 'key-1' };
});
let mockAccount: any = {};
jest.mock('@/lib/auth', () => ({
  useAuth: () => ({ me: { owner_accounts: [{ owner_account_id: 'o1', verification: 'verified', ...mockAccount }] } }), ownerAccountId: () => 'o1',
}));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({}), Redirect: () => null, get router() { return mockRouter; }, usePathname: () => '/owner/add-tenant' }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native'); const a = jest.requireActual('@/components/ui');
  return { ...a, Screen: ({ children }: any) => R.createElement(RN.View, null, children) };
});

const mockApi = api as jest.Mock;
let subscription: any = { state: 'active' };
let units: any[] = [];
beforeEach(() => {
  mockApi.mockReset(); mockRouter.push.mockReset();
  subscription = { state: 'active' }; units = [];
  mockApi.mockImplementation(async (path: string) => {
    if (path.includes('/api/v1/subscription')) return subscription;
    if (path.includes('/owner/units')) return { items: units };
    if (path.includes('/owner/properties')) return { items: [{ id: 'p1', name: 'Anand Nagar', address: '1 Main Road' }] };
    if (path.includes('/owner/upi-ids')) return { upi_ids: [], default_upi_id: null, last_pay_method: null, default_pay_method: 'cash', online_available: false };
    return { items: [] };
  });
});
const wrap = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PaperProvider><AddTenant /></PaperProvider></QueryClientProvider>);

test('with room under the plan, the two buttons say Add a Unit and Add Property, and nothing says "Plan full"', async () => {
  mockAccount = { property_capacity: 5, property_count: 1 };
  const ui = wrap();
  await waitFor(() => expect(ui.getByTestId('add-property-link')).toBeTruthy());
  expect(ui.getByText('Add a Unit')).toBeTruthy();
  expect(ui.getAllByText('Add Property').length).toBeGreaterThan(0);
  expect(ui.queryByTestId('upgrade-plan-link')).toBeNull();
  expect(ui.queryByText(/plan full/i)).toBeNull();
  fireEvent.press(ui.getByTestId('add-property-link'));
  expect(mockRouter.push).toHaveBeenCalledWith('/(app)/owner/add-property');
});

test('when the plan\'s property limit is reached, the button says what to do and opens the plans', async () => {
  mockAccount = { property_capacity: 1, property_count: 1 };
  const ui = wrap();
  await waitFor(() => expect(ui.getByTestId('upgrade-plan-link')).toBeTruthy());
  expect(ui.getByText('Upgrade to Add More Properties')).toBeTruthy();
  expect(ui.queryByTestId('add-property-link')).toBeNull();
  expect(ui.queryByText(/plan full/i)).toBeNull();
  fireEvent.press(ui.getByTestId('upgrade-plan-link'));
  expect(mockRouter.push).toHaveBeenCalledWith('/(onboarding)/plan');
});

test('a property with no units yet says so in the same words used everywhere: units', async () => {
  mockAccount = { property_capacity: 5, property_count: 1 };
  const ui = wrap();
  await waitFor(() => expect(ui.getByTestId('no-places')).toBeTruthy());
  expect(ui.getByText('This property has no units yet. Add its houses, flats, rooms or shops first.')).toBeTruthy();
});

test('step 1 says which step it is and what to do, and Continue explains itself until a vacant unit is chosen', async () => {
  mockAccount = { property_capacity: 5, property_count: 1 };
  units = [{ id: 'u1', property_id: 'p1', identifier: 'S-01', floor: 1, vacant: true, tenancy_id: null }];
  const ui = wrap();
  await waitFor(() => expect(ui.getByTestId('places-dropdown')).toBeTruthy());
  expect(ui.getByText('Step 1 of 2')).toBeTruthy();
  expect(ui.getByText('Choose the Unit')).toBeTruthy();
  expect(ui.getByText('Which unit is the renter moving into? Pick a vacant unit from the list.')).toBeTruthy();
  expect(ui.getByText('Choose a vacant unit')).toBeTruthy();                        // the dropdown no longer says to type a new one: nothing can be typed here
  expect(ui.getByTestId('choose-unit-hint')).toBeTruthy();
  expect(ui.getAllByText('Add Renter').length).toBeGreaterThan(0);                  // the button says what it does, not just Continue
  expect(ui.queryByText('Continue')).toBeNull();
  expect(ui.getByTestId('step1-continue').props.accessibilityState?.disabled).toBe(true);
  fireEvent.press(ui.getByTestId('places-dropdown'));
  fireEvent.press(ui.getByTestId('unit-free-S-01'));
  await waitFor(() => expect(ui.queryByTestId('choose-unit-hint')).toBeNull());
  expect(ui.getAllByText('Add Renter to S-01').length).toBeGreaterThan(0);          // and names the unit that was chosen
  fireEvent.press(ui.getByTestId('step1-continue'));
  await waitFor(() => expect(ui.getByText('Step 2 of 2')).toBeTruthy());
  expect(ui.getByText('Renter Details')).toBeTruthy();
});

test('without an active plan the owner is told straight away, with a way to the plans, and cannot continue', async () => {
  mockAccount = { property_capacity: 5, property_count: 1 };
  subscription = { state: 'none' };
  units = [{ id: 'u1', property_id: 'p1', identifier: 'S-01', floor: 1, vacant: true, tenancy_id: null }];
  const ui = wrap();
  await waitFor(() => expect(ui.getByText('Choose a plan to add units')).toBeTruthy());
  fireEvent.press(ui.getByText('Get Started'));
  expect(mockRouter.push).toHaveBeenCalledWith('/(onboarding)/plan');
  fireEvent.press(ui.getByTestId('places-dropdown'));
  fireEvent.press(ui.getByTestId('unit-free-S-01'));
  expect(ui.getByTestId('step1-continue').props.accessibilityState?.disabled).toBe(true);
});
