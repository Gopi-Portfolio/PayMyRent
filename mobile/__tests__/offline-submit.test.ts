import { ApiError } from '@/lib/api';
import { setOnline, isOnline, onReconnect } from '@/lib/network';
import { OutboxFullError, localId, outbox, startOfflineSync, submitOrQueue, syncNow } from '@/lib/offline';
import { clearOfflineData } from '@/lib/offlineData';
import { queryClient } from '@/lib/queryClient';
import { currentToast, hideToast } from '@/lib/toast';
import { api } from '@/lib/api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import '@/i18n';

jest.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number; code: string;
    constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
  }
  let n = 0;
  return { api: jest.fn(), ApiError, newIdempotencyKey: () => `key-${++n}-${Math.random().toString(36).slice(2, 10)}`, API_URL: 'http://api.test' };
});

const mockApi = api as jest.Mock;
const spec = (extra: Record<string, unknown> = {}) => ({ kind: 'note.create', label: 'Note: hello', path: '/api/v1/tenancies/t1/notes', body: { body: 'hello' }, ownerAccount: 'o1', ...extra });

beforeEach(async () => {
  mockApi.mockReset();
  setOnline(true);
  hideToast();
  await outbox.idle();                                                       // let the last test's writes to the phone finish before wiping it
  await outbox.setUser(null);
  await clearOfflineData('u1');                                              // a fresh phone for every test
  await outbox.setUser('u1');
});

test('online: the entry is sent at once with its own key, exactly as before, and nothing is saved for later', async () => {
  mockApi.mockResolvedValue({ id: 'n1' });
  const res = await submitOrQueue(spec());
  expect(res).toEqual({ queued: false, result: { id: 'n1' } });
  expect(mockApi).toHaveBeenCalledTimes(1);
  expect(mockApi.mock.calls[0][0]).toBe('/api/v1/tenancies/t1/notes');
  expect(mockApi.mock.calls[0][1]).toMatchObject({ body: { body: 'hello' }, ownerAccount: 'o1' });
  expect(mockApi.mock.calls[0][1].idempotencyKey).toMatch(/^key-/);
  expect(outbox.pendingCount()).toBe(0);
});

test('online but the server says no (a rule was broken): the person sees the refusal as before, and nothing is saved for later', async () => {
  mockApi.mockRejectedValue(new ApiError(409, 'UNIT_OCCUPIED', 'S-01 is already let'));
  await expect(submitOrQueue(spec())).rejects.toMatchObject({ code: 'UNIT_OCCUPIED', status: 409 });
  expect(outbox.getSnapshot()).toEqual([]);
  expect(isOnline()).toBe(true);                                             // a refusal is not a lost connection
});

test('offline: the entry is saved on the phone, nothing is sent, and the person is told it is saved', async () => {
  setOnline(false);
  const optimistic = jest.fn();
  const res = await submitOrQueue(spec({ optimistic }));
  expect(res.queued).toBe(true);
  expect(mockApi).not.toHaveBeenCalled();
  expect(outbox.getSnapshot()).toHaveLength(1);
  expect(outbox.getSnapshot()[0]).toMatchObject({ kind: 'note.create', path: '/api/v1/tenancies/t1/notes', status: 'pending', ownerAccount: 'o1' });
  expect(optimistic).toHaveBeenCalledWith(outbox.getSnapshot()[0]);          // the screens' data is updated at once
  expect(currentToast()).toBe('Saved on this phone. It will be sent when you\'re back online.');
});

test('the connection fails in the middle of sending: the entry is saved with the SAME key, so the server cannot do it twice', async () => {
  mockApi.mockRejectedValueOnce(new ApiError(0, 'TIMEOUT', 'no reply'));
  const res = await submitOrQueue(spec());
  expect(res.queued).toBe(true);
  expect(isOnline()).toBe(false);                                            // from now on the app behaves as offline
  const firstKey = mockApi.mock.calls[0][1].idempotencyKey;
  expect(outbox.getSnapshot()[0].idempotencyKey).toBe(firstKey);
  mockApi.mockResolvedValue({ id: 'n1' });
  await syncNow({ force: true });
  expect(mockApi.mock.calls[1][1].idempotencyKey).toBe(firstKey);            // the retry carries the key of the first try
  expect(outbox.getSnapshot()).toEqual([]);
});

