import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { Alert } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import SavedChanges from '../app/sync';
import { OfflineBanner } from '@/components/OfflineBanner';
import { setOnline } from '@/lib/network';
import { clearOfflineData } from '@/lib/offlineData';
import { outbox } from '@/lib/offline';
import { queryClient } from '@/lib/queryClient';
import { api } from '@/lib/api';
import '@/i18n';

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ router: { push: (...a: any[]) => mockRouter.push(...a), back: () => mockRouter.back(), replace: () => mockRouter.replace(), canGoBack: () => true }, usePathname: () => '/sync' }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/lib/api', () => {
  class ApiError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } }
  return { api: jest.fn(), ApiError, newIdempotencyKey: () => 'key-' + Math.random().toString(36).slice(2, 14), API_URL: 'http://api.test' };
});
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native');
  return { Screen: ({ children }: any) => R.createElement(RN.View, null, children) };
});
const mockApi = api as jest.Mock;
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={queryClient}><PaperProvider>{ui}</PaperProvider></QueryClientProvider>);
const add = (label: string, over: Record<string, unknown> = {}) => outbox.enqueue({ kind: 'note.create', label, path: '/api/v1/x', body: { a: 1 }, ...over });

beforeEach(async () => {
  mockApi.mockReset(); mockRouter.push.mockReset();
  setOnline(true);
  await outbox.idle(); await outbox.setUser(null); await clearOfflineData('u1'); await outbox.setUser('u1');
});

describe('the banner under the top bar', () => {
  test('online with nothing waiting: it takes no room at all', () => {
    const ui = wrap(<OfflineBanner />);
    expect(ui.queryByTestId('offline-banner')).toBeNull();
  });

  test('offline: it says so, in words anyone can follow', () => {
    setOnline(false);
    const ui = wrap(<OfflineBanner />);
    expect(ui.getByText("You're offline. What you enter is saved on this phone and sent when you're back online.")).toBeTruthy();
  });

  test('offline with entries waiting: it also says how many', () => {
    setOnline(false);
    add('one'); add('two');
    const ui = wrap(<OfflineBanner />);
    expect(ui.getByText(/2 saved changes are waiting to be sent/)).toBeTruthy();
  });

  test('one waiting entry reads as a singular', () => {
    setOnline(false);
    add('one');
    expect(wrap(<OfflineBanner />).getByText(/1 saved change is waiting to be sent/)).toBeTruthy();
  });

  test('online but something was refused by the server: it asks for attention', async () => {
    mockApi.mockRejectedValue(Object.assign(new Error('unit taken'), { status: 409, code: 'UNIT_OCCUPIED' }));
    add('renter');
    await act(async () => { await outbox.flush(); });
    const ui = wrap(<OfflineBanner />);
    expect(ui.getByText('1 saved change needs your attention')).toBeTruthy();
  });

  test('online with entries that are being sent: it says they are being sent', async () => {
    let release: (v: unknown) => void = () => undefined;
    mockApi.mockImplementation(() => new Promise((r) => { release = r; }));
    add('renter');
    const ui = wrap(<OfflineBanner />);
    let flushed: Promise<unknown> = Promise.resolve();
    act(() => { flushed = outbox.flush(); });
    expect(ui.getByText('Sending your saved changes…')).toBeTruthy();
    await act(async () => { release({ id: 'ok' }); await flushed; });
    expect(ui.queryByTestId('offline-banner')).toBeNull();                    // sent: the banner goes away by itself
  });

  test('signed out while entries were waiting: it asks the person to sign in again, and nothing is lost', async () => {
    mockApi.mockRejectedValue(Object.assign(new Error('expired'), { status: 401, code: 'UNAUTHENTICATED' }));
    add('renter');
    await act(async () => { await outbox.flush(); });
    const ui = wrap(<OfflineBanner />);
    expect(ui.getByText('Please sign in again to send your saved changes.')).toBeTruthy();
    expect(outbox.pendingCount()).toBe(1);
  });

  test('a tap opens the list of saved changes', () => {
    setOnline(false);
    const ui = wrap(<OfflineBanner />);
    fireEvent.press(ui.getByTestId('offline-banner'));
    expect(mockRouter.push).toHaveBeenCalledWith('/sync');
  });
});

