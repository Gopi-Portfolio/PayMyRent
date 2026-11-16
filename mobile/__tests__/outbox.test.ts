import { MAX_AGE_MS, MAX_ITEMS, Outbox, OutboxFullError, localId, type OutboxItem } from '@/lib/outbox';
import type { KeyValue } from '@/lib/storage';

// ---- a phone with durable storage, and a server that remembers idempotency keys, loses replies and refuses things, like the real one ----
class MemoryStorage implements KeyValue {
  data = new Map<string, string>();
  async getJson<T>(k: string) { const v = this.data.get(k); try { return v ? (JSON.parse(v) as T) : null; } catch { return null; } }
  async setJson(k: string, v: unknown) { this.data.set(k, JSON.stringify(v)); }
  async remove(k: string) { this.data.delete(k); }
}
const apiError = (status: number, code = 'ERROR', message = 'refused') => Object.assign(new Error(message), { status, code });

type Plan = 'ok' | 'lose-request' | 'lose-reply' | { status: number; code?: string; message?: string };
class FakeServer {
  stored = new Map<string, unknown>();                 // idempotency key -> reply
  created: { kind: string; path: string; body: any }[] = [];
  calls: { path: string; key: string; body: any }[] = [];
  plans: Plan[] = [];                                  // what happens to the next calls, in order; 'ok' when empty
  take(): Plan { return this.plans.shift() ?? 'ok'; }
  async handle(item: OutboxItem): Promise<unknown> {
    this.calls.push({ path: item.path, key: item.idempotencyKey, body: item.body });
    const plan = this.take();
    if (plan === 'lose-request') throw apiError(0, 'OFFLINE', 'cannot reach the server');          // never arrived
    if (typeof plan === 'object') throw apiError(plan.status, plan.code, plan.message);
    if (this.stored.has(item.idempotencyKey)) return this.stored.get(item.idempotencyKey);         // seen before: the same reply, nothing done again
    const n = this.created.length + 1;
    this.created.push({ kind: item.kind, path: item.path, body: item.body });
    const reply = item.kind === 'tenancy.create' ? { tenancy_id: `tenancy-${n}` } : { id: `${item.kind}-${n}` };
    this.stored.set(item.idempotencyKey, reply);
    if (plan === 'lose-reply') throw apiError(0, 'TIMEOUT', 'no reply');                            // done on the server, but the phone never heard
    return reply;
  }
}

let counter = 0;
function env(over: { online?: boolean } = {}) {
  const storage = new MemoryStorage();
  const server = new FakeServer();
  const state = { online: over.online ?? true, time: 1_700_000_000_000, synced: [] as string[], signIn: 0 };
  const make = () => new Outbox({
    storage, keyFor: (u) => `outbox-${u}`, send: (i) => server.handle(i), isOnline: () => state.online, newId: () => `id${++counter}`, now: () => state.time,
    onSynced: (i) => state.synced.push(i.id), onNeedsSignIn: () => { state.signIn++; },
  });
  return { storage, server, state, make, box: make() };
}
const entry = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, label: kind, path: `/api/${kind}`, body: { name: kind, ...extra }, ownerAccount: 'o1' });

test('an entry is saved on the phone at once and is still there after the app is closed and opened again', async () => {
  const { box, make } = env({ online: false });
  await box.setUser('u1');
  const a = box.enqueue(entry('tenancy.create'));
  await box.idle();
  const reopened = make();                                                    // a brand new app process reading the same storage
  await reopened.setUser('u1');
  expect(reopened.getSnapshot().map((i) => i.id)).toEqual([a.id]);
  expect(reopened.getSnapshot()[0]).toMatchObject({ kind: 'tenancy.create', status: 'pending', ownerAccount: 'o1' });
});

test('saved entries are sent oldest first, each with its own key, and removed once the server has taken them', async () => {
  const { box, server, state } = env();
  await box.setUser('u1');
  const a = box.enqueue(entry('unit.create', { n: 1 })), b = box.enqueue(entry('note.create', { n: 2 })), c = box.enqueue(entry('charge.create', { n: 3 }));
  const res = await box.flush();
  expect(res).toEqual({ sent: 3, failed: 0, remaining: 0, stopped: null });
  expect(server.calls.map((x) => x.path)).toEqual(['/api/unit.create', '/api/note.create', '/api/charge.create']);
  expect(new Set(server.calls.map((x) => x.key)).size).toBe(3);
  expect(box.getSnapshot()).toEqual([]);
  expect(state.synced).toEqual([a.id, b.id, c.id]);
});

