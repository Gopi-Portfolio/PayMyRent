import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import Notifications from '../app/notifications';
import MessageOwner from '../app/(app)/tenant/message';
import '@/i18n';

const mockPush = jest.fn();
let mockRole = 'tenant';
const mockApi = jest.fn(async (path: string, opts?: any) => {
  if (path.includes('/tenant/rentals')) return { items: [{ id: 't1', status: 'active', owner_name: 'Ravi Kumar', identifier: 'S-01' }] };
  if (path.includes('/me/notifications?role=tenant')) return { unread: 0, items: [{ id: 'n1', template: 'owner_message', text: 'Ravi Kumar: Rent is due on the 5th', created_at: '2026-11-01T10:00:00Z', unread: false, tenancy_id: 't1' }] };
  if (path.includes('/me/notifications?role=owner')) return { unread: 0, items: [{ id: 'n2', template: 'renter_message', text: 'Asha (S-01): The tap is leaking', created_at: '2026-11-01T10:00:00Z', unread: false, tenancy_id: 't1' }] };
  return { status: 'sent' };
});
jest.mock('@/lib/api', () => ({ api: (...a: any[]) => (mockApi as any)(...a), newIdempotencyKey: () => 'req-12345678', ApiError: class extends Error {} }));
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: { roles: ['owner', 'tenant'] }, activeRole: mockRole }) }));
jest.mock('expo-router', () => ({ router: { push: (...a: any[]) => mockPush(...a), replace: jest.fn(), canGoBack: () => false }, useLocalSearchParams: () => ({ tenancyId: 't1' }), useFocusEffect: () => {}, usePathname: () => '/' }));
jest.mock('@/components/ui', () => ({ ...jest.requireActual('@/components/ui'), DemoBanner: () => null }));

const wrap = (ui: React.ReactElement) => <QueryClientProvider client={new QueryClient()}><PaperProvider>{ui}</PaperProvider></QueryClientProvider>;

test('a renter can reply to an owner message straight from the bell', async () => {
  mockRole = 'tenant'; mockPush.mockClear();
  const ui = render(wrap(<Notifications />));
  await waitFor(() => ui.getByTestId('notification-owner_message'));
  expect(ui.getByTestId('reply-owner_message')).toBeTruthy();
  fireEvent.press(ui.getByTestId('notification-owner_message'));
  expect(mockPush).toHaveBeenCalledWith('/(app)/tenant/message?tenancyId=t1');
});

test('an owner can reply to a renter message from the bell, into the existing message screen', async () => {
  mockRole = 'owner'; mockPush.mockClear();
  const ui = render(wrap(<Notifications />));
  await waitFor(() => ui.getByTestId('notification-renter_message'));
  fireEvent.press(ui.getByTestId('notification-renter_message'));
  expect(mockPush).toHaveBeenCalledWith('/(app)/owner/message?tenancyId=t1');
});

test('the renter types a message and sends it to the owner', async () => {
  const ui = render(wrap(<MessageOwner />));
  await waitFor(() => ui.getByTestId('message-text'));
  expect((ui.getByTestId('send-to-owner').props.accessibilityState ?? {}).disabled).toBe(true);     // nothing typed yet
  fireEvent.changeText(ui.getByTestId('message-text'), 'The tap in the kitchen is leaking');
  fireEvent.press(ui.getByTestId('send-to-owner'));
  await waitFor(() => ui.getByTestId('message-done'));
  const post = mockApi.mock.calls.find((c: any[]) => c[1]?.body) as any[];
  expect(post[0]).toBe('/api/v1/tenant/tenancies/t1/messages');
  expect(post[1].body).toMatchObject({ text: 'The tap in the kitchen is leaking', input_method: 'typed' });
});
