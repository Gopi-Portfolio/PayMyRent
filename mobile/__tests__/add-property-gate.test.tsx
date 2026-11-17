import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import AddProperty from '../app/(app)/owner/add-property';
import { queryClient } from '@/lib/queryClient';
import { api } from '@/lib/api';
import '@/i18n';

// Add property always opens the property form directly. An owner who passed the automatic owner check gets it without the document fields;
// one who has not enters the proof here, and the photo ID step is asked for only when it is really missing (and when Save is pressed).
jest.mock('@/lib/api', () => ({ api: jest.fn(), ApiError: class extends Error {}, newIdempotencyKey: () => 'k', API_URL: 'http://api.test' }));
const mockMe: any = { id: 'u1', identity_status: 'verified', owner_accounts: [{ owner_account_id: 'o1', role: 'owner', state: 'active', property_status: 'verified', property_capacity: 1, property_count: 1 }] };
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: mockMe, refresh: jest.fn(), selectOwner: jest.fn() }), ownerAccountId: () => 'o1' }));
const mockPush = jest.fn();
let mockParams: any = {};
jest.mock('expo-router', () => ({ router: { push: (...a: any[]) => mockPush(...a), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }, usePathname: () => '/owner/add-property', useLocalSearchParams: () => mockParams }));
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

beforeEach(() => { mockParams = {}; mockApi.mockReset(); mockPush.mockReset(); queryClient.clear(); });

test('plan full, owner has a property and has not passed the owner check: Add property opens the property form directly (with the proof fields), not a verify screen or the units page', async () => {
  mockApi.mockImplementation(docs(false));
  const ui = wrap();
  await waitFor(() => ui.getByTestId('property-kind-residential'));
  expect(ui.queryByTestId('verify-photo-id')).toBeNull();          // the photo ID is already verified here: nothing to verify first
  expect(ui.queryByTestId('add-under-own-plan')).toBeNull();       // not the units page of the existing property
  expect(ui.getAllByText('Document number').length).toBeGreaterThan(0);          // the check is asked for with the form, so the proof is entered here
  expect(mockPush).not.toHaveBeenCalled();
});

test('an owner who passed the owner check gets the one property form, without the document fields or a code', async () => {
  mockApi.mockImplementation(docs(true));
  const ui = wrap();
  await waitFor(() => ui.getByTestId('property-kind-residential'));
  expect(ui.queryByText('Document number')).toBeNull();
  expect(ui.queryByTestId('verify-photo-id')).toBeNull();
  expect(ui.queryByTestId('add-under-own-plan')).toBeNull();
});

test('opened from the + beside All Units, it shows the units of the property, not the new-property form', async () => {
  mockParams = { units: '1' };
  mockApi.mockImplementation(docs(true));
  const ui = wrap();
  await waitFor(() => ui.getByTestId('property-target'));
  expect(ui.queryByTestId('property-kind-residential')).toBeNull();
});
