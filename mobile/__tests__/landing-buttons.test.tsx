import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { View } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import Role from '../app/(onboarding)/role';
import Welcome from '../app/(public)/welcome';
import * as SecureStore from 'expo-secure-store';
import { api } from '@/lib/api';
import { getPendingPlan, getPendingRole, setPendingPlan, setPendingRole } from '@/lib/landing';
import '@/i18n';

const mockRouter = { canGoBack: jest.fn(() => true), back: jest.fn(), replace: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({ usePathname: () => '/', get router() { return mockRouter; }, useFocusEffect: () => undefined }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/lib/api', () => ({ api: jest.fn() }));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(async () => undefined), deleteItemAsync: jest.fn(async () => undefined) }));
const mockAuth: any = { me: null, refresh: jest.fn(), requestOtp: jest.fn(), signOut: jest.fn(async () => undefined) };
jest.mock('@/lib/auth', () => ({ useAuth: () => mockAuth, ownerAccountId: () => null }));
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native'); const a = jest.requireActual('@/components/ui');
  return { ...a, Screen: ({ children }: any) => R.createElement(RN.View, null, children) };
});

const PLANS = [
  { code: 'starter', label: 'Starter', price_paise: 1000, price_display: '₹10', max_units: 10, max_properties: 1, ai_enabled: false, ai_monthly_tokens: 0 },
  { code: 'growth', label: 'Growth', price_paise: 5000, price_display: '₹50', max_units: 100, max_properties: 5, regular_price_display: '₹65', saving_percent: 23, ai_enabled: true, ai_monthly_tokens: 100000 },
];
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}><PaperProvider>{ui}</PaperProvider></QueryClientProvider>);
beforeEach(() => { mockRouter.push.mockReset(); (api as jest.Mock).mockReset(); setPendingPlan(null); setPendingRole(null); });

async function showPlans(ui: ReturnType<typeof render>) {
  await waitFor(() => expect(ui.UNSAFE_getAllByType(View).some((v) => typeof v.props.onLayout === 'function')).toBe(true));
  act(() => ui.UNSAFE_getAllByType(View).find((v) => typeof v.props.onLayout === 'function')!.props.onLayout({ nativeEvent: { layout: { width: 360, height: 800 } } }));
  await waitFor(() => expect(ui.getByTestId('choose-growth')).toBeTruthy());
}

test('there is no owner button: choosing a plan takes a new owner straight to sign-in, and the Renter button is always ready', async () => {
  (api as jest.Mock).mockResolvedValue({ plans: PLANS });
  const ui = wrap(<Welcome />);
  expect(ui.queryByTestId('cta-owner')).toBeNull();
  expect(ui.getByText('New owner? Choose a plan to get started')).toBeTruthy();
  expect(ui.getByTestId('cta-renter').props.accessibilityState.disabled).toBe(false);
  expect(ui.getByText('Renters never pay for RentMeezy.')).toBeTruthy();
  await showPlans(ui);
  await act(async () => { fireEvent.press(ui.getByTestId('choose-growth')); });
  expect(mockRouter.push).toHaveBeenCalledWith('/(public)/phone');
  expect(getPendingPlan()).toBe('growth');
  expect(getPendingRole()).toBe('owner');
});

test('the Renter button goes straight to sign-in with no plan and the renter role', async () => {
  (api as jest.Mock).mockResolvedValue({ plans: PLANS });
  setPendingPlan('growth');
  const ui = wrap(<Welcome />);
  fireEvent.press(ui.getByTestId('cta-renter'));
  expect(mockRouter.push).toHaveBeenCalledWith('/(public)/phone');
  expect(getPendingPlan()).toBeNull();
  expect(getPendingRole()).toBe('tenant');
});

test('after the first sign-in the role the visitor used on the landing page is applied, so they are not asked again', async () => {
  (api as jest.Mock).mockResolvedValue({});
  setPendingRole('owner');
  wrap(<Role />);
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/v1/me/roles', { body: { roles: ['owner'] } }));
  expect(getPendingRole()).toBeNull();                                                       // used once
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/(onboarding)/profile'));
});

test('without a door used on the landing page the three role choices are still there', () => {
  const ui = wrap(<Role />);
  for (const k of ['owner', 'tenant', 'both']) expect(ui.getByTestId(`role-${k}`)).toBeTruthy();
  expect(api).not.toHaveBeenCalled();
});

test('someone already signed in can still enter a different number straight from the landing page', async () => {
  (api as jest.Mock).mockResolvedValue({ plans: PLANS });
  mockAuth.me = { roles: ['tenant'], profile_complete: true, owner_accounts: [] };
  try {
    const ui = wrap(<Welcome />);
    expect(ui.getByTestId('cta-dashboard')).toBeTruthy();
    await act(async () => { fireEvent.press(ui.getByTestId('cta-other-number')); });
    expect(mockAuth.signOut).toHaveBeenCalled();
    expect(mockRouter.push).toHaveBeenCalledWith('/(public)/phone');
  } finally { mockAuth.me = null; }
});

test('an owner who is already registered signs in with the green button, with no plan chosen and nothing disabled', async () => {
  (api as jest.Mock).mockResolvedValue({ plans: PLANS });
  const ui = wrap(<Welcome />);
  expect(ui.getByText("I'm an owner · already registered")).toBeTruthy();
  expect(ui.getByTestId('cta-owner-registered').props.accessibilityState.disabled).toBe(false);
  expect(ui.queryByTestId('cta-signin')).toBeNull();
  await act(async () => { fireEvent.press(ui.getByTestId('cta-owner-registered')); });
  expect(getPendingRole()).toBe('owner');
  expect(getPendingPlan()).toBeNull();
  expect(mockRouter.push).toHaveBeenCalledWith('/(public)/phone');
});
