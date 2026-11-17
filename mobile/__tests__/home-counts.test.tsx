import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import OwnerHome from '../app/(app)/owner/index';
import { queryClient } from '@/lib/queryClient';
import { api } from '@/lib/api';
import { setViewAll } from '@/lib/propertyView';
import '@/i18n';

// After a reload the home screen must show the owner's real numbers, not zeros: for one property and for all of them together.
let mockOwners: any[] = [];
const mockSelect = jest.fn();
jest.mock('@/lib/api', () => ({ api: jest.fn(), ApiError: class extends Error {}, API_URL: 'http://api.test' }));
jest.mock('@/lib/auth', () => ({
  useAuth: () => ({ me: { id: 'u1', roles: ['owner'], identity_status: 'verified', profile_complete: true, owner_accounts: mockOwners }, selectOwner: mockSelect, refresh: jest.fn(), activeRole: 'owner', gender: null, signOut: jest.fn() }),
  ownerAccountId: () => mockOwners[0]?.owner_account_id,
  ownerProperties: (me: any) => me.owner_accounts,
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn(), navigate: jest.fn() }, usePathname: () => '/owner', useFocusEffect: () => undefined, Redirect: () => null }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

const mockApi = api as jest.Mock;
const owner = (id: string) => ({ owner_account_id: id, role: 'owner', state: 'active', property_status: 'verified', property_name: `P-${id}` });
const metrics = (renters: number, units: number, properties: number) => ({ metrics: {
  collected_paise: { value: 0, display: '₹0' }, pending_paise: { value: 250000, display: '₹2,500' }, overdue_paise: { value: 0, display: '₹0' },
  units, renters, properties, residential: units, commercial: 0, approvals_pending: 0, relief_pending: 0, vacate_pending: 0 }, subscription: { state: 'active' } });
const wrap = () => render(<QueryClientProvider client={queryClient}><PaperProvider><OwnerHome /></PaperProvider></QueryClientProvider>);

beforeEach(() => {
  queryClient.clear(); mockApi.mockReset(); mockSelect.mockReset();
  mockApi.mockImplementation(async (path: string, o: any) => {
    if (path.includes('/owner/dashboard')) return o?.ownerAccount === 'b' ? metrics(3, 6, 1) : metrics(2, 4, 1);
    if (path.includes('/owner/units')) return { items: [] };
    return { items: [] };
  });
});

const texts = (node: any, out: string[] = []): string[] => {
  if (node == null) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { node.forEach((n) => texts(n, out)); return out; }
  (node.children ?? []).forEach((c: any) => texts(c, out));
  return out;
};
const tile = (ui: ReturnType<typeof wrap>, id: string) => texts(ui.getByTestId(id)).join(' ');      // all the text drawn inside that tile

test('one property: the tiles show that property\'s real counts', async () => {
  mockOwners = [owner('a')];
  act(() => setViewAll(false));
  const ui = wrap();
  await waitFor(() => expect(texts(ui.toJSON()).join(' ')).toContain('All Renters'));
  await waitFor(() => expect(String(tile(ui, 'metric-renters'))).toContain('2'), { timeout: 4000 });
  expect(String(tile(ui, 'metric-units'))).toContain('4');
  expect(String(tile(ui, 'metric-properties'))).toContain('1');
});

test('all properties together: the counts are added up, not zero', async () => {
  mockOwners = [owner('a'), owner('b')];
  act(() => setViewAll(true));
  const ui = wrap();
  await waitFor(() => expect(String(tile(ui, 'metric-renters'))).toContain('5'), { timeout: 4000 });    // 2 + 3
  expect(String(tile(ui, 'metric-units'))).toContain('10');                                              // 4 + 6
  expect(String(tile(ui, 'metric-properties'))).toContain('2');                                          // 1 + 1
});
