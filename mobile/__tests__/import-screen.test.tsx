import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import ImportScreen from '../app/(app)/owner/import';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('@/lib/api', () => ({ api: jest.fn(), API_URL: 'http://api.test' }));
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: { owner_accounts: [] } }), ownerAccountId: () => 'o1' }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///renters.xlsx', name: 'renters.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] })) }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native'); const a = jest.requireActual('@/components/ui');
  return { ...a, Screen: ({ children }: any) => R.createElement(RN.View, null, children) };
});

const mockApi = api as jest.Mock;
const wrap = () => render(<QueryClientProvider client={new QueryClient()}><PaperProvider><ImportScreen /></PaperProvider></QueryClientProvider>);
beforeEach(() => mockApi.mockReset());

test('before anything is done, the screen says what the import is, who can use it, what it adds, what information the file needs and why', () => {
  const ui = wrap();
  expect(ui.getByText('Import Renters from Excel')).toBeTruthy();
  expect(ui.getByText('Already have a list of your renters? Add them all at once instead of one by one.')).toBeTruthy();
  expect(ui.getByText('Who can import')).toBeTruthy();
  expect(ui.getByText(/Only owners\. Your owner details must be submitted, and you need an active plan/)).toBeTruthy();
  expect(ui.getByText('What gets added')).toBeTruthy();
  expect(ui.getByText(/Every row of your file becomes one rental: its property, unit, renter and rent terms/)).toBeTruthy();
  expect(ui.getByText('What each row needs')).toBeTruthy();
  expect(ui.getByText(/Property address, unit name or number, renter name, renter mobile \(10 digits\), monthly rent, rent due day, start date/)).toBeTruthy();
  expect(ui.getByText(/^Optional: property name, city/)).toBeTruthy();
  expect(ui.getByText('Why use it')).toBeTruthy();
  expect(ui.getByText(/you save typing each renter one by one/)).toBeTruthy();
});

test('the five steps are numbered, the template button is under step 1, and nothing is saved until the owner confirms', () => {
  const ui = wrap();
  expect(ui.getByText('How it works')).toBeTruthy();
  for (const n of ['1', '2', '3', '4', '5']) expect(ui.getAllByText(n).length).toBeGreaterThan(0);
  expect(ui.getByText('Download the template. It explains every column.')).toBeTruthy();
  expect(ui.getByText('Fill in one row for each unit that has a renter.')).toBeTruthy();
  expect(ui.getByText(/^Nothing is saved until you confirm/)).toBeTruthy();
  fireEvent.press(ui.getByTestId('download-template'));
  expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('http://api.test/api/v1/owner/imports/template');
});

test('choosing a file shows how many rows are ready in plain words, and confirming says how many renters were imported', async () => {
  mockApi.mockImplementation(async (path: string) => {
    if (path === '/api/v1/owner/imports') return { job_id: 'j1', file_errors: [], can_commit: true, new_units: 2, remaining_capacity: 8,
      rows: [{ row: 2, valid: true, errors: [], unit: 'S-01', tenant: 'Ravi' }, { row: 3, valid: false, errors: [{ field: 'tenant_mobile', code: 'mobile_10_digits' }], unit: 'S-02', tenant: 'Selvi' }] };
    return { imported: 1, failed: [{ row: 3, code: 'X' }] };
  });
  const ui = wrap();
  await act(async () => { fireEvent.press(ui.getByTestId('choose-xlsx')); });
  await waitFor(() => expect(ui.getByTestId('import-summary')).toBeTruthy());
  expect(ui.getByText('1 of 2 rows are ready · 2 new units · room for 8 more units')).toBeTruthy();
  expect(ui.getByText('Row 2: S-01 Ravi')).toBeTruthy();
  expect(ui.getByText('Ready')).toBeTruthy();
  await act(async () => { fireEvent.press(ui.getByTestId('import-confirm')); });
  await waitFor(() => expect(ui.getByText('Imported 1 renters. Skipped 1.')).toBeTruthy());
});
