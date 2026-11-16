import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import AddRenter from '../app/(app)/owner/add-tenant';
import { setOnline } from '@/lib/network';
import { queryClient } from '@/lib/queryClient';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(), requestMediaLibraryPermissionsAsync: jest.fn(), launchCameraAsync: jest.fn(), launchImageLibraryAsync: jest.fn(),
}));
jest.mock('@/lib/photo', () => ({ shrink: jest.fn(async (a: any) => `${a.uri}?shrunk`) }));
jest.mock('@/lib/api', () => {
  class ApiError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } }
  return { api: jest.fn(), ApiError, newIdempotencyKey: () => 'key-x', API_URL: 'http://api.test' };
});
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: { owner_accounts: [{ owner_account_id: 'o1', verification: 'verified' }] } }), ownerAccountId: () => 'o1' }));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({}), Redirect: () => null, get router() { return mockRouter; }, usePathname: () => '/owner/add-tenant' }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native'); const a = jest.requireActual('@/components/ui');
  return { ...a, Screen: ({ children }: any) => R.createElement(RN.View, null, children) };
});

const mockApi = api as jest.Mock;
const picker = ImagePicker as unknown as Record<string, jest.Mock>;
const wrap = () => render(<QueryClientProvider client={queryClient}><PaperProvider><AddRenter /></PaperProvider></QueryClientProvider>);
const posts = () => mockApi.mock.calls.filter((c) => c[0] === '/api/v1/owner/renters');

beforeEach(() => {
  mockApi.mockReset(); mockRouter.replace.mockReset();
  mockApi.mockResolvedValue({ id: 'r-new' });
  Object.values(picker).filter((f) => typeof f?.mockReset === 'function').forEach((f) => f.mockReset());
  picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true });
  picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
  picker.launchCameraAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///id.jpg', width: 3000, height: 2000 }] });
  picker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///id.jpg', width: 3000, height: 2000 }] });
  setOnline(true);
});

async function fill(ui: ReturnType<typeof render>, over: { name?: string; mobile?: string } = {}) {
  fireEvent.changeText(ui.getByTestId('renter-name'), over.name ?? 'Ravi Kumar');
  fireEvent.changeText(ui.getByTestId('renter-mobile'), over.mobile ?? '9876543210');
}

test('the form asks for who the renter is, and nothing about rent', () => {
  const ui = wrap();
  for (const id of ['renter-name', 'renter-mobile', 'renter-email', 'renter-address', 'id-camera', 'id-upload', 'keep-copy', 'save-renter']) expect(ui.getByTestId(id)).toBeTruthy();
  for (const id of ['id-type-aadhaar', 'id-type-pan', 'id-type-voter', 'id-type-driving', 'id-type-passport']) expect(ui.getByTestId(id)).toBeTruthy();
  expect(ui.queryByTestId('allot-rent')).toBeNull();
});

test('name, mobile, the type of ID, its photo and the permission tick are all required: nothing is sent without them', async () => {
  const ui = wrap();
  await act(async () => { fireEvent.press(ui.getByTestId('save-renter')); });
  expect(posts()).toHaveLength(0);
  expect(ui.getByText('A photo of the ID is required.')).toBeTruthy();
  expect(ui.getByText('Choose the type of ID.')).toBeTruthy();
  expect(ui.getByText('Please tick to confirm.')).toBeTruthy();
  await fill(ui);
  fireEvent.press(ui.getByTestId('id-type-pan'));
  await act(async () => { fireEvent.press(ui.getByTestId('id-upload')); });
  await waitFor(() => ui.getByTestId('id-preview'));
  await act(async () => { fireEvent.press(ui.getByTestId('save-renter')); });
  expect(posts()).toHaveLength(0);                                     // still no tick
});

test('choosing Aadhaar says its first 8 digits are hidden automatically', () => {
  const ui = wrap();
  expect(ui.queryByTestId('aadhaar-note')).toBeNull();
  fireEvent.press(ui.getByTestId('id-type-aadhaar'));
  expect(ui.getByTestId('aadhaar-note')).toBeTruthy();
});

test('a complete form uploads the details with the shrunk photo, then goes to Allot Renter with this renter open', async () => {
  const appended: [string, any][] = [];
  const spy = jest.spyOn(FormData.prototype, 'append').mockImplementation((k: string, v: any) => { appended.push([k, v]); });
  const ui = wrap();
  await fill(ui);
  fireEvent.changeText(ui.getByTestId('renter-email'), 'ravi@example.com');
  fireEvent.changeText(ui.getByTestId('renter-address'), '12 Market Road, Madurai');
  fireEvent.press(ui.getByTestId('id-type-voter'));
  await act(async () => { fireEvent.press(ui.getByTestId('id-camera')); });
  await waitFor(() => ui.getByTestId('id-preview'));
  fireEvent.press(ui.getByTestId('keep-copy'));
  await act(async () => { fireEvent.press(ui.getByTestId('save-renter')); });
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/(app)/owner/allot', params: { open: 'r-new' } }));
  expect(posts()).toHaveLength(1);
  spy.mockRestore();
  expect(posts()[0][1].form).toBeTruthy();
  const parts = Object.fromEntries(appended);
  expect(parts).toMatchObject({ name: 'RAVI KUMAR', phone: '9876543210', id_type: 'voter', keep_copy_ok: 'true', email: 'ravi@example.com' });
  expect(parts.file.uri).toBe('file:///id.jpg?shrunk');
});

test('offline: the photo cannot be uploaded, so saving is switched off with a clear reason', async () => {
  setOnline(false);
  const ui = wrap();
  expect(ui.getByTestId('needs-internet')).toBeTruthy();
  await act(async () => { fireEvent.press(ui.getByTestId('save-renter')); });
  expect(posts()).toHaveLength(0);
  setOnline(true);
});

test('a refusal from the server (for example the same mobile twice) is shown on the form', async () => {
  mockApi.mockRejectedValue(Object.assign(new Error('you have already added a renter with this mobile number'), { status: 409, code: 'CONFLICT' }));
  const ui = wrap();
  await fill(ui);
  fireEvent.press(ui.getByTestId('id-type-pan'));
  await act(async () => { fireEvent.press(ui.getByTestId('id-upload')); });
  await waitFor(() => ui.getByTestId('id-preview'));
  fireEvent.press(ui.getByTestId('keep-copy'));
  await act(async () => { fireEvent.press(ui.getByTestId('save-renter')); });
  await waitFor(() => expect(ui.getByText(/already added a renter/)).toBeTruthy());
  expect(mockRouter.replace).not.toHaveBeenCalled();
});
