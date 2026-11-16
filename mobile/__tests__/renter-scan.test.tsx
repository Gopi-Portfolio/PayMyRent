import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import React from 'react';
import { Alert, Linking } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import AddTenant from '../app/(app)/owner/add-tenant';
import { RenterScan } from '@/components/RenterScan';
import { setOnline } from '@/lib/network';
import { clearOfflineData } from '@/lib/offlineData';
import { outbox } from '@/lib/offline';
import { queryClient } from '@/lib/queryClient';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(), requestMediaLibraryPermissionsAsync: jest.fn(), launchCameraAsync: jest.fn(), launchImageLibraryAsync: jest.fn(),
}));
jest.mock('@/lib/photo', () => ({ shrink: jest.fn(async (a: any) => `${a.uri}?shrunk`) }));
jest.mock('@/lib/api', () => {
  class ApiError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } }
  return { api: jest.fn(), ApiError, newIdempotencyKey: () => 'key-' + Math.random().toString(36).slice(2, 14), API_URL: 'http://api.test' };
});
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: { owner_accounts: [{ owner_account_id: 'o1', verification: 'verified' }] } }), ownerAccountId: () => 'o1' }));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ unitId: 'u1', identifier: 'S-01' }), Redirect: () => null, get router() { return mockRouter; }, usePathname: () => '/owner/add-tenant' }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native'); const a = jest.requireActual('@/components/ui');
  return { ...a, Screen: ({ children }: any) => R.createElement(RN.View, null, children) };
});

const mockApi = api as jest.Mock;
const picker = ImagePicker as unknown as Record<string, jest.Mock>;
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={queryClient}><PaperProvider>{ui}</PaperProvider></QueryClientProvider>);
const photo = { canceled: false, assets: [{ uri: 'file:///card.jpg', width: 3000, height: 2000 }] };
const scanCalls = () => mockApi.mock.calls.filter((c) => c[0] === '/api/v1/owner/renter-scan');

beforeEach(async () => {
  mockApi.mockReset(); Object.values(picker).filter((f) => typeof f?.mockReset === 'function').forEach((f) => f.mockReset());
  picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true });
  picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
  picker.launchCameraAsync.mockResolvedValue(photo);
  picker.launchImageLibraryAsync.mockResolvedValue(photo);
  setOnline(true);
  await outbox.idle(); await outbox.setUser(null); await clearOfflineData('u1'); await outbox.setUser('u1');
});

