import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { OwnerDocumentCheck } from '@/components/OwnerDocumentCheck';
import '@/i18n';

jest.mock('@/lib/api', () => ({ api: jest.fn() }));
jest.mock('@/lib/auth', () => ({
  useAuth: () => ({ me: { full_name: 'Ramesh Kumar', address: '', roles: ['owner'], owner_accounts: [{ owner_account_id: 'o1', role: 'owner' }] }, activeRole: 'owner', refresh: jest.fn() }),
  ownerAccountId: () => 'o1',
}));
jest.mock('expo-router', () => ({ router: { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: () => false }, usePathname: () => '/onboarding/owner-details', useRouter: () => ({ replace: jest.fn(), push: jest.fn(), back: jest.fn() }), useSegments: () => [], useFocusEffect: () => undefined, Redirect: () => null }));
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(), requestMediaLibraryPermissionsAsync: jest.fn(), launchCameraAsync: jest.fn(), launchImageLibraryAsync: jest.fn(),
  CameraType: { front: 'front' },
}));
jest.mock('expo-image-manipulator', () => ({ ImageManipulator: { manipulate: jest.fn() }, SaveFormat: { JPEG: 'jpeg' } }));

const docs = (uploaded: string[] = []) => ({ verified: false, items: ['pan', 'aadhaar', 'aadhaar_back', 'selfie', 'deed_first', 'deed_last'].map((kind) => ({ kind: kind as any, uploaded: uploaded.includes(kind) })) });
const show = (d = docs()) => render(<QueryClientProvider client={new QueryClient()}><PaperProvider><OwnerDocumentCheck docs={d} /></PaperProvider></QueryClientProvider>);

test('the first page says Full Name, and the property document, its two pages and the selfie are one module each', () => {
  const ui = show();
  expect(ui.getAllByText('Full Name').length).toBeGreaterThan(0);     // not "Name as on PAN" (the field draws its label twice)
  expect(ui.queryByText('Name as on PAN')).toBeNull();
  expect(ui.getByText('Property document')).toBeTruthy();            // type + number + both pages in the same module
  expect(ui.getByText('First page')).toBeTruthy();
  expect(ui.getByText('Last page (signatures)')).toBeTruthy();
  expect(ui.getByTestId('doc-camera-deed_first')).toBeTruthy();
  expect(ui.getByTestId('doc-camera-deed_last')).toBeTruthy();
  expect(ui.getByTestId('doc-camera-pan')).toBeTruthy();
  expect(ui.getByTestId('doc-camera-selfie')).toBeTruthy();
  expect(ui.queryByTestId('doc-gallery-selfie')).toBeNull();         // the selfie is live camera only
});

test('Aadhaar shows its front and back side by side in one module, PAN shows one tile', () => {
  const ui = show();
  expect(ui.queryByTestId('doc-camera-aadhaar')).toBeNull();
  fireEvent.press(ui.getByTestId('doc-id-aadhaar'));
  expect(ui.getByText('Front side')).toBeTruthy();
  expect(ui.getByText('Back side')).toBeTruthy();
  expect(ui.getByTestId('doc-camera-aadhaar')).toBeTruthy();
  expect(ui.getByTestId('doc-camera-aadhaar_back')).toBeTruthy();
  expect(ui.queryByTestId('doc-camera-pan')).toBeNull();
  fireEvent.press(ui.getByTestId('doc-id-pan'));
  expect(ui.getByTestId('doc-camera-pan')).toBeTruthy();
});

test('an uploaded page shows a tick and offers Retake; Continue needs everything', () => {
  const ui = show(docs(['pan', 'deed_first']));
  expect(ui.getAllByText('Retake').length).toBe(2);
  fireEvent.press(ui.getByTestId('doc-continue'));
  expect(ui.getByText('Fill in every field and upload all four photos to continue.')).toBeTruthy();
});

describe('choosing a photo', () => {
  const picker = require('expo-image-picker');
  beforeEach(() => { Object.values(picker).forEach((f: any) => typeof f?.mockReset === 'function' && f.mockReset()); });

  test('Gallery opens the phone\'s picker straight away, without asking for photo access (it was refused or limited before)', async () => {
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true });
    const ui = show();
    fireEvent.press(ui.getByTestId('doc-gallery-pan'));
    await waitFor(() => expect(picker.launchImageLibraryAsync).toHaveBeenCalledTimes(1));
    expect(picker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
  });

  test('Gallery works for Aadhaar front and back too', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true });
    const ui = show();
    fireEvent.press(ui.getByTestId('doc-id-aadhaar'));
    fireEvent.press(ui.getByTestId('doc-gallery-aadhaar'));
    fireEvent.press(ui.getByTestId('doc-gallery-aadhaar_back'));
    await waitFor(() => expect(picker.launchImageLibraryAsync).toHaveBeenCalledTimes(2));
  });

  test('Camera still needs permission: when refused, the camera is not opened and the person is told', async () => {
    const alert = jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => undefined);
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    const ui = show();
    fireEvent.press(ui.getByTestId('doc-camera-pan'));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
    alert.mockRestore();
  });
});
