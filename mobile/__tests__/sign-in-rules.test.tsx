import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import Otp from '../app/(public)/otp';
import { api } from '@/lib/api';
import { setPendingRole } from '@/lib/landing';
import { otpSession } from '@/lib/otpSession';
import '@/i18n';

// Renter door: only a number an owner added or invited gets in. Owner door: a first-time owner with no plan gets no token (the server says PLAN_REQUIRED).
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ Redirect: () => null, usePathname: () => '/otp', router: { replace: (...a: any[]) => mockReplace(...a), push: jest.fn(), back: jest.fn(), canGoBack: () => true } }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/lib/api', () => ({ api: jest.fn() }));
const mockVerify = jest.fn();
const mockSignOut = jest.fn(async () => undefined);
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ verifyOtp: mockVerify, requestOtp: jest.fn(), signOut: mockSignOut, me: null }) }));

const mockApi = api as jest.Mock;
const open = async () => {
  const ui = render(<PaperProvider><Otp /></PaperProvider>);
  fireEvent.changeText(ui.getByTestId('otp-input'), '123456');
  const v = ui.getAllByText('Verify'); fireEvent.press(v[v.length - 1]);
  return ui;
};

beforeEach(() => { jest.clearAllMocks(); otpSession.current = { phoneE164: '+919000000001', demoCode: '123456' } as any; mockVerify.mockResolvedValue(undefined); });
afterEach(() => setPendingRole(null));

test('renter door, number not registered by any owner: signed out again, told why, and the app does not open', async () => {
  setPendingRole('tenant');
  mockApi.mockResolvedValue({ registered: false });
  const ui = await open();
  await waitFor(() => ui.getByText(/not registered as a renter/i));
  expect(mockApi).toHaveBeenCalledWith('/api/v1/me/renter-access');
  expect(mockSignOut).toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
});

test('renter door, number an owner added: goes on into the app', async () => {
  setPendingRole('tenant');
  mockApi.mockResolvedValue({ registered: true });
  await open();
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
  expect(mockSignOut).not.toHaveBeenCalled();
});

test('renter door, the check itself fails: not let in', async () => {
  setPendingRole('tenant');
  mockApi.mockRejectedValue(new Error('network'));
  const ui = await open();
  await waitFor(() => ui.getByText(/not registered as a renter/i));
  expect(mockReplace).not.toHaveBeenCalled();
});

test('owner door or no door: the renter check is not asked', async () => {
  setPendingRole('owner');
  await open();
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
  expect(mockApi).not.toHaveBeenCalled();
});

test('a first-time owner with no plan is sent to choose a plan, not shown an error', async () => {
  setPendingRole('owner');
  mockVerify.mockRejectedValue(Object.assign(new Error('choose a plan first'), { code: 'PLAN_REQUIRED' }));
  await open();
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith({ pathname: '/(public)/plans', params: { first: '1' } }));
  expect(otpSession.current).toBeNull();
});
