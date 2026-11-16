import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import AddTenant from '../app/(app)/owner/add-tenant';
import { PlacesManager } from '@/components/PlacesManager';
import { setOnline } from '@/lib/network';
import { clearOfflineData } from '@/lib/offlineData';
import { outbox } from '@/lib/offline';
import { queryClient } from '@/lib/queryClient';
import { currentToast, hideToast } from '@/lib/toast';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('@/lib/api', () => {
  class ApiError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } }
  return { api: jest.fn(), ApiError, newIdempotencyKey: () => 'key-' + Math.random().toString(36).slice(2, 14), API_URL: 'http://api.test' };
});
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: { owner_accounts: [{ owner_account_id: 'o1', verification: 'verified' }] } }), ownerAccountId: () => 'o1' }));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ unitId: 'u1', identifier: 'S-01' }), Redirect: () => null, get router() { return mockRouter; }, usePathname: () => '/owner/add-tenant' }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native'); const a = jest.requireActual('@/components/ui');
  return { ...a, Screen: ({ children }: any) => R.createElement(RN.View, null, children) };
});

const mockApi = api as jest.Mock;
const UNITS = { items: [{ id: 'u1', property_id: 'p1', identifier: 'S-01', vacant: true, tenancy_id: null, tenant_name: null }, { id: 'u2', property_id: 'p1', identifier: 'S-02', vacant: true, tenancy_id: null, tenant_name: null }] };
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={queryClient}><PaperProvider>{ui}</PaperProvider></QueryClientProvider>);
const tenancyPosts = () => mockApi.mock.calls.filter((c) => c[0] === '/api/v1/owner/tenancies');
const failure = (code: string) => new (require('@/lib/api').ApiError)(0, code, 'the connection failed');

async function fillRenter(ui: ReturnType<typeof render>) {
  fireEvent.changeText(ui.getByTestId('quick-name'), 'Ravi Kumar');
  fireEvent.changeText(ui.getByTestId('quick-mobile'), '9876543210');
  fireEvent.changeText(ui.getByTestId('quick-rent'), '12000');
  fireEvent.changeText(ui.getByTestId('quick-advance'), '24000');
}

beforeEach(async () => {
  mockApi.mockReset(); mockRouter.back.mockReset(); hideToast();
  setOnline(true);
  await outbox.idle(); await outbox.setUser(null); await clearOfflineData('u1'); await outbox.setUser('u1');
  queryClient.clear();
  // what an earlier visit left on the phone: the owner's usual way of receiving rent, and the units
  queryClient.setQueryData(['upi-ids', 'o1'], { upi_ids: [], default_upi_id: null, last_pay_method: null, default_pay_method: 'cash', online_available: false });
  queryClient.setQueryData(['units', 'o1', 'active'], UNITS);
  queryClient.setQueryData(['vacant', 'o1'], UNITS);
  mockApi.mockImplementation(async (path: string) => (path === '/api/v1/owner/tenancies' ? { tenancy_id: 't-new' } : { items: [] }));
});

