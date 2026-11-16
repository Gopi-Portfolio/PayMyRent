import { render } from '@testing-library/react-native';
import React from 'react';

import AppLayout from '../app/(app)/_layout';
import '@/i18n';

// the tab screens the layout asks for, with the options each one was given
const screens: Record<string, any> = {};
jest.mock('expo-router', () => {
  const R = require('react');
  const Tabs: any = ({ children }: any) => R.createElement(R.Fragment, null, children);
  Tabs.Screen = ({ name, options }: any) => { screens[name] = options; return null; };
  return { Tabs, Redirect: () => null };
});
const mockAuth: any = {};
jest.mock('@/lib/auth', () => ({ useAuth: () => mockAuth }));
jest.mock('@/components/PayTab', () => ({ PayTabButton: () => null }));

const shown = (name: string) => screens[name] && screens[name].href !== null;      // expo-router hides a tab whose href is null

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
