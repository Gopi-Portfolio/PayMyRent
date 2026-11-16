import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import AddTenant from '../app/(app)/owner/add-tenant';
import { api } from '@/lib/api';
import { addMonthsDMY, dmyToIso, todayDMY } from '@/lib/dates';
import '@/i18n';

jest.mock('@/lib/api', () => {
  function ApiError(this: any, status: number, code: string, message: string) { this.status = status; this.code = code; this.message = message; }
  ApiError.prototype = Object.create(Error.prototype);
  return { api: jest.fn(), ApiError, newIdempotencyKey: () => 'key-1' };
});
jest.mock('@/lib/auth', () => ({
  useAuth: () => ({ me: { owner_accounts: [{ owner_account_id: 'o1', verification: 'verified' }] } }), ownerAccountId: () => 'o1',
}));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ unitId: 'u1', identifier: 'S-01' }), Redirect: () => null, get router() { return mockRouter; }, usePathname: () => '/owner/add-tenant' }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native'); const a = jest.requireActual('@/components/ui');
  return { ...a, Screen: ({ children }: any) => R.createElement(RN.View, null, children) };       // the page frame is not what is tested here
});

const mockApi = api as jest.Mock;
let idVerified = true;
beforeEach(() => {
  mockApi.mockReset(); mockRouter.back.mockReset();
  idVerified = true;
  mockApi.mockImplementation(async (path: string) => {
    if (path.includes('/owner/renter-check')) return { id_verified: idVerified };
    if (path.includes('/owner/upi-ids')) return { upi_ids: [], default_upi_id: null, last_pay_method: null, default_pay_method: 'cash', online_available: false };
    if (path.includes('/owner/tenancies')) return { tenancy_id: 't1' };
    return { items: [] };
  });
});
const wrap = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PaperProvider><AddTenant /></PaperProvider></QueryClientProvider>);

test('the quick form asks only for name, mobile, rent and advance; the rest waits under More Details', async () => {
  const ui = wrap();
  expect(ui.getByTestId('quick-name')).toBeTruthy();
  expect(ui.getByTestId('quick-mobile')).toBeTruthy();
  expect(ui.getByTestId('quick-rent')).toBeTruthy();
  expect(ui.getByTestId('quick-advance')).toBeTruthy();
  expect(ui.getByText('More Details')).toBeTruthy();
  expect(ui.queryByTestId('end-date-input')).toBeNull();                       // dates, due day, items and the rest are hidden until opened
  fireEvent.press(ui.getByText('More Details'));
  await waitFor(() => expect(ui.getByTestId('end-date-input')).toBeTruthy());
});

test('a renter whose photo ID is verified gets a badge, and nothing else about them is shown', async () => {
  const ui = wrap();
  expect(ui.queryByTestId('id-verified')).toBeNull();
  fireEvent.changeText(ui.getByTestId('quick-mobile'), '9876543210');
  await waitFor(() => expect(ui.getByTestId('id-verified')).toBeTruthy());
  expect(ui.getByText('Photo ID verified')).toBeTruthy();
  expect(mockApi.mock.calls.some((c) => String(c[0]).includes('/owner/renter-check?mobile=9876543210'))).toBe(true);
});

test('a renter who is not verified, or a number still being typed, shows no badge', async () => {
  idVerified = false;
  const ui = wrap();
  fireEvent.changeText(ui.getByTestId('quick-mobile'), '98765');
  expect(mockApi.mock.calls.some((c) => String(c[0]).includes('/owner/renter-check'))).toBe(false);          // nothing is asked until all 10 digits are in
  fireEvent.changeText(ui.getByTestId('quick-mobile'), '9876543210');
  await waitFor(() => expect(mockApi.mock.calls.some((c) => String(c[0]).includes('/owner/renter-check'))).toBe(true));
  await act(async () => undefined);
  expect(ui.queryByTestId('id-verified')).toBeNull();
});

test('saving sends the sensible defaults: due on the 5th, starting today, ending after 11 months', async () => {
  const ui = wrap();
  fireEvent.changeText(ui.getByTestId('quick-name'), 'Ravi Kumar');
  fireEvent.changeText(ui.getByTestId('quick-mobile'), '9876543210');
  fireEvent.changeText(ui.getByTestId('quick-rent'), '12000');
  fireEvent.changeText(ui.getByTestId('quick-advance'), '24000');
  await waitFor(() => expect(mockApi.mock.calls.some((c) => String(c[0]).includes('/owner/upi-ids'))).toBe(true));
  // Save is pressed until the request goes out: it is refused (and More Details opens) only while the owner's usual way of receiving rent is still loading
  const posted = () => mockApi.mock.calls.some((c) => String(c[0]) === '/api/v1/owner/tenancies');
  await waitFor(async () => { if (!posted()) await act(async () => { fireEvent.press(ui.getByTestId('submit-tenancy')); }); expect(posted()).toBe(true); });
  await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
  const call = mockApi.mock.calls.find((c) => String(c[0]) === '/api/v1/owner/tenancies')!;
  expect(call[1].body).toMatchObject({
    unit_id: 'u1', tenant_name: 'RAVI KUMAR', tenant_mobile: '9876543210', monthly_rent: '12000', security_deposit: '24000', due_day: 5,
    start_date: dmyToIso(todayDMY()), end_date: dmyToIso(addMonthsDMY(todayDMY(), 11)),
  });
});

test('saving with a missing field does not send anything', async () => {
  const ui = wrap();
  fireEvent.changeText(ui.getByTestId('quick-name'), 'Ravi Kumar');
  await act(async () => { fireEvent.press(ui.getByTestId('submit-tenancy')); });
  expect(mockApi.mock.calls.some((c) => String(c[0]) === '/api/v1/owner/tenancies')).toBe(false);
});
