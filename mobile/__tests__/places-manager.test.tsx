import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { PlacesManager } from '@/components/PlacesManager';
import '@/i18n';

const mockApi = jest.fn(async (path: string, opts?: any) => {
  if (path.startsWith('/api/v1/owner/units') && opts?.body) return { id: 'u9', identifier: opts.body.identifier };
  return { items: [{ id: 'u1', property_id: 'p1', identifier: 'S-01', kind: 'commercial', floor: 0, vacant: true },
                   { id: 'u2', property_id: 'p2', identifier: 'OTHER-1', kind: 'residential', floor: null, vacant: true }] };
});
jest.mock('@/lib/api', () => ({ api: (...a: any[]) => (mockApi as any)(...a), ApiError: class extends Error {} }));

const wrap = (ui: React.ReactElement) => <QueryClientProvider client={new QueryClient()}><PaperProvider>{ui}</PaperProvider></QueryClientProvider>;

test('Add Property lists only this property\'s places and is where a new place is entered', async () => {
  const ui = render(wrap(<PlacesManager propertyId="p1" owner="o1" />));
  await waitFor(() => ui.getByText(/S-01/));
  expect(ui.queryByText(/OTHER-1/)).toBeNull();                       // another property's place is not listed
  fireEvent.press(ui.getByTestId('add-place'));                         // empty name: nothing is sent
  expect(mockApi.mock.calls.some((c: any[]) => c[1]?.body)).toBe(false);
  fireEvent.press(ui.getByTestId('kind-commercial'));
  fireEvent.changeText(ui.getByTestId('unit-name'), 'Shop 12');
  fireEvent.press(ui.getByTestId('add-place'));
  await waitFor(() => ui.getByTestId('place-added'));
  const post = mockApi.mock.calls.find((c: any[]) => c[1]?.body) as any[];
  expect(post[0]).toBe('/api/v1/owner/units');
  expect(post[1].body).toMatchObject({ property_id: 'p1', kind: 'commercial', floor: null });
});
