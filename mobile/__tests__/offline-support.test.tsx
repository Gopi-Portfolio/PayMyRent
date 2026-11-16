import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import { act, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { isOnline, setOnline, startNetworkMonitor, useOnline } from '@/lib/network';
import { KEYS, clearOfflineData, registerCleaner, switchUser } from '@/lib/offlineData';
import { addPendingUnit, markUnitRented } from '@/lib/optimistic';
import { localId } from '@/lib/outbox';
import { CACHE_MAX_AGE, persister, queryClient, shouldSave } from '@/lib/queryClient';
import { currentToast, hideToast, showToast, useToast } from '@/lib/toast';
import { storage } from '@/lib/storage';

beforeEach(async () => { setOnline(true); await AsyncStorage.clear(); queryClient.clear(); hideToast(); });

describe('connection state', () => {
  test('one answer for the whole app, and react-query is told too (so saved screens stay quietly on screen while offline)', () => {
    setOnline(false);
    expect(isOnline()).toBe(false);
    expect(onlineManager.isOnline()).toBe(false);
    setOnline(true);
    expect(onlineManager.isOnline()).toBe(true);
  });

  test('screens that show the state redraw when it changes', () => {
    function Probe() { return <Text testID="state">{useOnline() ? 'online' : 'offline'}</Text>; }
    const ui = render(<Probe />);
    expect(ui.getByTestId('state').props.children).toBe('online');
    act(() => setOnline(false));
    expect(ui.getByTestId('state').props.children).toBe('offline');
    act(() => setOnline(true));
    expect(ui.getByTestId('state').props.children).toBe('online');
  });

  test('the phone\'s own connection reports are understood: no connection is offline at once; "internet not confirmed" is settled by asking our own server', async () => {
    const add = NetInfo.addEventListener as jest.Mock;
    add.mockClear();
    const realFetch = global.fetch;
    const stop = startNetworkMonitor();
    const report = add.mock.calls[0][0];
    report({ isConnected: false, isInternetReachable: false }); expect(isOnline()).toBe(false);
    report({ isConnected: true, isInternetReachable: null }); expect(isOnline()).toBe(true);          // not sure yet: do not assume offline
    // connected, but the phone could not confirm the internet: our server answers, so the app stays online (no false "no internet" banner)
    global.fetch = jest.fn(async () => ({ ok: true })) as any;
    report({ isConnected: true, isInternetReachable: false });
    for (let i = 0; i < 20; i++) await Promise.resolve(); expect(isOnline()).toBe(true);
    // ...and when our server does not answer either, it is offline
    global.fetch = jest.fn(async () => { throw new Error('unreachable'); }) as any;
    report({ isConnected: true, isInternetReachable: false });
    for (let i = 0; i < 20; i++) await Promise.resolve(); expect(isOnline()).toBe(false);
    report({ isConnected: true, isInternetReachable: true }); expect(isOnline()).toBe(true);
    global.fetch = realFetch;
    stop();
  });
});

describe('saved data belongs to one person', () => {
  test('the first person on the phone is just remembered; the same person again changes nothing', async () => {
    expect(await switchUser('alice')).toBe(false);
    await storage.setJson(KEYS.outbox('alice'), { v: 1, items: [{ id: 'x' }], idMap: {} });
    expect(await switchUser('alice')).toBe(false);
    expect(await storage.getJson(KEYS.outbox('alice'))).not.toBeNull();
  });

  test('a different person signing in removes the previous person\'s saved profile, cache and waiting entries first', async () => {
    await switchUser('alice');
    await storage.setJson(KEYS.me, { id: 'alice', full_name: 'Alice' });
    await storage.setJson(KEYS.queryCache, { clientState: 'alice data' });
    await storage.setJson(KEYS.outbox('alice'), { v: 1, items: [{ id: 'x' }], idMap: {} });
    expect(await switchUser('bob')).toBe(true);                               // told the caller so it can clear the screens too
    expect(await storage.getJson(KEYS.me)).toBeNull();
    expect(await storage.getJson(KEYS.queryCache)).toBeNull();
    expect(await storage.getJson(KEYS.outbox('alice'))).toBeNull();
    expect(await storage.getJson<string>(KEYS.lastUser)).toBe('bob');
  });

  test('signing out removes everything kept for offline use, even when one part fails to clean up', async () => {
    await switchUser('alice');
    await storage.setJson(KEYS.me, { id: 'alice' }); await storage.setJson(KEYS.queryCache, { a: 1 }); await storage.setJson(KEYS.outbox('alice'), { v: 1, items: [], idMap: {} });
    const ran = jest.fn();
    const off1 = registerCleaner(() => { throw new Error('this one breaks'); });
    const off2 = registerCleaner(ran);
    await clearOfflineData();                                                 // no id given: it finds who was last signed in
    expect(ran).toHaveBeenCalled();
    for (const k of [KEYS.me, KEYS.queryCache, KEYS.lastUser, KEYS.outbox('alice')]) expect(await AsyncStorage.getItem(k)).toBeNull();
    off1(); off2();
  });
});

describe('what the screens show right after an entry is saved for later', () => {
  const units = () => ({ items: [
    { id: 'u1', property_id: 'p1', identifier: 'S-01', vacant: true, tenancy_id: null, tenant_name: null },
    { id: 'u2', property_id: 'p1', identifier: 'S-02', vacant: true, tenancy_id: null, tenant_name: null },
  ] });
  beforeEach(() => { queryClient.setQueryData(['units', 'o1', 'active'], units()); queryClient.setQueryData(['vacant', 'o1'], units()); });
  const get = (key: unknown[]) => (queryClient.getQueryData(key) as any).items;

  test('a renter added offline: the unit shows as rented to them, waiting to send, and is no longer offered as vacant', () => {
    markUnitRented('o1', 'u1', 'RAVI KUMAR', 'op1');
    expect(get(['units', 'o1', 'active'])[0]).toMatchObject({ id: 'u1', vacant: false, tenancy_id: localId('op1'), tenant_name: 'RAVI KUMAR', pending: true });
    expect(get(['units', 'o1', 'active'])[1]).toMatchObject({ id: 'u2', vacant: true });       // the other unit is untouched
    expect(get(['vacant', 'o1']).map((u: any) => u.id)).toEqual(['u2']);                        // and cannot be given to a second renter by mistake
  });

  test('a unit added offline can be chosen at once, with an id that stands for it until the server gives the real one', () => {
    addPendingUnit('o1', 'op2', { property_id: 'p1', identifier: 'S-03', kind: 'commercial', floor: null });
    const added = get(['units', 'o1', 'active']).find((u: any) => u.identifier === 'S-03');
    expect(added).toMatchObject({ id: localId('op2'), vacant: true, pending: true, property_id: 'p1' });
    expect(get(['vacant', 'o1']).some((u: any) => u.identifier === 'S-03')).toBe(true);
  });

  test('a screen whose data was never loaded, or belongs to another owner, is left alone', () => {
    queryClient.clear();
    expect(() => markUnitRented('o1', 'u1', 'X', 'op')).not.toThrow();
    expect(queryClient.getQueryData(['units', 'o1', 'active'])).toBeUndefined();
    queryClient.setQueryData(['units', 'o2', 'active'], units());
    markUnitRented('o1', 'u1', 'X', 'op');
    expect(get(['units', 'o2', 'active'])[0].vacant).toBe(true);
  });
});

describe('the message at the bottom of the screen', () => {
  jest.useFakeTimers();
  test('shows for a few seconds and goes away by itself; a new message replaces the old one', () => {
    function Probe() { return <Text testID="t">{useToast() ?? 'none'}</Text>; }
    const ui = render(<Probe />);
    expect(ui.getByTestId('t').props.children).toBe('none');
    act(() => showToast('first', 1000));
    expect(ui.getByTestId('t').props.children).toBe('first');
    act(() => { jest.advanceTimersByTime(600); showToast('second', 1000); });
    act(() => { jest.advanceTimersByTime(600); });                            // 1200 ms since the first: its timer must not hide the second
    expect(currentToast()).toBe('second');
    act(() => { jest.advanceTimersByTime(500); });
    expect(currentToast()).toBeNull();
  });
});

describe('what is kept on the phone for offline use', () => {
  test('only successful answers are saved, and never an answer about another person (is this number\'s ID verified?)', () => {
    const q = (key: unknown[], status: string) => ({ queryKey: key, state: { status } });
    expect(shouldSave(q(['units', 'o1'], 'success'))).toBe(true);
    expect(shouldSave(q(['units', 'o1'], 'error'))).toBe(false);
    expect(shouldSave(q(['units', 'o1'], 'pending'))).toBe(false);
    expect(shouldSave(q(['renter-check', '9876543210'], 'success'))).toBe(false);
  });

  test('saved screens are kept for a day, and the saved copy is removed when someone signs out', async () => {
    expect(CACHE_MAX_AGE).toBe(24 * 3600 * 1000);
    expect(queryClient.getDefaultOptions().queries?.gcTime).toBe(CACHE_MAX_AGE);   // in memory at least as long as it is kept on the phone
    await AsyncStorage.setItem(KEYS.queryCache, '{"x":1}');
    await persister.removeClient();
    expect(await AsyncStorage.getItem(KEYS.queryCache)).toBeNull();
  });
});
