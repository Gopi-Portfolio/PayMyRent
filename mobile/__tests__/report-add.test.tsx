import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import Report from '../app/(app)/owner/report/[kind]';
import '@/i18n';

// The lists behind All Renters, All Units and All Properties each have an add button at the top (not on the home tiles).
let mockKind = 'renters';
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...a: any[]) => mockPush(...a), back: jest.fn(), replace: jest.fn() }, useLocalSearchParams: () => ({ kind: mockKind }), usePathname: () => '/report' }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/lib/api', () => ({ api: jest.fn(async () => ({ items: [], total_paise: null, total_display: null })), API_URL: 'http://api.test' }));
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: { id: 'u1', owner_accounts: [{ owner_account_id: 'o1' }] } }), ownerAccountId: () => 'o1' }));
jest.mock('@/components/DownloadButtons', () => ({ DownloadButtons: () => null }));
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native'); const a = jest.requireActual('@/components/ui');
  return { ...a, Screen: ({ children }: any) => R.createElement(RN.View, null, children) };
});
const wrap = () => render(<QueryClientProvider client={new QueryClient()}><PaperProvider><Report /></PaperProvider></QueryClientProvider>);
beforeEach(() => mockPush.mockReset());

test.each([
  ['renters', 'Add Renter', '/(app)/owner/add-tenant'],
  ['units', 'Add a Unit', { pathname: '/(app)/owner/add-property', params: { units: '1' } }],
  ['properties', 'Add Property', '/(app)/owner/add-property'],
])('the %s list has an add button that opens its add screen', async (kind, label, to) => {
  mockKind = kind;
  const ui = wrap();
  await waitFor(() => ui.getByTestId('report-add'));
  expect(ui.getByText(label)).toBeTruthy();
  fireEvent.press(ui.getByTestId('report-add'));
  expect(mockPush).toHaveBeenCalledWith(to);
});

test.each(['collected', 'pending', 'overdue'])('the %s list has no add button', async (kind) => {
  mockKind = kind;
  const ui = wrap();
  await waitFor(() => ui.getByText(/Nothing to show/i));
  expect(ui.queryByTestId('report-add')).toBeNull();
});

test('the units list shows no first-letter circle on its rows', async () => {
  mockKind = 'units';
  const api = require('@/lib/api').api as jest.Mock;
  api.mockResolvedValueOnce({ items: [{ id: 'u1', identifier: 'S-01', kind: 'commercial', property_name: 'Tower', address: '1 Main Road', tenant_name: null }], total_paise: null, total_display: null });
  const ui = wrap();
  await waitFor(() => ui.getByText(/S-01/));
  expect(ui.queryByText('S')).toBeNull();            // the circle would show S, the first letter of S-01
});

// React Native's own rule: a bare string directly inside a View is an error on the phone ("Text strings must be rendered within a <Text> component")
function strayStrings(node: any, parent = 'root', out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === 'string') { if (!/^(Text|TextInput|RNText|Animated\.Text|ExpoLinearGradient)$/.test(parent) && !parent.includes('Text')) out.push(`"${node}" inside ${parent}`); return out; }
  (Array.isArray(node) ? node : [node]).forEach((n) => { if (typeof n === 'string') strayStrings(n, parent, out); else if (n) (n.children ?? []).forEach((c: any) => strayStrings(c, n.type, out)); });
  return out;
}


test.each(['units', 'renters', 'properties'])('the %s list draws no bare text outside a text element (the "Text strings must be rendered within a <Text>" crash)', async (kind) => {
  mockKind = kind;
  const api = require('@/lib/api').api as jest.Mock;
  api.mockResolvedValueOnce({ items: [{ id: 'u1', tenancy_id: 't1', identifier: 'S-01', kind: 'commercial', property_name: 'Tower', address: '1 Main Road', city: 'Madurai',
                                        tenant_name: 'Ravi', amount_paise: 100000, unit_count: 2, vacant_count: 1 }], total_paise: null, total_display: null });
  const ui = wrap();
  await waitFor(() => expect(ui.getAllByText(/S-01|Ravi|Tower/).length).toBeGreaterThan(0));
  expect(strayStrings(ui.toJSON())).toEqual([]);
});

test('the add button sits below the list, not above it', async () => {
  mockKind = 'units';
  const api = require('@/lib/api').api as jest.Mock;
  api.mockResolvedValueOnce({ items: [{ id: 'u1', identifier: 'S-01', kind: 'commercial', property_name: 'Tower', address: '1 Main Road', tenant_name: null }], total_paise: null, total_display: null });
  const ui = wrap();
  await waitFor(() => ui.getByText(/S-01/));
  const tree = JSON.stringify(ui.toJSON());
  expect(tree.indexOf('S-01')).toBeGreaterThan(-1);
  expect(tree.indexOf('report-add')).toBeGreaterThan(tree.indexOf('S-01'));
});
