import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { AuthProvider, useAuth } from '@/lib/auth';
import { isOnline, setOnline } from '@/lib/network';
import { KEYS } from '@/lib/offlineData';
import { queryClient } from '@/lib/queryClient';
import { storage } from '@/lib/storage';
import { api } from '@/lib/api';
import '@/i18n';

const mockSecure = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockSecure.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockSecure.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockSecure.delete(k); }),
}));
jest.mock('@/lib/push', () => ({ registerPush: jest.fn(), unregisterPush: jest.fn(async () => undefined) }));
jest.mock('@/lib/api', () => {
  class ApiError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } }
  return { api: jest.fn(), ApiError, newIdempotencyKey: () => 'key-1234567890', API_URL: 'http://api.test' };
});

const mockApi = api as jest.Mock;
const ME = { id: 'u-ravi', full_name: 'RAVI', address: null, preferred_language: 'en', profile_complete: true, version: 3, roles: ['owner'], contacts: [], notification_preferences: null,
             owner_accounts: [{ owner_account_id: 'o1', role: 'owner', state: 'active', verification: 'verified' }], pending_invitations: 0, action_codes_required: true, identity_status: 'verified' };
const netError = (code = 'OFFLINE') => new (require('@/lib/api').ApiError)(0, code, 'cannot reach the server');

let auth: ReturnType<typeof useAuth>;
function Probe() {
  auth = useAuth();
  return <Text testID="status">{auth.loading ? 'loading' : auth.me ? `signed-in:${auth.me.id}` : auth.authError ? 'error' : 'signed-out'}</Text>;
}
const open = () => render(<AuthProvider><Probe /></AuthProvider>);
const status = (ui: ReturnType<typeof render>) => ui.getByTestId('status').props.children;

beforeEach(async () => {
  mockApi.mockReset(); mockSecure.clear(); await AsyncStorage.clear(); queryClient.clear(); setOnline(true);
  mockSecure.set('rg.devToken', 'dev-token');                                    // someone is signed in on this phone
});

test('online: the app opens as the signed-in person, and keeps their profile on the phone for next time', async () => {
  mockApi.mockResolvedValue(ME);
  const ui = open();
  await waitFor(() => expect(status(ui)).toBe('signed-in:u-ravi'));
  await waitFor(async () => expect(await storage.getJson(KEYS.me)).toMatchObject({ id: 'u-ravi', full_name: 'RAVI' }));
  expect(await storage.getJson<string>(KEYS.lastUser)).toBe('u-ravi');
});

test('OPENED WITH NO NETWORK: the person who was signed in last time is still signed in, using the saved profile; the app does not drop to the login screen', async () => {
  await storage.setJson(KEYS.me, ME);
  mockApi.mockRejectedValue(netError());
  const ui = open();
  await waitFor(() => expect(status(ui)).toBe('signed-in:u-ravi'));
  expect(auth.authError).toBeNull();
  expect(auth.activeRole).toBe('owner');
  expect(isOnline()).toBe(false);                                            // and the app knows it is offline, so it saves entries for later
});

test('a connection that hangs (no reply) is treated the same as no connection', async () => {
  await storage.setJson(KEYS.me, ME);
  mockApi.mockRejectedValue(netError('TIMEOUT'));
  const ui = open();
  await waitFor(() => expect(status(ui)).toBe('signed-in:u-ravi'));
});

test('no network and nothing saved yet (the very first start): the person sees the network problem, as before', async () => {
  mockApi.mockRejectedValue(netError());
  const ui = open();
  await waitFor(() => expect(status(ui)).toBe('error'));
  expect(auth.me).toBeNull();
});

test('SECURITY: when the server answers that the sign-in is no longer valid (401), the saved profile is NOT used', async () => {
  await storage.setJson(KEYS.me, ME);
  mockApi.mockRejectedValue(new (require('@/lib/api').ApiError)(401, 'UNAUTHENTICATED', 'sign in again'));
  const ui = open();
  await waitFor(() => expect(status(ui)).toBe('signed-out'));
  expect(auth.me).toBeNull();
});

test('nobody signed in on this phone: no saved profile is ever used, even if one was left behind', async () => {
  mockApi.mockResolvedValue(ME);
  const first = open();
  await waitFor(() => expect(status(first)).toBe('signed-in:u-ravi'));
  await act(async () => { await auth.signOut(); });                          // really signed out: no token anywhere
  first.unmount();
  await storage.setJson(KEYS.me, ME);                                        // a profile somehow left behind
  mockApi.mockRejectedValue(netError());
  const ui = open();
  await waitFor(() => expect(status(ui)).not.toBe('loading'));
  expect(auth.me).toBeNull();
});

test('signing out removes the saved profile, the saved screens and every waiting entry from the phone', async () => {
  mockApi.mockResolvedValue(ME);
  const ui = open();
  await waitFor(() => expect(status(ui)).toBe('signed-in:u-ravi'));
  await waitFor(async () => expect(await storage.getJson(KEYS.me)).not.toBeNull());
  await storage.setJson(KEYS.outbox('u-ravi'), { v: 1, items: [{ id: 'x' }], idMap: {} });
  await storage.setJson(KEYS.queryCache, { clientState: 'ravi data' });
  await act(async () => { await auth.signOut(); });
  expect(status(ui)).toBe('signed-out');
  for (const k of [KEYS.me, KEYS.lastUser, KEYS.queryCache, KEYS.outbox('u-ravi')]) expect(await AsyncStorage.getItem(k)).toBeNull();
});

test('a different person signing in on the same phone never inherits the previous person\'s saved data', async () => {
  await storage.setJson(KEYS.lastUser, 'u-someone-else');
  await storage.setJson(KEYS.outbox('u-someone-else'), { v: 1, items: [{ id: 'theirs' }], idMap: {} });
  queryClient.setQueryData(['units', 'o9', 'active'], { items: [{ id: 'their-unit' }] });
  mockApi.mockResolvedValue(ME);
  const ui = open();
  await waitFor(() => expect(status(ui)).toBe('signed-in:u-ravi'));
  await waitFor(async () => expect(await AsyncStorage.getItem(KEYS.outbox('u-someone-else'))).toBeNull());
  expect(queryClient.getQueryData(['units', 'o9', 'active'])).toBeUndefined();
  expect(await storage.getJson<string>(KEYS.lastUser)).toBe('u-ravi');
});
