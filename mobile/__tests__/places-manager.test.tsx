import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { PlacesManager } from '@/components/PlacesManager';
import { brand } from '@/theme';
import '@/i18n';

const mockApi = jest.fn(async (path: string, opts?: any) => {
  if (path.startsWith('/api/v1/owner/units') && opts?.body) return { id: 'u9', identifier: opts.body.identifier };
  return { items: [{ id: 'u1', property_id: 'p1', identifier: 'S-01', kind: 'commercial', floor: 0, vacant: true },
                   { id: 'u2', property_id: 'p2', identifier: 'OTHER-1', kind: 'residential', floor: null, vacant: true }] };
});
jest.mock('@/lib/api', () => ({ api: (...a: any[]) => (mockApi as any)(...a), ApiError: class extends Error {}, newIdempotencyKey: () => 'key-' + Math.random().toString(36).slice(2, 14), API_URL: 'http://api.test' }));

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
  expect(post[1].idempotencyKey).toMatch(/^key-/);                       // sent with a key, so a retry can never add the unit twice
});

test('each unit shows R for residential or C for commercial instead of an icon', async () => {
  mockApi.mockImplementationOnce(async () => ({ items: [
    { id: 'u1', property_id: 'p1', identifier: 'S-01', kind: 'commercial', floor: 0, vacant: true },
    { id: 'u3', property_id: 'p1', identifier: 'F-02', kind: 'residential', floor: 1, vacant: true }] }));
  const ui = render(wrap(<PlacesManager propertyId="p1" owner="o1" />));
  await waitFor(() => ui.getByText(/S-01/));
  expect(ui.getByTestId('unit-kind-u1').props.accessibilityLabel).toBeTruthy();
  expect(ui.getAllByText('C').length).toBeGreaterThan(0);
  expect(ui.getAllByText('R').length).toBeGreaterThan(0);
  expect(JSON.stringify(ui.getByTestId('unit-kind-u1').props.style)).toContain('#F97316');      // C is orange
  expect(JSON.stringify(ui.getByTestId('unit-kind-u3').props.style)).toContain(brand.blue600);      // R is blue (the app's blue)
});
