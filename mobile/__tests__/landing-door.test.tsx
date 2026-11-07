import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import Index from '../app/index';
import { api } from '@/lib/api';
import { getPendingPlan, getPendingRole, markLandingSeen, setPendingPlan, setPendingRole } from '@/lib/landing';
import '@/i18n';

const mockRouter = { replace: jest.fn(), push: jest.fn() };
const mockAuth: any = {};
jest.mock('expo-router', () => ({ usePathname: () => '/', get router() { return mockRouter; }, Redirect: ({ href }: any) => { mockRouter.replace(`redirect:${href}`); return null; } }));
jest.mock('@/lib/api', () => ({ api: jest.fn(async () => ({})) }));
jest.mock('@/lib/auth', () => ({ useAuth: () => mockAuth }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

beforeEach(() => { mockRouter.replace.mockReset(); (api as jest.Mock).mockClear(); markLandingSeen(); Object.assign(mockAuth, { loading: false, authError: null, activeRole: null, refresh: jest.fn(), setActiveRole: jest.fn() }); });

test('a renter-only account using the Owner button is ASKED first, and nothing changes until it says yes', async () => {
  Object.assign(mockAuth, { me: { roles: ['tenant'], profile_complete: true, owner_accounts: [] } });
  setPendingRole('owner');
  const { getByTestId, getByText } = render(<Index />);
  getByText('Want to become an owner?');
  expect(api).not.toHaveBeenCalled();
  fireEvent.press(getByTestId('role-yes'));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/v1/me/roles', { body: { roles: ['owner'] } }));
  await waitFor(() => expect(mockAuth.setActiveRole).toHaveBeenCalledWith('owner'));   // owner cum renter, same number
  expect(mockAuth.refresh).toHaveBeenCalled();
  expect(getPendingRole()).toBeNull();                                                  // used once
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));            // then owner details and the plan follow
});

test('answering No keeps the account a renter: no role added, chosen plan forgotten', async () => {
  Object.assign(mockAuth, { me: { roles: ['tenant'], profile_complete: true, owner_accounts: [] } });
  setPendingRole('owner');
  setPendingPlan('growth');
  const { getByTestId } = render(<Index />);
  fireEvent.press(getByTestId('role-no'));
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
  expect(api).not.toHaveBeenCalled();
  expect(mockAuth.setActiveRole).not.toHaveBeenCalled();
  expect(getPendingPlan()).toBeNull();
});

test('an account that already has both roles but last used the renter view is switched to the owner view, with no role change', async () => {
  Object.assign(mockAuth, { me: { roles: ['owner', 'tenant'], profile_complete: true, owner_accounts: [] }, activeRole: 'tenant' });
  setPendingRole('owner');
  render(<Index />);
  await waitFor(() => expect(mockAuth.setActiveRole).toHaveBeenCalledWith('owner'));
  expect(api).not.toHaveBeenCalled();
});

test('the Renter button on an owner-only account asks, and Yes adds the renter view', async () => {
  Object.assign(mockAuth, { me: { roles: ['owner'], profile_complete: true, owner_accounts: [] } });
  setPendingRole('tenant');
  const { getByTestId } = render(<Index />);
  fireEvent.press(getByTestId('role-yes'));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/v1/me/roles', { body: { roles: ['tenant'] } }));
  await waitFor(() => expect(mockAuth.setActiveRole).toHaveBeenCalledWith('tenant'));
});

test('with no button used, nothing changes: the account goes where it always went', async () => {
  Object.assign(mockAuth, { me: { roles: ['tenant'], profile_complete: true, owner_accounts: [] } });
  setPendingRole(null);
  render(<Index />);
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('redirect:/(app)/tenant'));
  expect(api).not.toHaveBeenCalled();
});

test('a signed-in person never lands on the landing page; only someone signed out does', async () => {
  Object.assign(mockAuth, { me: { roles: ['owner'], profile_complete: true, owner_accounts: [{ verification: 'verified', state: 'active' }] } });
  render(<Index />);
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('redirect:/(app)/owner'));
  expect(mockRouter.replace).not.toHaveBeenCalledWith('redirect:/(public)/welcome');
  mockRouter.replace.mockReset();
  Object.assign(mockAuth, { me: null });
  render(<Index />);
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('redirect:/(public)/welcome'));
});
