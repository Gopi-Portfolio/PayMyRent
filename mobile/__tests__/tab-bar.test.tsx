import { render } from '@testing-library/react-native';
import React from 'react';

import AppLayout from '../app/(app)/_layout';
import '@/i18n';

// the tab screens the layout asks for, with the options each one was given
const screens: Record<string, any> = {};
let barOptions: any = {};
let mockInsets = { top: 0, bottom: 34, left: 0, right: 0 };
jest.mock('expo-router', () => {
  const R = require('react');
  const Tabs: any = ({ children, screenOptions }: any) => { barOptions = screenOptions; return R.createElement(R.Fragment, null, children); };
  Tabs.Screen = ({ name, options }: any) => { screens[name] = options; return null; };
  return { Tabs, Redirect: () => null };
});
const mockAuth: any = {};
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => mockInsets }));
jest.mock('@/lib/auth', () => ({ useAuth: () => mockAuth }));
jest.mock('@/components/PayTab', () => ({ PayTabButton: () => null }));

// a tab is hidden by href: null, or by a custom button that draws nothing (the Pay tab has its own button, and expo-router refuses href together with tabBarButton)
const shown = (name: string) => !!screens[name] && screens[name].href !== null && !(screens[name].tabBarButton && screens[name].tabBarButton() === null);

test('an owner sees Owner, Search and Profile, and no Pay tab', () => {
  Object.assign(mockAuth, { me: { roles: ['owner'] }, activeRole: 'owner' });
  render(<AppLayout />);
  expect(shown('owner')).toBe(true);
  expect(shown('search')).toBe(true);
  expect(shown('profile/index')).toBe(true);
  expect(shown('pay-tab')).toBe(false);
  expect(shown('tenant')).toBe(false);
});

test('a renter sees their rentals, the Pay tab and Profile, and no Search', () => {
  Object.assign(mockAuth, { me: { roles: ['tenant'] }, activeRole: 'tenant' });
  render(<AppLayout />);
  expect(shown('tenant')).toBe(true);
  expect(shown('pay-tab')).toBe(true);
  expect(shown('profile/index')).toBe(true);
  expect(shown('search')).toBe(false);
  expect(shown('owner')).toBe(false);
});

test('every tab icon is drawn in the same colour', () => {
  Object.assign(mockAuth, { me: { roles: ['owner'] }, activeRole: 'owner' });
  render(<AppLayout />);
  const colours = ['owner', 'search', 'profile/index'].map((n) => JSON.stringify(screens[n].tabBarIcon().props.color));
  expect(new Set(colours).size).toBe(1);
});

test('no tab is given both href and tabBarButton: expo-router throws "Cannot use href and tabBarButton together" and the app crashes', () => {
  for (const role of ['owner', 'tenant'] as const) {
    Object.assign(mockAuth, { me: { roles: [role] }, activeRole: role });
    render(<AppLayout />);
    for (const [name, options] of Object.entries(screens)) expect([name, options.href !== undefined && options.tabBarButton !== undefined]).toEqual([name, false]);
  }
});

test('the bar leaves the phone\'s home-indicator space under the labels instead of replacing it with a fixed number', () => {
  Object.assign(mockAuth, { me: { roles: ['owner'] }, activeRole: 'owner' });
  for (const bottom of [34, 21, 0]) {
    mockInsets = { top: 0, bottom, left: 0, right: 0 };
    render(<AppLayout />);
    const space = Math.max(bottom, 8);
    expect(barOptions.tabBarStyle.paddingBottom).toBe(space);                       // the same room the phone asks for, never less
    expect(barOptions.tabBarStyle.height).toBe(56 + space);                         // so the icons and labels always sit in the same 56 points above it
  }
});
