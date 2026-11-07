import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { RenterVacate } from '@/components/VacateRequest';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('@/lib/api', () => ({ api: jest.fn(async () => ({})) }));
const wrap = (ui: React.ReactElement) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
const rental = { id: 'ten-1', status: 'active', identifier: 'D-05', owner_name: 'Viji', vacate: null };

test('the request goes to the chosen rental only, with the move-out date', async () => {
  const { getByTestId } = render(wrap(<RenterVacate rental={rental} />));
  fireEvent.press(getByTestId('vacate-ask-open'));
  fireEvent.press(getByTestId('vacate-send'));
  await waitFor(() => expect(api).toHaveBeenCalled());
  const [path, opts] = (api as jest.Mock).mock.calls[0];
  expect(path).toBe('/api/v1/tenancies/ten-1/vacate-request');
  expect(opts.body.move_out_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('while the owner has not answered, the renter sees a waiting card and can take the request back; an ended rental shows nothing', async () => {
  const waiting = { ...rental, vacate: { id: 'v-1', status: 'requested', move_out_date: '2026-12-01' } };
  const { getByText, getByTestId, queryByTestId, rerender } = render(wrap(<RenterVacate rental={waiting} />));
  getByText('Waiting for your owner');
  fireEvent.press(getByTestId('vacate-cancel'));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/v1/vacate-requests/v-1/cancel', { method: 'POST' }));
  rerender(wrap(<RenterVacate rental={{ ...rental, status: 'ended' }} />));
  expect(queryByTestId('vacate-ask-open')).toBeNull();
});
