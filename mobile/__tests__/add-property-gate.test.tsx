import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import AddProperty from '../app/(app)/owner/add-property';
import { queryClient } from '@/lib/queryClient';
import { api } from '@/lib/api';
import '@/i18n';

// Add property opens one form for everyone. When the server runs the automatic owner check and this account has not passed it,
// the owner is sent to that check first instead of seeing the other (document type + number + code) form.
jest.mock('@/lib/api', () => ({ api: jest.fn(), ApiError: class extends Error {}, newIdempotencyKey: () => 'k', API_URL: 'http://api.test' }));
const mockMe: any = { id: 'u1', identity_status: 'verified', owner_accounts: [{ owner_account_id: 'o1', role: 'owner', state: 'active', property_status: 'verified', property_capacity: 1, property_count: 1 }] };
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: mockMe, refresh: jest.fn(), selectOwner: jest.fn() }), ownerAccountId: () => 'o1' }));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...a: any[]) => mockPush(...a), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }, usePathname: () => '/owner/add-property', useLocalSearchParams: () => ({}) }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native'); const a = jest.requireActual('@/components/ui');
  return { ...a, Screen: ({ children }: any) => R.createElement(RN.View, null, children) };
});

const mockApi = api as jest.Mock;
const wrap = () => render(<QueryClientProvider client={queryClient}><PaperProvider><AddProperty /></PaperProvider></QueryClientProvider>);
const docs = (verified: boolean | null) => async (path: string) => {
  if (path.includes('/owner/documents')) { if (verified === null) { const e: any = new Error('nf'); e.status = 404; throw e; } return { enabled: true, items: [], verified }; }
  if (path.includes('/owner/properties')) return { items: [{ id: 'p1', name: 'Tower', address: '1 Main Road' }] };
  return {};
};

beforeEach(() => { mockApi.mockReset(); mockPush.mockReset(); queryClient.clear(); });

test('plan full, owner has a property and has not passed the owner check: Add property goes to the check, not to the units page or the other form', async () => {
  mockApi.mockImplementation(docs(false));
  const ui = wrap();
  await waitFor(() => ui.getByTestId('verify-photo-id'));
  expect(ui.queryByTestId('add-under-own-plan')).toBeNull();     // not the units page of the existing property
  expect(ui.queryByText('Document number')).toBeNull();
  fireEvent.press(ui.getByTestId('verify-photo-id'));
  expect(mockPush).toHaveBeenCalledWith('/(onboarding)/owner-details');
});

test('an owner who passed the owner check gets the one property form, without the document fields or a code', async () => {
  mockApi.mockImplementation(docs(true));
  const ui = wrap();
  await waitFor(() => ui.getByTestId('property-kind-residential'));
  expect(ui.queryByText('Document number')).toBeNull();
  expect(ui.queryByTestId('verify-photo-id')).toBeNull();
  expect(ui.queryByTestId('add-under-own-plan')).toBeNull();
});