test('while the phone is offline nothing is sent and nothing is lost', async () => {
  const { box, server, state } = env({ online: false });
  await box.setUser('u1');
  box.enqueue(entry('note.create'));
  expect(await box.flush()).toMatchObject({ sent: 0, remaining: 1, stopped: 'offline' });
  expect(server.calls).toHaveLength(0);
  state.online = true;
  expect(await box.flush()).toMatchObject({ sent: 1, remaining: 0, stopped: null });
});

test('the connection drops half way: what was sent stays sent, the rest keeps waiting and goes on next time', async () => {
  const { box, server } = env();
  await box.setUser('u1');
  box.enqueue(entry('unit.create')); box.enqueue(entry('note.create')); box.enqueue(entry('charge.create'));
  server.plans = ['ok', 'lose-request'];
  const first = await box.flush();
  expect(first).toMatchObject({ sent: 1, remaining: 2, stopped: 'offline' });
  expect(server.calls).toHaveLength(2);                                       // the third was not even tried
  const second = await box.flush();
  expect(second).toMatchObject({ sent: 2, remaining: 0 });
  expect(server.created.map((c) => c.kind)).toEqual(['unit.create', 'note.create', 'charge.create']);
});

test('THE LOST REPLY: the server did the work but the phone never heard; sending again with the same key does it only once', async () => {
  const { box, server } = env();
  await box.setUser('u1');
  const a = box.enqueue(entry('tenancy.create'));
  server.plans = ['lose-reply'];
  expect(await box.flush()).toMatchObject({ sent: 0, remaining: 1, stopped: 'offline' });
  expect(server.created).toHaveLength(1);                                     // already done on the server
  expect(await box.flush()).toMatchObject({ sent: 1, remaining: 0 });
  expect(server.created).toHaveLength(1);                                     // and NOT done a second time
  expect(server.calls.map((c) => c.key)).toEqual([a.idempotencyKey, a.idempotencyKey]);
});

test('the app is closed right after the server accepted an entry but before the phone noted it: the next start sends it again safely', async () => {
  const { box, server, storage, make } = env();
  await box.setUser('u1');
  const a = box.enqueue(entry('tenancy.create'));
  await box.idle();
  await server.handle(a);                                                     // the server took it, then the app died before removing it
  const restarted = make();
  await restarted.setUser('u1');
  expect(restarted.pendingCount()).toBe(1);
  await restarted.flush();
  expect(server.created).toHaveLength(1);
  expect(restarted.getSnapshot()).toEqual([]);
  expect([...storage.data.keys()]).toEqual(['outbox-u1']);
});

test('a refusal from the server marks only that entry "needs attention" and the others still go', async () => {
  const { box, server } = env();
  await box.setUser('u1');
  box.enqueue(entry('tenancy.create')); box.enqueue(entry('note.create'));
  server.plans = [{ status: 409, code: 'UNIT_OCCUPIED', message: 'S-01 is already let' }];
  expect(await box.flush()).toMatchObject({ sent: 1, failed: 1, remaining: 0 });
  const [bad] = box.getSnapshot();
  expect(bad).toMatchObject({ kind: 'tenancy.create', status: 'failed', error: { code: 'UNIT_OCCUPIED', message: 'S-01 is already let', status: 409 } });
  expect(box.failedCount()).toBe(1);
  expect(box.pendingCount()).toBe(0);
});

test('every 4xx refusal is shown to the person, not retried forever', async () => {
  for (const status of [400, 403, 404, 409, 422]) {
    const { box, server } = env();
    await box.setUser('u1');
    box.enqueue(entry('note.create'));
    server.plans = [{ status }];
    await box.flush();
    expect(box.getSnapshot()[0]).toMatchObject({ status: 'failed', error: { status } });
    const calls = server.calls.length;
    await box.flush();
    expect(server.calls.length).toBe(calls);                                  // not tried again by itself
  }
});