describe('the scan button', () => {
  test('a photo is sent to be read, and the name and mobile number found come back for the owner to check', async () => {
    mockApi.mockResolvedValue({ name: 'IMRAN KHAN', mobile: '9123456780', found: true });
    const onRead = jest.fn();
    const ui = wrap(<RenterScan owner="o1" onRead={onRead} />);
    await act(async () => { fireEvent.press(ui.getByTestId('scan-camera')); });
    await waitFor(() => expect(onRead).toHaveBeenCalledWith({ name: 'IMRAN KHAN', mobile: '9123456780' }));
    expect(scanCalls()).toHaveLength(1);
    const [path, opts] = scanCalls()[0];
    expect(opts).toMatchObject({ method: 'POST', ownerAccount: 'o1' });
    expect(opts.form).toBeInstanceOf(FormData);
    expect(opts.idempotencyKey).toBeUndefined();                              // a scan is a question, not an entry: no key, never queued
    expect(ui.getByText('Details read from the photo. Please check them below.')).toBeTruthy();
    expect(path).toBe('/api/v1/owner/renter-scan');
  });

  test('the photo is scaled down before it is sent', async () => {
    mockApi.mockResolvedValue({ name: null, mobile: null, found: false });
    const ui = wrap(<RenterScan owner="o1" onRead={jest.fn()} />);
    await act(async () => { fireEvent.press(ui.getByTestId('scan-gallery')); });
    const { shrink } = require('@/lib/photo');
    expect(shrink).toHaveBeenCalledWith(photo.assets[0]);
  });

  test('only part of it was readable: the owner is told to fill in the rest, and what was read is still used', async () => {
    mockApi.mockResolvedValue({ name: 'RAVI KUMAR', mobile: null, found: true });
    const onRead = jest.fn();
    const ui = wrap(<RenterScan owner="o1" onRead={onRead} />);
    await act(async () => { fireEvent.press(ui.getByTestId('scan-camera')); });
    await waitFor(() => expect(onRead).toHaveBeenCalledWith({ name: 'RAVI KUMAR', mobile: null }));
    expect(ui.getByText('Some details were read. Please check them and fill in the rest.')).toBeTruthy();
  });

  test('nothing readable: a plain message, and the form is left as it was', async () => {
    mockApi.mockResolvedValue({ name: null, mobile: null, found: false });
    const onRead = jest.fn();
    const ui = wrap(<RenterScan owner="o1" onRead={onRead} />);
    await act(async () => { fireEvent.press(ui.getByTestId('scan-camera')); });
    await waitFor(() => expect(ui.getByTestId('scan-note')).toBeTruthy());
    expect(ui.getByText('Nothing could be read from this photo. Try a clearer, closer photo, or type the details.')).toBeTruthy();
    expect(onRead).not.toHaveBeenCalled();
  });

  test('camera permission refused: the owner is told how to allow it, and nothing is sent', async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const settings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    const ui = wrap(<RenterScan owner="o1" onRead={jest.fn()} />);
    await act(async () => { fireEvent.press(ui.getByTestId('scan-camera')); });
    expect(alert).toHaveBeenCalledWith('Camera is off', expect.stringContaining('Allow the camera for RentMeezy in Settings'), expect.any(Array));
    const open = (alert.mock.calls[0][2] as any[]).find((b) => b.text === 'Open Settings');      // one tap takes the person to this app's page in Settings
    open.onPress();
    expect(settings).toHaveBeenCalled();
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
    expect(mockApi).not.toHaveBeenCalled();
  });

  test('choosing a photo from the library never asks for a permission', async () => {
    mockApi.mockResolvedValue({ name: 'A B', mobile: null, found: true });
    const ui = wrap(<RenterScan owner="o1" onRead={jest.fn()} />);
    await act(async () => { fireEvent.press(ui.getByTestId('scan-gallery')); });
    expect(picker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(picker.launchImageLibraryAsync).toHaveBeenCalled();
  });

  test('closing the camera without taking a photo does nothing', async () => {
    picker.launchCameraAsync.mockResolvedValue({ canceled: true, assets: null });
    const ui = wrap(<RenterScan owner="o1" onRead={jest.fn()} />);
    await act(async () => { fireEvent.press(ui.getByTestId('scan-camera')); });
    expect(mockApi).not.toHaveBeenCalled();
    expect(ui.queryByTestId('scan-note')).toBeNull();
  });

  test('the reader is unavailable on the server: the owner sees the message to type the details, and the app does not crash', async () => {
    mockApi.mockRejectedValue(Object.assign(new Error('the photo could not be read just now: type the details instead'), { status: 503, code: 'PROVIDER_ERROR' }));
    const ui = wrap(<RenterScan owner="o1" onRead={jest.fn()} />);
    await act(async () => { fireEvent.press(ui.getByTestId('scan-camera')); });
    await waitFor(() => expect(ui.getByText(/type the details instead/)).toBeTruthy());
    expect(ui.queryByTestId('scan-reading')).toBeNull();                       // no longer "reading"
  });

  test('OFFLINE: scanning is switched off with a clear reason, and nothing is saved for later', async () => {
    setOnline(false);
    const ui = wrap(<RenterScan owner="o1" onRead={jest.fn()} />);
    expect(ui.getByText('Scanning needs the internet. You can type the details now.')).toBeTruthy();
    expect(ui.getByTestId('scan-camera').props.accessibilityState?.disabled).toBe(true);
    expect(ui.getByTestId('scan-gallery').props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(ui.getByTestId('scan-camera'));
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
    expect(outbox.getSnapshot()).toEqual([]);
  });

  test('while a photo is being read the buttons cannot be pressed again', async () => {
    let finish: (v: unknown) => void = () => undefined;
    mockApi.mockImplementation(() => new Promise((r) => { finish = r; }));
    const ui = wrap(<RenterScan owner="o1" onRead={jest.fn()} />);
    await act(async () => { fireEvent.press(ui.getByTestId('scan-camera')); });
    await waitFor(() => expect(ui.getByTestId('scan-reading')).toBeTruthy());
    expect(ui.getByTestId('scan-camera').props.accessibilityState?.disabled).toBe(true);
    await act(async () => { finish({ name: null, mobile: null, found: false }); });
  });
});

describe('in Add Renter', () => {
  test('a scanned ID fills the name and mobile of the form; the owner can still change them before saving', async () => {
    mockApi.mockImplementation(async (path: string) => (path === '/api/v1/owner/renter-scan' ? { name: 'IMRAN KHAN', mobile: '9123456780', found: true } : { items: [] }));
    const ui = wrap(<AddTenant />);
    expect(ui.getByTestId('renter-scan')).toBeTruthy();
    await act(async () => { fireEvent.press(ui.getByTestId('scan-camera')); });
    await waitFor(() => expect(ui.getByTestId('renter-name').props.value).toBe('IMRAN KHAN'));
    expect(ui.getByTestId('renter-mobile').props.value).toBe('9123456780');
    fireEvent.changeText(ui.getByTestId('renter-name'), 'Imran Khan Sr');         // a reading mistake is simply corrected
    expect(ui.getByTestId('renter-name').props.value).toBe('IMRAN KHAN SR');
  });

  test('a scan that found only a name keeps the mobile number the owner had already typed', async () => {
    mockApi.mockImplementation(async (path: string) => (path === '/api/v1/owner/renter-scan' ? { name: 'IMRAN KHAN', mobile: null, found: true } : { items: [] }));
    const ui = wrap(<AddTenant />);
    fireEvent.changeText(ui.getByTestId('renter-mobile'), '9876543210');
    await act(async () => { fireEvent.press(ui.getByTestId('scan-camera')); });
    await waitFor(() => expect(ui.getByTestId('renter-name').props.value).toBe('IMRAN KHAN'));
    expect(ui.getByTestId('renter-mobile').props.value).toBe('9876543210');
  });
});