describe('the Saved Changes screen', () => {
  test('nothing waiting: a calm message', () => {
    const ui = wrap(<SavedChanges />);
    expect(ui.getByTestId('sync-empty')).toBeTruthy();
    expect(ui.getByText('Nothing is waiting. Everything has been sent.')).toBeTruthy();
    expect(ui.queryByTestId('send-now')).toBeNull();
  });

  test('each entry shows what it is, when it was saved and that it is waiting', () => {
    setOnline(false);
    const a = add('Add renter RAVI to S-01');
    const ui = wrap(<SavedChanges />);
    expect(ui.getByText('Add renter RAVI to S-01')).toBeTruthy();
    expect(ui.getByTestId(`saved-${a.id}`)).toBeTruthy();
    expect(ui.getByText(/Waiting to send/)).toBeTruthy();
  });

  test('"Send Now" sends what is waiting, even if the phone thinks it is offline, and the list empties', async () => {
    setOnline(false);
    mockApi.mockResolvedValue({ id: 'ok' });
    add('one'); add('two');
    const ui = wrap(<SavedChanges />);
    await act(async () => { fireEvent.press(ui.getByTestId('send-now')); });
    await waitFor(() => expect(ui.getByTestId('sync-empty')).toBeTruthy());
    expect(mockApi).toHaveBeenCalledTimes(2);
  });

  test('an entry the server refused shows the reason in plain words, with Try Again and Discard', async () => {
    mockApi.mockRejectedValue(Object.assign(new Error('S-01 is already let'), { status: 409, code: 'UNIT_OCCUPIED' }));
    const a = add('Add renter RAVI to S-01');
    await act(async () => { await outbox.flush(); });
    const ui = wrap(<SavedChanges />);
    expect(ui.getByText(/Not accepted/)).toBeTruthy();
    expect(ui.getByTestId(`why-${a.id}`)).toBeTruthy();
    expect(ui.getByTestId(`retry-${a.id}`)).toBeTruthy();
    expect(ui.getByTestId(`discard-${a.id}`)).toBeTruthy();
  });

  test('"Try Again" sends the entry once more, and this time it can go through', async () => {
    mockApi.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 409, code: 'CONFLICT' })).mockResolvedValue({ id: 'ok' });
    const a = add('renter');
    await act(async () => { await outbox.flush(); });
    const ui = wrap(<SavedChanges />);
    await act(async () => { fireEvent.press(ui.getByTestId(`retry-${a.id}`)); });
    await waitFor(() => expect(ui.getByTestId('sync-empty')).toBeTruthy());
  });

  test('"Discard" asks first, and only removes the entry when the person confirms', async () => {
    setOnline(false);
    const a = add('renter');
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const ui = wrap(<SavedChanges />);
    fireEvent.press(ui.getByTestId(`discard-${a.id}`));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toBe('Discard this change?');
    expect(outbox.pendingCount()).toBe(1);                                    // nothing happens until they say yes
    const buttons = alert.mock.calls[0][2] as any[];
    act(() => buttons.find((b) => b.text === 'Discard').onPress());
    expect(outbox.pendingCount()).toBe(0);
    alert.mockRestore();
  });

  test('a dependent entry whose parent was refused explains why in the person\'s language, not as a code', async () => {
    mockApi.mockRejectedValue(Object.assign(new Error('unit exists'), { status: 409, code: 'CONFLICT' }));
    const unit = outbox.enqueue({ id: 'parent', kind: 'unit.create', label: 'unit', path: '/api/v1/owner/units', body: {} });
    const renter = outbox.enqueue({ kind: 'tenancy.create', label: 'renter', path: '/api/v1/owner/tenancies', body: { unit_id: 'local-' + unit.id } });
    await act(async () => { await outbox.flush(); });
    const ui = wrap(<SavedChanges />);
    expect(ui.getByTestId(`why-${renter.id}`).props.children).toBe('The change this one depended on needs attention first.');
  });
});