test('"Try again" puts a refused entry back in the queue, and "Discard" removes it', async () => {
  const { box, server } = env();
  await box.setUser('u1');
  const a = box.enqueue(entry('tenancy.create')), b = box.enqueue(entry('note.create'));
  server.plans = [{ status: 409 }, { status: 422 }];
  await box.flush();
  expect(box.failedCount()).toBe(2);
  box.retry(a.id);
  expect(box.getSnapshot().find((i) => i.id === a.id)).toMatchObject({ status: 'pending', error: undefined });
  await box.flush();                                                          // this time the server says yes
  expect(box.getSnapshot().map((i) => i.id)).toEqual([b.id]);
  box.discard(b.id);
  expect(box.getSnapshot()).toEqual([]);
  box.retry('nope'); box.discard('nope');                                     // unknown ids are ignored
});

test('being signed out (401) stops sending, keeps everything, and asks the app to sign in again', async () => {
  const { box, server, state } = env();
  await box.setUser('u1');
  box.enqueue(entry('note.create')); box.enqueue(entry('charge.create'));
  server.plans = [{ status: 401, code: 'UNAUTHENTICATED' }];
  expect(await box.flush()).toMatchObject({ sent: 0, remaining: 2, stopped: 'auth' });
  expect(state.signIn).toBe(1);
  expect(box.failedCount()).toBe(0);                                          // nothing was refused, so nothing is "failed"
  expect(await box.flush()).toMatchObject({ sent: 2 });
});

test('a busy or unwell server (5xx, 429) is waited out with growing pauses, not hammered', async () => {
  const { box, server, state } = env();
  await box.setUser('u1');
  box.enqueue(entry('note.create'));
  server.plans = [{ status: 503 }, { status: 503 }];
  expect(await box.flush()).toMatchObject({ sent: 0, remaining: 1, stopped: 'server' });
  const waits: number[] = [];
  waits.push(box.getSnapshot()[0].nextAttemptAt! - state.time);
  expect(await box.flush()).toMatchObject({ sent: 0 });                       // too soon: not even tried
  expect(server.calls).toHaveLength(1);
  state.time += waits[0] + 1;
  await box.flush();                                                          // second failure: a longer pause
  waits.push(box.getSnapshot()[0].nextAttemptAt! - state.time);
  expect(waits[1]).toBeGreaterThan(waits[0]);
  expect(box.getSnapshot()[0].attempts).toBe(2);
  state.time += waits[1] + 1;
  expect(await box.flush()).toMatchObject({ sent: 1, remaining: 0 });         // and then it goes through
  server.plans = [{ status: 429 }];
  box.enqueue(entry('note.create'));
  expect(await box.flush()).toMatchObject({ stopped: 'server' });
});

test('"Send now" can go ahead of a pause', async () => {
  const { box, server } = env();
  await box.setUser('u1');
  box.enqueue(entry('note.create'));
  server.plans = [{ status: 500 }];
  await box.flush();
  expect(await box.flush({ force: true })).toMatchObject({ sent: 1, remaining: 0 });
});

test('a connection the phone thinks is down can still be tried on purpose (force), because the phone is sometimes wrong', async () => {
  const { box } = env({ online: false });
  await box.setUser('u1');
  box.enqueue(entry('note.create'));
  expect(await box.flush({ force: true })).toMatchObject({ sent: 1 });
});

test('an entry that depends on another waiting entry is sent after it, with the real id filled in (a renter added to a unit that was added offline)', async () => {
  const { box, server } = env();
  await box.setUser('u1');
  const unit = box.enqueue({ id: 'unitop', ...entry('unit.create') });
  box.enqueue({ kind: 'tenancy.create', label: 'renter', path: '/api/tenancy', ownerAccount: 'o1', body: { unit_id: localId(unit.id), tenant_name: 'Ravi', nested: { also: localId(unit.id) } } });
  box.enqueue({ kind: 'note.create', label: 'note', path: `/api/units/${localId(unit.id)}/notes`, body: { text: 'hello' } });
  await box.flush();
  const realId = 'unit.create-1';
  expect(server.created[1]).toMatchObject({ kind: 'tenancy.create', body: { unit_id: realId, nested: { also: realId } } });
  expect(server.created[2].path).toBe(`/api/units/${realId}/notes`);
  expect(JSON.stringify(server.created)).not.toContain('local-');             // no placeholder ever reaches the server
});

