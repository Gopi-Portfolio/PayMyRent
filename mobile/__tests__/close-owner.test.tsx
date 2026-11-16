import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import Close from '../app/(app)/profile/close-account';
import { api } from '@/lib/api';
import '@/i18n';

const mockAuth: any = { me: { roles: ['owner'], owner_accounts: [{ owner_account_id: 'o1', role: 'owner' }] }, signOut: jest.fn() };
jest.mock('expo-router', () => ({ router: { replace: jest.fn(), push: jest.fn() }, usePathname: () => '/profile', useFocusEffect: () => undefined }));
jest.mock('@/lib/auth', () => ({ useAuth: () => mockAuth, ownerAccountId: () => 'o1' }));
jest.mock('@/lib/api', () => ({ api: jest.fn(async (path: string) => (path.includes('close-preview') ? { renters: 3, places: 5, can_transfer: true } : {})) }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
const wrap = (ui: React.ReactElement) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

test('asks whether to transfer the renters first, saying how many renters and units are affected', async () => {
  const { findByText, getByTestId } = render(wrap(<Close />));
  await findByText(/3 renter\(s\) in 5 unit\(s\)/);
  await findByText('Do you want to transfer them to someone else before closing?');
  expect(getByTestId('close-transfer-yes')).toBeTruthy();
  expect(getByTestId('close-transfer-no')).toBeTruthy();
});

test('No → close everything: the account is closed with close_rentals set', async () => {
  const { findByText, getByTestId } = render(wrap(<Close />));
  await findByText(/3 renter/);
  fireEvent.press(getByTestId('close-transfer-no'));
  fireEvent.changeText(getByTestId('close-confirm'), 'DELETE');
  fireEvent.press(getByTestId('close-final'));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/v1/me/close-account', { body: { confirm: 'DELETE', close_rentals: true } }));
});