describe('Add Renter', () => {
  test('ONLINE: sent at once with a key, nothing is saved for later', async () => {
    const ui = wrap(<AddTenant />);
    await fillRenter(ui);
    await act(async () => { fireEvent.press(ui.getByTestId('submit-tenancy')); });
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(tenancyPosts()).toHaveLength(1);
    expect(tenancyPosts()[0][1].idempotencyKey).toMatch(/^key-/);
    expect(tenancyPosts()[0][1].body).toMatchObject({ unit_id: 'u1', tenant_name: 'RAVI KUMAR', tenant_mobile: '9876543210', monthly_rent: '12000', security_deposit: '24000' });
    expect(outbox.getSnapshot()).toEqual([]);
  });

  test('OFFLINE: nothing is sent; one entry is saved on the phone, the unit shows as rented (waiting) and is no longer offered, and the person is told', async () => {
    setOnline(false);
    const ui = wrap(<AddTenant />);
    await fillRenter(ui);
    await act(async () => { fireEvent.press(ui.getByTestId('submit-tenancy')); });
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());           // the form closes: the entry is safe
    expect(tenancyPosts()).toHaveLength(0);
    const [item] = outbox.getSnapshot();
    expect(outbox.getSnapshot()).toHaveLength(1);
    expect(item).toMatchObject({ kind: 'tenancy.create', path: '/api/v1/owner/tenancies', ownerAccount: 'o1', status: 'pending', label: 'Add renter RAVI KUMAR to S-01' });
    expect(item.body).toMatchObject({ unit_id: 'u1', tenant_name: 'RAVI KUMAR', tenant_mobile: '9876543210', monthly_rent: '12000', security_deposit: '24000', due_day: 5, pay_method: 'cash' });
    const units = (queryClient.getQueryData(['units', 'o1', 'active']) as any).items;
    expect(units[0]).toMatchObject({ vacant: false, tenant_name: 'RAVI KUMAR', pending: true });
    expect(units[1]).toMatchObject({ vacant: true });
    expect((queryClient.getQueryData(['vacant', 'o1']) as any).items.map((u: any) => u.id)).toEqual(['u2']);
    expect(currentToast()).toBe("Saved on this phone. It will be sent when you're back online.");
  });

  test('OFFLINE, then the connection returns: the very same entry is sent, once, with the same key', async () => {
    setOnline(false);
    const ui = wrap(<AddTenant />);
    await fillRenter(ui);
    await act(async () => { fireEvent.press(ui.getByTestId('submit-tenancy')); });
    await waitFor(() => expect(outbox.pendingCount()).toBe(1));
    const saved = outbox.getSnapshot()[0];
    setOnline(true);
    await act(async () => { await outbox.flush(); });
    expect(tenancyPosts()).toHaveLength(1);
    expect(tenancyPosts()[0][1].idempotencyKey).toBe(saved.idempotencyKey);
    expect(tenancyPosts()[0][1].body).toEqual(saved.body);
    expect(outbox.getSnapshot()).toEqual([]);
  });

  test('THE LOST REPLY: online, but no answer comes back; the entry is saved and sent again with the same key, so the server does it once', async () => {
    mockApi.mockImplementation(async (path: string) => { if (path === '/api/v1/owner/tenancies') throw failure('TIMEOUT'); return { items: [] }; });
    const ui = wrap(<AddTenant />);
    await fillRenter(ui);
    await act(async () => { fireEvent.press(ui.getByTestId('submit-tenancy')); });
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    const firstKey = tenancyPosts()[0][1].idempotencyKey;
    expect(outbox.getSnapshot()[0].idempotencyKey).toBe(firstKey);
    mockApi.mockImplementation(async () => ({ tenancy_id: 't-new' }));
    await act(async () => { await outbox.flush({ force: true }); });
    expect(tenancyPosts().map((c) => c[1].idempotencyKey)).toEqual([firstKey, firstKey]);
  });

  test('a refusal while online (the unit was taken meanwhile) is shown on the form as before, and nothing is saved', async () => {
    mockApi.mockImplementation(async (path: string) => { if (path === '/api/v1/owner/tenancies') throw Object.assign(new Error('S-01 is already let'), { status: 409, code: 'UNIT_OCCUPIED' }); return { items: [] }; });
    const ui = wrap(<AddTenant />);
    await fillRenter(ui);
    await act(async () => { fireEvent.press(ui.getByTestId('submit-tenancy')); });
    await waitFor(() => expect(ui.getByText('S-01 is already let')).toBeTruthy());
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(outbox.getSnapshot()).toEqual([]);
  });

  test('two renters added offline for two different units are two separate saved entries, in order', async () => {
    setOnline(false);
    for (const [name, mobile] of [['Ravi Kumar', '9876543210'], ['Selvi', '9123456780']]) {
      const ui = wrap(<AddTenant />);
      fireEvent.changeText(ui.getByTestId('quick-name'), name); fireEvent.changeText(ui.getByTestId('quick-mobile'), mobile);
      fireEvent.changeText(ui.getByTestId('quick-rent'), '5000'); fireEvent.changeText(ui.getByTestId('quick-advance'), '10000');
      await act(async () => { fireEvent.press(ui.getByTestId('submit-tenancy')); });
      await waitFor(() => expect(outbox.pendingCount()).toBeGreaterThanOrEqual(1));
      ui.unmount();
    }
    expect(outbox.getSnapshot().map((i) => (i.body as any).tenant_name)).toEqual(['RAVI KUMAR', 'SELVI']);
    expect(new Set(outbox.getSnapshot().map((i) => i.idempotencyKey)).size).toBe(2);
  });
});