test('a dependent entry waits while its parent is only waiting, and is refused if the parent was refused or discarded', async () => {
  const { box, server } = env({ online: true });
  await box.setUser('u1');
  const unit = box.enqueue({ id: 'u1op', ...entry('unit.create') });
  const renter = box.enqueue({ kind: 'tenancy.create', label: 'r', path: '/api/tenancy', body: { unit_id: localId(unit.id) } });
  server.plans = [{ status: 409, code: 'CONFLICT', message: 'unit exists' }];
  await box.flush();
  expect(box.getSnapshot().find((i) => i.id === unit.id)).toMatchObject({ status: 'failed' });
  expect(box.getSnapshot().find((i) => i.id === renter.id)).toMatchObject({ status: 'failed', error: { code: 'DEPENDENCY_FAILED' } });
  expect(server.calls).toHaveLength(1);                                       // the renter was never sent with a made-up unit

  const e2 = env(); await e2.box.setUser('u1');
  const u2 = e2.box.enqueue({ id: 'u2op', ...entry('unit.create') });
  const r2 = e2.box.enqueue({ kind: 'tenancy.create', label: 'r', path: '/api/tenancy', body: { unit_id: localId(u2.id) } });
  e2.box.discard(u2.id);
  expect(e2.box.getSnapshot().find((i) => i.id === r2.id)).toMatchObject({ status: 'failed', error: { code: 'DEPENDENCY_DISCARDED' } });
});

test('two sends asked for at once are one send: nothing goes twice', async () => {
  const { box, server } = env();
  await box.setUser('u1');
  box.enqueue(entry('note.create')); box.enqueue(entry('charge.create'));
  const [a, b] = await Promise.all([box.flush(), box.flush()]);
  expect(a).toBe(b);
  expect(server.calls).toHaveLength(2);
});

test('an entry added while the sending is running waits for the next round and is not lost', async () => {
  const { box, server } = env();
  await box.setUser('u1');
  box.enqueue(entry('note.create'));
  let added = false;
  const original = server.handle.bind(server);
  server.handle = async (item) => { if (!added) { added = true; box.enqueue(entry('charge.create')); } return original(item); };
  await box.flush();
  expect(box.getSnapshot().map((i) => i.kind)).toEqual(['charge.create']);
  await box.flush();
  expect(box.getSnapshot()).toEqual([]);
});

test('an entry saved more than 30 days ago is not sent: the server no longer remembers its key', async () => {
  const { box, server, state } = env();
  await box.setUser('u1');
  box.enqueue(entry('note.create'));
  state.time += MAX_AGE_MS + 1000;
  await box.flush();
  expect(server.calls).toHaveLength(0);
  expect(box.getSnapshot()[0]).toMatchObject({ status: 'failed', error: { code: 'EXPIRED' } });
});

test('there is a limit to how many can wait, and the person is told', async () => {
  const { box } = env({ online: false });
  await box.setUser('u1');
  for (let i = 0; i < MAX_ITEMS; i++) box.enqueue(entry('note.create'));
  expect(() => box.enqueue(entry('note.create'))).toThrow(OutboxFullError);
});

test('each person has their own queue on the phone: another person signing in never sees or sends it, and signing out forgets it from memory', async () => {
  const { box, server, storage, make } = env({ online: false });
  await box.setUser('alice');
  box.enqueue(entry('note.create', { who: 'alice' }));
  await box.idle();
  await box.setUser('bob');
  expect(box.getSnapshot()).toEqual([]);
  box.enqueue(entry('note.create', { who: 'bob' }));
  await box.idle();
  await box.setUser('alice');
  expect(box.getSnapshot().map((i) => (i.body as any).who)).toEqual(['alice']);
  box.clear();
  expect(box.getSnapshot()).toEqual([]);
  expect(() => box.enqueue(entry('note.create'))).toThrow();                  // nobody is signed in
  expect([...storage.data.keys()].sort()).toEqual(['outbox-alice', 'outbox-bob']);
  expect(server.calls).toHaveLength(0);
  const again = make(); await again.setUser('bob');
  expect(again.getSnapshot().map((i) => (i.body as any).who)).toEqual(['bob']);
});

