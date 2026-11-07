import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { BellButton } from '@/components/Bell';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('@/lib/api', () => ({ api: jest.fn() }));
let mockRole: 'owner' | 'tenant' = 'tenant';
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: { roles: ['owner', 'tenant'] }, activeRole: mockRole }) }));
const wrap = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PaperProvider><BellButton /></PaperProvider></QueryClientProvider>);

test('the bell shows how many notifications are new', async () => {
  (api as jest.Mock).mockResolvedValue({ items: [], unread: 3 });
  const ui = wrap();
  await waitFor(() => expect(ui.getByTestId('bell-count')).toBeTruthy());
  expect(ui.getByText('3')).toBeTruthy();
});

test('many new ones show as 9+, and nothing new shows no number', async () => {
  (api as jest.Mock).mockResolvedValue({ items: [], unread: 14 });
  const many = wrap();
  await waitFor(() => expect(many.getByText('9+')).toBeTruthy());
  (api as jest.Mock).mockResolvedValue({ items: [], unread: 0 });
  const none = wrap();
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(none.queryByTestId('bell-count')).toBeNull();
});

test('the bell asks for the news of the role in use', async () => {
  (api as jest.Mock).mockResolvedValue({ items: [], unread: 1 });
  mockRole = 'owner';
  const ui = wrap();
  await waitFor(() => expect(ui.getByTestId('bell-count')).toBeTruthy());
  expect(api).toHaveBeenLastCalledWith('/api/v1/me/notifications?role=owner');
  mockRole = 'tenant';
});