test('both kinds of lost connection (cannot reach / no reply) are saved for later', async () => {
  for (const code of ['OFFLINE', 'TIMEOUT']) {
    setOnline(true); await outbox.idle(); await outbox.setUser(null); await clearOfflineData('u1'); await outbox.setUser('u1');
    mockApi.mockRejectedValueOnce(new ApiError(0, code, 'x'));
    expect((await submitOrQueue(spec())).queued).toBe(true);
  }
});

test('an entry that depends on one still waiting (a renter for a unit added offline) always waits behind it, even when the phone is online again', async () => {
  setOnline(false);
  const unit = await submitOrQueue({ kind: 'unit.create', label: 'unit', path: '/api/v1/owner/units', body: { identifier: 'S-9' }, ownerAccount: 'o1' });
  expect(unit.queued).toBe(true);
  const unitOp = (unit as any).item.id;
  setOnline(true);
  mockApi.mockImplementation(async (path: string) => (path === '/api/v1/owner/units' ? { id: 'real-unit-1' } : { tenancy_id: 'real-tenancy-1' }));
  const renter = await submitOrQueue({ kind: 'tenancy.create', label: 'renter', path: '/api/v1/owner/tenancies', body: { unit_id: localId(unitOp), tenant_name: 'RAVI' }, ownerAccount: 'o1' });
  expect(renter.queued).toBe(true);                                          // never sent straight away with a made-up unit id
  await new Promise((r) => setTimeout(r, 20));                               // the queue is sent right behind it
  await outbox.flush();
  const calls = mockApi.mock.calls.map((c) => [c[0], c[1].body]);
  expect(calls[0][0]).toBe('/api/v1/owner/units');
  expect(calls[1]).toEqual(['/api/v1/owner/tenancies', { unit_id: 'real-unit-1', tenant_name: 'RAVI' }]);
  expect(outbox.getSnapshot()).toEqual([]);
});

test('too many saved entries: the person gets a plain message, not a code', async () => {
  setOnline(false);
  for (let i = 0; i < 200; i++) await submitOrQueue(spec({ coalesceKey: undefined }));
  await expect(submitOrQueue(spec())).rejects.toThrow(/Too many saved changes/);
  expect(OutboxFullError).toBeDefined();
});

test('when something was sent, the screens\' data is fetched again; when nothing was sent, it is left alone', async () => {
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockImplementation(async () => undefined);
  setOnline(false);
  await submitOrQueue(spec());
  invalidate.mockClear();
  setOnline(true);
  mockApi.mockResolvedValue({ id: 'n1' });
  await syncNow();
  expect(invalidate).toHaveBeenCalledTimes(1);
  invalidate.mockClear();
  await syncNow();                                                           // nothing waiting
  expect(invalidate).not.toHaveBeenCalled();
  invalidate.mockRestore();
});

test('the moment the connection returns, what was saved is sent by itself', async () => {
  setOnline(false);
  await submitOrQueue(spec());
  mockApi.mockResolvedValue({ id: 'n1' });
  const stop = startOfflineSync();
  expect(mockApi).not.toHaveBeenCalled();                                    // still offline
  setOnline(true);                                                           // the phone says it is back
  await new Promise((r) => setTimeout(r, 30));
  expect(mockApi).toHaveBeenCalledTimes(1);
  expect(outbox.getSnapshot()).toEqual([]);
  stop();
});

test('connection watchers hear about a return to online, once', () => {
  setOnline(false);
  const heard = jest.fn();
  const off = onReconnect(heard);
  setOnline(true); setOnline(true);
  expect(heard).toHaveBeenCalledTimes(1);
  off();
  setOnline(false); setOnline(true);
  expect(heard).toHaveBeenCalledTimes(1);
});

test('signing out wipes the saved entries even if one was still being written to the phone at that moment', async () => {
  setOnline(false);
  await submitOrQueue(spec());                                               // NOT waited for: its write to the phone is still in flight
  await submitOrQueue(spec({ body: { body: 'second' } }));
  await clearOfflineData('u1');                                              // sign-out
  await new Promise((r) => setTimeout(r, 30));
  expect(await AsyncStorage.getItem('rg-outbox-v1-u1')).toBeNull();          // nothing came back after the wipe
  expect(outbox.getSnapshot()).toEqual([]);
  await outbox.setUser(null); await outbox.setUser('u1');
  expect(outbox.getSnapshot()).toEqual([]);                                  // and the next sign-in finds nothing
});