test('damaged saved data is treated as empty instead of crashing the app', async () => {
  const { box, storage } = env();
  storage.data.set('outbox-u1', '{not json');
  await box.setUser('u1');
  expect(box.getSnapshot()).toEqual([]);
  storage.data.set('outbox-u2', JSON.stringify({ v: 99, items: [{}] }));
  await box.setUser('u2');
  expect(box.getSnapshot()).toEqual([]);
});

test('screens are told about every change, and each change gives them a new list to compare', async () => {
  const { box } = env();
  await box.setUser('u1');
  const seen: number[] = [];
  const off = box.subscribe(() => seen.push(box.getSnapshot().length));
  const before = box.getSnapshot();
  box.enqueue(entry('note.create'));
  expect(box.getSnapshot()).not.toBe(before);
  await box.flush();
  expect(seen.length).toBeGreaterThanOrEqual(3);                              // added, sending, done
  expect(seen[seen.length - 1]).toBe(0);
  off();
  const count = seen.length;
  box.enqueue(entry('note.create'));
  expect(seen.length).toBe(count);                                            // a screen that has gone away is not told
});

test('what is kept on the phone always matches what is waiting', async () => {
  const { box, storage } = env({ online: false });
  await box.setUser('u1');
  const a = box.enqueue(entry('note.create')), b = box.enqueue(entry('charge.create'));
  await box.idle();
  const saved = () => JSON.parse(storage.data.get('outbox-u1')!).items.map((i: OutboxItem) => i.id);
  expect(saved()).toEqual([a.id, b.id]);
  box.discard(a.id); await box.idle();
  expect(saved()).toEqual([b.id]);
});

test('editing the same thing twice while offline sends only the last edit', async () => {
  const { box, server } = env({ online: false });
  await box.setUser('u1');
  box.enqueue({ ...entry('profile.update', { name: 'first' }), method: 'PUT', coalesceKey: 'profile' });
  box.enqueue(entry('note.create'));
  box.enqueue({ ...entry('profile.update', { name: 'second' }), method: 'PUT', coalesceKey: 'profile' });
  expect(box.getSnapshot().map((i) => [i.kind, (i.body as any).name])).toEqual([['note.create', 'note.create'], ['profile.update', 'second']]);
  await box.flush({ force: true });
  expect(server.created.filter((c) => c.kind === 'profile.update').map((c) => c.body.name)).toEqual(['second']);
});

test('different things with the same kind are not merged, and an entry another entry depends on is never replaced', async () => {
  const { box } = env({ online: false });
  await box.setUser('u1');
  box.enqueue({ ...entry('tenancy.edit', { id: 'A' }), coalesceKey: 'tenancy:A' });
  box.enqueue({ ...entry('tenancy.edit', { id: 'B' }), coalesceKey: 'tenancy:B' });
  expect(box.pendingCount()).toBe(2);
  const parent = box.enqueue({ id: 'parent', ...entry('unit.create'), coalesceKey: 'unit' });
  box.enqueue({ kind: 'tenancy.create', label: 'r', path: '/api/t', body: { unit_id: localId(parent.id) } });
  box.enqueue({ ...entry('unit.create'), coalesceKey: 'unit' });
  expect(box.getSnapshot().some((i) => i.id === 'parent')).toBe(true);          // something waits on it, so it stays
});

test('an entry saved in the first moments after the app opens, while the earlier saved entries are still being read from the phone, is not lost', async () => {
  const { box, storage, make } = env({ online: false });
  await box.setUser('u1');
  const earlier = box.enqueue(entry('note.create', { n: 'earlier' }));
  await box.idle();
  const reopened = make();                                                    // the app was closed and is opened again, offline
  const loading = reopened.setUser('u1');                                     // reading the saved entries from the phone takes a moment ...
  const quick = reopened.enqueue(entry('charge.create', { n: 'quick' }));     // ... and the person already saves something new
  await loading;
  await reopened.idle();
  expect(reopened.getSnapshot().map((i) => i.id)).toEqual([earlier.id, quick.id]);
  const again = make(); await again.setUser('u1');
  expect(again.getSnapshot().map((i) => i.id)).toEqual([earlier.id, quick.id]);   // and both are on the phone
  expect(storage.data.has('outbox-u1')).toBe(true);
});
