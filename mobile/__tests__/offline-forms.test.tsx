import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import AllotRenter from '../app/(app)/owner/allot';
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
let mockParams: Record<string, string> = { open: 'r1' };
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams, Redirect: () => null, get router() { return mockRouter; }, usePathname: () => '/owner/add-tenant' }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native'); const a = jest.requireActual('@/components/ui');
  return { ...a, Screen: ({ children }: any) => R.createElement(RN.View, null, children) };
});

const mockApi = api as jest.Mock;
const UNITS = { items: [{ id: 'u1', property_id: 'p1', identifier: 'S-01', vacant: true, tenancy_id: null, tenant_name: null }, { id: 'u2', property_id: 'p1', identifier: 'S-02', vacant: true, tenancy_id: null, tenant_name: null }] };
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={queryClient}><PaperProvider>{ui}</PaperProvider></QueryClientProvider>);
const ALLOT = (id = 'r1') => `/api/v1/owner/renters/${id}/allot`;
const allotPosts = (id = 'r1') => mockApi.mock.calls.filter((c) => c[0] === ALLOT(id));
const failure = (code: string) => new (require('@/lib/api').ApiError)(0, code, 'the connection failed');
const RENTERS = { items: [{ id: 'r1', name: 'Ravi Kumar', phone: '+919876543210', email: 'ravi@example.com', address: null, id_type: 'pan' },
                          { id: 'r2', name: 'Selvi', phone: '+919123456780', email: null, address: null, id_type: 'aadhaar' }] };
const PROPS = { items: [{ id: 'p1', name: 'Tower', address: '1 Main Road' }] };
const respond = (path: string) => {
  if (path.endsWith('/allot')) return { tenancy_id: 't-new', notified: { sms: 'sent', whatsapp: 'sent', email: 'sent' } };
  if (path.startsWith('/api/v1/owner/renters')) return RENTERS;
  if (path === '/api/v1/owner/properties') return PROPS;
  if (path.startsWith('/api/v1/owner/units')) return UNITS;
  return { items: [] };
};

async function allot(ui: ReturnType<typeof render>, unit = 'S-01', id = 'r1') {
  await waitFor(() => ui.getByTestId(`allot-panel-${id}`));
  await waitFor(() => ui.getByTestId('places-dropdown'));
  fireEvent.press(ui.getByTestId('places-dropdown'));
  fireEvent.press(ui.getByTestId(`unit-free-${unit}`));
  fireEvent.changeText(ui.getByTestId('allot-rent'), '12000');
  fireEvent.changeText(ui.getByTestId('allot-advance'), '24000');
  await act(async () => { fireEvent.press(ui.getByTestId('assign-button')); });
}

beforeEach(async () => {
  mockApi.mockReset(); mockRouter.back.mockReset(); hideToast();
  mockParams = { open: 'r1' };
  setOnline(true);
  await outbox.idle(); await outbox.setUser(null); await clearOfflineData('u1'); await outbox.setUser('u1');
  queryClient.clear();
  queryClient.setQueryData(['units', 'o1', 'active'], UNITS);
  queryClient.setQueryData(['vacant', 'o1'], UNITS);
  queryClient.setQueryData(['renters', 'o1', 'new'], RENTERS);
  queryClient.setQueryData(['properties', 'o1'], PROPS);          // what an earlier visit left on the phone, so the panel works offline
  mockApi.mockImplementation(async (path: string) => respond(path));
});