describe('Add Unit', () => {
  test('OFFLINE: the unit is saved, shown in the list at once as waiting, and sent later with its key', async () => {
    setOnline(false);
    const ui = wrap(<PlacesManager propertyId="p1" owner="o1" />);
    fireEvent.press(ui.getByTestId('kind-commercial'));
    fireEvent.changeText(ui.getByTestId('unit-name'), 'Shop 12');
    await act(async () => { fireEvent.press(ui.getByTestId('add-place')); });
    await waitFor(() => ui.getByTestId('place-added'));
    expect(mockApi.mock.calls.some((c) => c[0] === '/api/v1/owner/units' && c[1]?.body)).toBe(false);
    const [item] = outbox.getSnapshot();
    expect(item).toMatchObject({ kind: 'unit.create', path: '/api/v1/owner/units', label: 'Add unit SHOP 12' });
    expect(item.body).toMatchObject({ property_id: 'p1', identifier: 'SHOP 12', kind: 'commercial' });
    expect(ui.getAllByText(/SHOP 12/).length).toBeGreaterThanOrEqual(2);         // in the list of units already, and in the "added" message
  });

  test('a renter can be added to a unit that was itself added offline: both are sent in order, and the renter gets the unit\'s real id', async () => {
    setOnline(false);
    const places = wrap(<PlacesManager propertyId="p1" owner="o1" />);
    fireEvent.press(places.getByTestId('kind-commercial'));
    fireEvent.changeText(places.getByTestId('unit-name'), 'Shop 12');
    await act(async () => { fireEvent.press(places.getByTestId('add-place')); });
    await waitFor(() => places.getByTestId('place-added'));
    const newUnit = (queryClient.getQueryData(['units', 'o1', 'active']) as any).items.find((u: any) => u.identifier === 'SHOP 12');
    expect(newUnit.id).toMatch(/^local-/);
    places.unmount();

    // the owner adds a renter to that unit (its id is the stand-in until the server gives the real one)
    const { submitOrQueue } = require('@/lib/offline');
    await submitOrQueue({ kind: 'tenancy.create', label: 'renter', path: '/api/v1/owner/tenancies', ownerAccount: 'o1', body: { unit_id: newUnit.id, tenant_name: 'RAVI' } });
    expect(outbox.getSnapshot().map((i) => i.kind)).toEqual(['unit.create', 'tenancy.create']);

    mockApi.mockImplementation(async (path: string) => (path === '/api/v1/owner/units' ? { id: 'REAL-UNIT', identifier: 'SHOP 12' } : { tenancy_id: 'REAL-TENANCY' }));
    setOnline(true);
    await act(async () => { await outbox.flush(); });
    const sent = mockApi.mock.calls.filter((c) => (c[0] as string).startsWith('/api/v1/owner/') && c[1]?.body).map((c) => [c[0], c[1].body]);
    expect(sent[0][0]).toBe('/api/v1/owner/units');
    expect(sent[1]).toEqual(['/api/v1/owner/tenancies', { unit_id: 'REAL-UNIT', tenant_name: 'RAVI' }]);
    expect(outbox.getSnapshot()).toEqual([]);
  });
});