describe('Allot Renter', () => {
  test('ONLINE: sent at once with a key, the renter is told, and nothing is saved for later', async () => {
    const ui = wrap(<AllotRenter />);
    await allot(ui);
    await waitFor(() => ui.getByTestId('allot-done'));
    expect(ui.getByText(/Ravi Kumar is allotted S-01/)).toBeTruthy();
    expect(allotPosts()).toHaveLength(1);
    expect(allotPosts()[0][1].idempotencyKey).toMatch(/^key-/);
    expect(allotPosts()[0][1].body).toMatchObject({ unit_id: 'u1', monthly_rent: '12000', security_deposit: '24000', due_day: 5 });
    expect(outbox.getSnapshot()).toEqual([]);
  });

  test('there is one way to add a property/unit (the button by the renter), not a second one below; a Done button closes the screen', async () => {
    const ui = wrap(<AllotRenter />);
    await waitFor(() => ui.getByTestId('allot-panel-r1'));
    await waitFor(() => ui.getByTestId('places-dropdown'));
    expect(ui.getAllByText('Add property/unit')).toHaveLength(1);        // the other waiting renter's button; the open one says Close, and none is inside the panel
    expect(ui.queryByTestId('add-unit-link')).toBeNull();
    fireEvent.press(ui.getByTestId('allot-done-button'));
    expect(mockRouter.back).toHaveBeenCalled();
  });

  test('Remove renter asks once, then deletes the renter from the waiting list; Cancel does nothing', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const ui = wrap(<AllotRenter />);
    await waitFor(() => ui.getByTestId('remove-renter-r2'));
    fireEvent.press(ui.getByTestId('remove-renter-r2'));
    expect(alert).toHaveBeenCalledWith('Remove Selvi?', expect.stringContaining('ID photo will be erased'), expect.any(Array));
    expect(mockApi.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(false);          // nothing happens until it is confirmed
    const buttons = alert.mock.calls[0][2] as any[];
    expect(buttons.map((b) => b.text)).toEqual(['Cancel', 'Remove renter']);
    await act(async () => { await buttons[1].onPress(); });
    expect(mockApi.mock.calls.filter((c) => c[0] === '/api/v1/owner/renters/r2' && c[1]?.method === 'DELETE')).toHaveLength(1);
    alert.mockRestore();
  });

  test('the panel is three plain steps; the dates are already filled in and hidden until asked for, and a summary says what will happen', async () => {
    const ui = wrap(<AllotRenter />);
    await waitFor(() => ui.getByTestId('places-dropdown'));
    for (const step of ['1. Choose the property and unit', '2. Set the rent', '3. Confirm']) expect(ui.getByText(step)).toBeTruthy();
    expect(ui.queryByTestId('allot-end')).toBeNull();
    fireEvent.press(ui.getByTestId('allot-more'));
    expect(ui.getByTestId('allot-end')).toBeTruthy();
    fireEvent.press(ui.getByTestId('places-dropdown'));
    fireEvent.press(ui.getByTestId('unit-free-S-01'));
    fireEvent.changeText(ui.getByTestId('allot-rent'), '12000');
    expect(ui.getByTestId('allot-summary')).toBeTruthy();
    expect(ui.getByText('Ravi Kumar will get S-01 at ₹12000 a month.')).toBeTruthy();
  });

  test('after one renter is assigned the next waiting renter opens by itself, so the list can be finished one after another', async () => {
    const ui = wrap(<AllotRenter />);
    await allot(ui);
    await waitFor(() => ui.getByTestId('allot-done'));
    await waitFor(() => ui.getByTestId('allot-panel-r2'));
  });

  test('OFFLINE: nothing is sent; one entry is saved, the unit shows as rented (waiting), the renter leaves the waiting list, and the person is told', async () => {
    setOnline(false);
    const ui = wrap(<AllotRenter />);
    await allot(ui);
    await waitFor(() => expect(outbox.pendingCount()).toBe(1));
    expect(allotPosts()).toHaveLength(0);
    const [item] = outbox.getSnapshot();
    expect(item).toMatchObject({ kind: 'renter.allot', path: ALLOT(), ownerAccount: 'o1', status: 'pending', label: 'Allot Ravi Kumar to S-01' });
    expect(item.body).toMatchObject({ unit_id: 'u1', monthly_rent: '12000', security_deposit: '24000' });
    const units = (queryClient.getQueryData(['units', 'o1', 'active']) as any).items;
    expect(units[0]).toMatchObject({ vacant: false, tenant_name: 'Ravi Kumar', pending: true });
    expect(units[1]).toMatchObject({ vacant: true });
    expect((queryClient.getQueryData(['vacant', 'o1']) as any).items.map((u: any) => u.id)).toEqual(['u2']);
    expect((queryClient.getQueryData(['renters', 'o1', 'new']) as any).items.map((r: any) => r.id)).toEqual(['r2']);
    expect(currentToast()).toBe("Saved on this phone. It will be sent when you're back online.");
  });

  test('OFFLINE, then the connection returns: the very same entry is sent, once, with the same key', async () => {
    setOnline(false);
    const ui = wrap(<AllotRenter />);
    await allot(ui);
    await waitFor(() => expect(outbox.pendingCount()).toBe(1));
    const saved = outbox.getSnapshot()[0];
    setOnline(true);
    await act(async () => { await outbox.flush(); });
    expect(allotPosts()).toHaveLength(1);
    expect(allotPosts()[0][1].idempotencyKey).toBe(saved.idempotencyKey);
    expect(allotPosts()[0][1].body).toEqual(saved.body);
    expect(outbox.getSnapshot()).toEqual([]);
  });

  test('THE LOST REPLY: online, but no answer comes back; the entry is saved and sent again with the same key, so the server does it once', async () => {
    mockApi.mockImplementation(async (path: string) => { if (path === ALLOT()) throw failure('TIMEOUT'); return respond(path); });
    const ui = wrap(<AllotRenter />);
    await allot(ui);
    await waitFor(() => expect(outbox.pendingCount()).toBe(1));
    const firstKey = allotPosts()[0][1].idempotencyKey;
    expect(outbox.getSnapshot()[0].idempotencyKey).toBe(firstKey);
    mockApi.mockImplementation(async (path: string) => respond(path));
    await act(async () => { await outbox.flush({ force: true }); });
    expect(allotPosts().map((c) => c[1].idempotencyKey)).toEqual([firstKey, firstKey]);
  });

  test('a refusal while online (the unit was taken meanwhile) is shown as before, and nothing is saved', async () => {
    mockApi.mockImplementation(async (path: string) => { if (path === ALLOT()) throw Object.assign(new Error('S-01 is already let'), { status: 409, code: 'UNIT_OCCUPIED' }); return respond(path); });
    const ui = wrap(<AllotRenter />);
    await allot(ui);
    await waitFor(() => expect(ui.getByText('S-01 is already let')).toBeTruthy());
    expect(ui.queryByTestId('allot-done')).toBeNull();
    expect(outbox.getSnapshot()).toEqual([]);
  });

  test('two renters allotted offline to two different units are two separate saved entries, in order', async () => {
    setOnline(false);
    for (const [id, unit] of [['r1', 'S-01'], ['r2', 'S-02']]) {
      mockParams = { open: id };
      const ui = wrap(<AllotRenter />);
      await allot(ui, unit, id);
      await waitFor(() => expect(outbox.pendingCount()).toBeGreaterThanOrEqual(1));
      ui.unmount();
    }
    expect(outbox.getSnapshot().map((i) => i.path)).toEqual([ALLOT('r1'), ALLOT('r2')]);
    expect(outbox.getSnapshot().map((i) => (i.body as any).unit_id)).toEqual(['u1', 'u2']);
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

  test('a renter can be allotted a unit that was itself added offline: both are sent in order, and the renter gets the unit\'s real id', async () => {
    setOnline(false);
    const places = wrap(<PlacesManager propertyId="p1" owner="o1" />);
    fireEvent.press(places.getByTestId('kind-commercial'));
    fireEvent.changeText(places.getByTestId('unit-name'), 'Shop 12');
    await act(async () => { fireEvent.press(places.getByTestId('add-place')); });
    await waitFor(() => places.getByTestId('place-added'));
    const newUnit = (queryClient.getQueryData(['units', 'o1', 'active']) as any).items.find((u: any) => u.identifier === 'SHOP 12');
    expect(newUnit.id).toMatch(/^local-/);
    places.unmount();

    // the owner allots a renter to that unit (its id is the stand-in until the server gives the real one)
    const { submitOrQueue } = require('@/lib/offline');
    await submitOrQueue({ kind: 'renter.allot', label: 'renter', path: ALLOT(), ownerAccount: 'o1', body: { unit_id: newUnit.id, monthly_rent: '5000' } });
    expect(outbox.getSnapshot().map((i) => i.kind)).toEqual(['unit.create', 'renter.allot']);

    mockApi.mockImplementation(async (path: string) => (path === '/api/v1/owner/units' ? { id: 'REAL-UNIT', identifier: 'SHOP 12' } : { tenancy_id: 'REAL-TENANCY' }));
    setOnline(true);
    await act(async () => { await outbox.flush(); });
    const sent = mockApi.mock.calls.filter((c) => (c[0] as string).startsWith('/api/v1/owner/') && c[1]?.body).map((c) => [c[0], c[1].body]);
    expect(sent[0][0]).toBe('/api/v1/owner/units');
    expect(sent[1]).toEqual([ALLOT(), { unit_id: 'REAL-UNIT', monthly_rent: '5000' }]);
    expect(outbox.getSnapshot()).toEqual([]);
  });
});
