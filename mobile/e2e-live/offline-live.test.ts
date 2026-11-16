/**
 * LIVE offline-capture check: the real queue engine (src/lib/outbox.ts) talking to a REAL backend over HTTP.
 * Nothing here is faked on the server side. Network trouble is created on the phone's side of the connection (requests that never leave, replies that
 * never arrive, a sign-in that has expired), which is exactly where it happens in real life.
 *
 * Not part of the normal test run. Start a backend with an empty database, then:
 *   OFFLINE_E2E_URL=http://localhost:18480 npx jest --testPathIgnorePatterns=/node_modules/ e2e-live
 */
import crypto from 'crypto';
import http from 'http';

import { Outbox, localId, type OutboxItem } from '@/lib/outbox';
import type { KeyValue } from '@/lib/storage';

const BASE = new URL(process.env.OFFLINE_E2E_URL ?? 'http://localhost:18480');
jest.setTimeout(180_000);

// ------------------------------------------------------------------ plain HTTP to the real server
type Reply = { status: number; json: any };
function call(method: string, path: string, opts: { body?: unknown; token?: string; key?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (payload !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(payload)); }
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.key) headers['Idempotency-Key'] = opts.key;
    Object.assign(headers, opts.headers ?? {});
    const req = http.request({ host: BASE.hostname, port: BASE.port, path, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; } resolve({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
const ok = async (p: Promise<Reply>, what: string) => { const r = await p; if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.json)}`); return r.json; };

// ------------------------------------------------------------------ accounts, set up the way a real person would
const rnd = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
const phone = () => `9${rnd(9)}`;
type Actor = { phone: string; token: string; id: string };

async function signIn(phoneNumber: string): Promise<{ token: string; id: string }> {
  const code = (await ok(call('POST', '/api/v1/dev/otp/request', { body: { phone: phoneNumber } }), 'otp request')).demo_code;
  const token = (await ok(call('POST', '/api/v1/dev/otp/verify', { body: { phone: phoneNumber, code } }), 'otp verify')).id_token;
  const session = await ok(call('POST', '/api/v1/auth/session', { token }), 'session');
  return { token, id: session.id };
}
async function actionCode(token: string, action: string) { return (await ok(call('POST', '/api/v1/me/action-otp/request', { token, body: { action } }), `code ${action}`)).demo_code; }

async function makeRenter(name: string): Promise<Actor> {
  const p = phone(); const { token, id } = await signIn(p);
  await ok(call('POST', '/api/v1/me/roles', { token, body: { roles: ['tenant'] } }), 'roles');
  const me = await ok(call('GET', '/api/v1/me', { token }), 'me');
  await ok(call('PUT', '/api/v1/me/profile', { token, body: { full_name: name, preferred_language: 'en', version: me.version } }), 'profile');
  return { phone: p, token, id };
}

async function makeOwner(name: string): Promise<{ actor: Actor; propertyId: string }> {
  const p = phone(); const { token, id } = await signIn(p);
  await ok(call('POST', '/api/v1/me/roles', { token, body: { roles: ['owner'] } }), 'roles');
  const me = await ok(call('GET', '/api/v1/me', { token }), 'me');
  await ok(call('PUT', '/api/v1/me/profile', { token, body: { full_name: name, preferred_language: 'en', version: me.version } }), 'profile');
  await ok(call('PUT', '/api/v1/owner/verification', { token, body: { legal_name: name, pan: `ABCDE${rnd(4)}F`, address: '1 Test Street, Madurai', proof_type: 'property_tax', proof_ref: `PT-${rnd(6)}-X`, declare: true, otp_code: await actionCode(token, 'owner_details') } }), 'owner details');
  const notice = (await ok(call('GET', '/api/v1/me/identity', { token }), 'identity')).notice_version;
  const started = await ok(call('POST', '/api/v1/me/identity/start', { token, body: { consent: true, notice_version: notice, otp_code: await actionCode(token, 'identity') } }), 'identity start');
  // the ID check provider answers with a signed "verified" result, exactly as the Python tests do
  const event = { session_id: String(started.session.url).split('/').pop(), status: 'verified', method: 'sandbox', liveness_passed: true, face_matched: true, name_matched: true };
  const signature = crypto.createHmac('sha256', process.env.OFFLINE_E2E_KYC_SECRET ?? 'sandbox-kyc-webhook-secret').update(JSON.stringify(event)).digest('hex');
  const verified = await call('POST', '/api/v1/webhooks/kyc', { body: event, headers: { 'x-kyc-signature': signature } } as any);
  if (verified.status !== 200) throw new Error(`photo ID webhook failed: ${verified.status} ${JSON.stringify(verified.json)}`);
  await ok(call('POST', '/api/v1/subscription/checkout', { token, body: { plan_code: 'growth', idempotency_key: `setup-${rnd(12)}` } }), 'plan (free month)');
  const n = rnd(6);
  const property = await ok(call('POST', '/api/v1/owner/properties', { token, body: { address: `${n} Test Street, Anna Nagar`, name: `Test Complex ${n}`, city: 'Madurai', state: 'Tamil Nadu', pincode: '625001', kind: 'commercial', proof_type: 'property_tax', proof_ref: `PT-MDU-${n}-X`, declare: true, otp_code: await actionCode(token, 'property') } }), 'property');
  return { actor: { phone: p, token, id }, propertyId: property.id ?? property.property_id };
}

// ------------------------------------------------------------------ a "phone": the real Outbox, real storage semantics, and a send() that goes to the real server
class PhoneStorage implements KeyValue {
  data = new Map<string, string>();
  async getJson<T>(k: string) { const v = this.data.get(k); return v ? (JSON.parse(v) as T) : null; }
  async setJson(k: string, v: unknown) { this.data.set(k, JSON.stringify(v)); }
  async remove(k: string) { this.data.delete(k); }
}
type Trouble = 'none' | 'drop-request' | 'lose-reply';
class Phone {
  storage = new PhoneStorage();
  online = true;
  token: string;
  trouble: Trouble[] = [];                         // what happens to the next requests, in order
  sent: { key: string; path: string; status: number }[] = [];
  box: Outbox;
  constructor(public actorToken: string, public userId: string, sharedStorage?: PhoneStorage) {
    this.token = actorToken;
    if (sharedStorage) this.storage = sharedStorage;
    this.box = this.makeBox();
  }
  makeBox() {
    return new Outbox({
      storage: this.storage, keyFor: (u) => `outbox-${u}`, isOnline: () => this.online, newId: () => `${rnd(6)}${rnd(6)}${rnd(6)}`,
      send: async (item) => {
        const trouble = this.trouble.shift() ?? 'none';
        if (trouble === 'drop-request') throw Object.assign(new Error('cannot reach the server'), { status: 0, code: 'OFFLINE' });
        const r = await call(item.method, item.path, { body: item.body, token: this.token, key: item.idempotencyKey });
        this.sent.push({ key: item.idempotencyKey, path: item.path, status: r.status });
        if (trouble === 'lose-reply') throw Object.assign(new Error('no reply'), { status: 0, code: 'TIMEOUT' });   // the server did it, the phone never heard
        if (r.status >= 300) throw Object.assign(new Error(r.json?.error?.message ?? 'refused'), { status: r.status, code: r.json?.error?.code ?? 'ERROR' });
        return r.json;
      },
    });
  }
  /** The app is closed and opened again: a new process reading what is on the phone. */
  restart() { this.box = this.makeBox(); return this.box.setUser(this.userId); }
}
const renterBody = (unitId: string, name: string, mobile: string) => ({
  unit_id: unitId, property_id: null, unit_identifier: '', tenant_name: name, tenant_mobile: mobile, monthly_rent: '12000', due_day: 5,
  start_date: new Date().toISOString().slice(0, 8) + '01', end_date: new Date(Date.now() + 700 * 864e5).toISOString().slice(0, 10), security_deposit: '24000', pay_method: 'cash',
});
const entry = (kind: string, path: string, body: unknown, extra: Record<string, unknown> = {}) => ({ kind, label: kind, path, body, ownerAccount: null, ...extra });

// ------------------------------------------------------------------ the scenarios
let owner: Actor; let propertyId: string;
const units = async () => (await ok(call('GET', '/api/v1/owner/units?status=active', { token: owner.token }), 'units')).items as any[];
const tenancies = async () => (await ok(call('GET', '/api/v1/owner/tenancies?status=all', { token: owner.token }), 'tenancies')).items as any[];
const byName = (list: any[], name: string) => list.filter((t) => String(t.tenant_name ?? t.name ?? t.tenant ?? '').toUpperCase() === name.toUpperCase());

beforeAll(async () => {
  const made = await makeOwner('Live Owner');
  owner = made.actor; propertyId = made.propertyId;
  expect(propertyId).toBeTruthy();
});

test('1. AN OWNER WORKS OFFLINE: a unit, a renter for that unit and a note on that renter are saved with no network, then all three arrive once, in order, with the real ids filled in', async () => {
  const phone1 = new Phone(owner.token, owner.id);
  await phone1.box.setUser(owner.id);
  phone1.online = false;
  const unitOp = phone1.box.enqueue({ id: 'op-unit-1', ...entry('unit.create', '/api/v1/owner/units', { property_id: propertyId, identifier: 'LIVE-1', kind: 'commercial', floor: null }) });
  const renterOp = phone1.box.enqueue({ id: 'op-renter-1', ...entry('tenancy.create', '/api/v1/owner/tenancies', renterBody(localId(unitOp.id), 'Live Ravi', phone())) });
  phone1.box.enqueue(entry('note.create', `/api/v1/tenancies/${localId(renterOp.id)}/notes`, { target_type: 'tenancy', target_id: localId(renterOp.id), body: 'Keys handed over', input_method: 'typed' }));
  await phone1.box.idle();

  const first = await phone1.box.flush();                                      // still offline: nothing leaves the phone
  expect(first).toMatchObject({ sent: 0, remaining: 3, stopped: 'offline' });
  expect(phone1.sent).toHaveLength(0);

  phone1.online = true;                                                        // the connection is back
  const second = await phone1.box.flush();
  expect(second).toMatchObject({ sent: 3, failed: 0, remaining: 0, stopped: null });
  expect(phone1.sent.map((s) => s.status)).toEqual([200, 200, 200]);
  expect(phone1.sent.map((s) => s.path)).toEqual(['/api/v1/owner/units', '/api/v1/owner/tenancies', expect.stringMatching(/^\/api\/v1\/tenancies\/[0-9a-f-]{36}\/notes$/)]);

  const madeUnits = (await units()).filter((u) => u.identifier === 'LIVE-1');
  expect(madeUnits).toHaveLength(1);
  const madeTenancies = byName(await tenancies(), 'Live Ravi');
  expect(madeTenancies).toHaveLength(1);
  const notes = (await ok(call('GET', `/api/v1/tenancies/${madeTenancies[0].id}/notes`, { token: owner.token }), 'notes')).items;
  expect(notes.filter((n: any) => /keys handed over/i.test(n.body))).toHaveLength(1);
  expect(phone1.box.getSnapshot()).toEqual([]);
});

test('2. THE LOST REPLY: the server added the renter but the phone never heard; sending again with the same key adds NO second renter', async () => {
  const phone2 = new Phone(owner.token, owner.id);
  await phone2.box.setUser(owner.id);
  const unit = await ok(call('POST', '/api/v1/owner/units', { token: owner.token, body: { property_id: propertyId, identifier: 'LIVE-2', kind: 'commercial' } }), 'unit');
  phone2.box.enqueue(entry('tenancy.create', '/api/v1/owner/tenancies', renterBody(unit.id, 'Live Selvi', phone())));
  phone2.trouble = ['lose-reply'];
  expect(await phone2.box.flush()).toMatchObject({ sent: 0, remaining: 1, stopped: 'offline' });
  expect(byName(await tenancies(), 'Live Selvi')).toHaveLength(1);              // already on the server
  expect(await phone2.box.flush()).toMatchObject({ sent: 1, remaining: 0 });
  expect(byName(await tenancies(), 'Live Selvi')).toHaveLength(1);              // and still exactly one
  expect(phone2.sent[0].key).toBe(phone2.sent[1].key);
  expect(phone2.sent.map((s) => s.status)).toEqual([200, 200]);                // the repeat was answered as a success, not "unit occupied"
});

test('3. THE APP IS CLOSED AT THE WORST MOMENT: it restarts, reads the saved entry and sends it again; still exactly one renter', async () => {
  const phone3 = new Phone(owner.token, owner.id);
  await phone3.box.setUser(owner.id);
  const unit = await ok(call('POST', '/api/v1/owner/units', { token: owner.token, body: { property_id: propertyId, identifier: 'LIVE-3', kind: 'commercial' } }), 'unit');
  phone3.box.enqueue(entry('tenancy.create', '/api/v1/owner/tenancies', renterBody(unit.id, 'Live Kavya', phone())));
  await phone3.box.idle();
  phone3.trouble = ['lose-reply'];
  await phone3.box.flush();                                                      // the server did it; the app dies before noting that
  await phone3.restart();                                                        // a new app process
  expect(phone3.box.pendingCount()).toBe(1);                                     // the entry survived on the phone
  await phone3.box.flush();
  expect(byName(await tenancies(), 'Live Kavya')).toHaveLength(1);
  expect(phone3.box.getSnapshot()).toEqual([]);
});

test('4. TWO COPIES AT ONCE (two phones, or two app processes, both holding the same saved entry): exactly one renter', async () => {
  const shared = new PhoneStorage();
  const a = new Phone(owner.token, owner.id, shared);
  await a.box.setUser(owner.id);
  const unit = await ok(call('POST', '/api/v1/owner/units', { token: owner.token, body: { property_id: propertyId, identifier: 'LIVE-4', kind: 'commercial' } }), 'unit');
  a.box.enqueue(entry('tenancy.create', '/api/v1/owner/tenancies', renterBody(unit.id, 'Live Twin', phone())));
  await a.box.idle();
  const b = new Phone(owner.token, owner.id, shared);                            // the same saved entry, on a second copy of the app
  await b.box.setUser(owner.id);
  await Promise.all([a.box.flush(), b.box.flush()]);
  expect(byName(await tenancies(), 'Live Twin')).toHaveLength(1);
  expect([...a.sent, ...b.sent].map((s) => s.status).sort()).toEqual([200, 200]);   // both were answered with success; the work was done once
});

test('5. THE CONNECTION DROPS HALF WAY THROUGH A BATCH: what was sent stays sent, the rest goes next time, nothing is doubled or lost', async () => {
  const phone5 = new Phone(owner.token, owner.id);
  await phone5.box.setUser(owner.id);
  for (let i = 1; i <= 6; i++) phone5.box.enqueue(entry('unit.create', '/api/v1/owner/units', { property_id: propertyId, identifier: `BATCH-${i}`, kind: 'residential', floor: i }));
  phone5.trouble = ['none', 'none', 'drop-request'];                             // the third request never leaves the phone
  expect(await phone5.box.flush()).toMatchObject({ sent: 2, remaining: 4, stopped: 'offline' });
  expect((await units()).filter((u) => u.identifier.startsWith('BATCH-'))).toHaveLength(2);
  expect(await phone5.box.flush()).toMatchObject({ sent: 4, remaining: 0 });
  const batch = (await units()).filter((u) => u.identifier.startsWith('BATCH-'));
  expect(batch.map((u) => u.identifier).sort()).toEqual(['BATCH-1', 'BATCH-2', 'BATCH-3', 'BATCH-4', 'BATCH-5', 'BATCH-6']);
});

test('6. THE SERVER SAYS NO: a renter for a unit that was taken meanwhile is refused with the real reason; the other entries still go', async () => {
  const phone6 = new Phone(owner.token, owner.id);
  await phone6.box.setUser(owner.id);
  const taken = (await units()).find((u) => u.identifier === 'LIVE-1')!;       // let to "Live Ravi" in scenario 1
  const free = await ok(call('POST', '/api/v1/owner/units', { token: owner.token, body: { property_id: propertyId, identifier: 'LIVE-6', kind: 'commercial' } }), 'unit');
  const refused = phone6.box.enqueue(entry('tenancy.create', '/api/v1/owner/tenancies', renterBody(taken.id, 'Live Late', phone())));
  phone6.box.enqueue(entry('tenancy.create', '/api/v1/owner/tenancies', renterBody(free.id, 'Live Fine', phone())));
  expect(await phone6.box.flush()).toMatchObject({ sent: 1, failed: 1, remaining: 0 });
  const bad = phone6.box.getSnapshot().find((i) => i.id === refused.id)!;
  expect(bad).toMatchObject({ status: 'failed', error: { status: 409, code: 'UNIT_OCCUPIED' } });
  expect(bad.error!.message).toMatch(/LIVE-1|already|let|offered/i);
  expect(byName(await tenancies(), 'Live Late')).toHaveLength(0);
  expect(byName(await tenancies(), 'Live Fine')).toHaveLength(1);
});

test('7. THE SIGN-IN HAS RUN OUT while entries wait: sending stops and keeps everything; after signing in again it all goes through', async () => {
  const phone7 = new Phone(owner.token, owner.id);
  await phone7.box.setUser(owner.id);
  phone7.box.enqueue(entry('unit.create', '/api/v1/owner/units', { property_id: propertyId, identifier: 'LIVE-7', kind: 'commercial' }));
  phone7.token = 'not-a-valid-token';
  expect(await phone7.box.flush()).toMatchObject({ sent: 0, remaining: 1, stopped: 'auth' });
  expect(phone7.box.authBlocked).toBe(true);
  expect(phone7.box.failedCount()).toBe(0);                                      // not "refused": just waiting for a sign-in
  phone7.token = owner.token;                                                    // the person signs in again
  expect(await phone7.box.flush()).toMatchObject({ sent: 1, remaining: 0 });
  expect(phone7.box.authBlocked).toBe(false);
  expect((await units()).filter((u) => u.identifier === 'LIVE-7')).toHaveLength(1);
});

test('8. EDITING THE SAME RENTER TWICE OFFLINE sends only the last edit, with no "changed elsewhere" conflict', async () => {
  const phone8 = new Phone(owner.token, owner.id);
  await phone8.box.setUser(owner.id);
  const tenancy = byName(await tenancies(), 'Live Ravi')[0];
  const detail = await ok(call('GET', `/api/v1/owner/tenancies/${tenancy.id}`, { token: owner.token }), 'tenancy');
  const edit = (rent: string) => entry('tenancy.update', `/api/v1/owner/tenancies/${tenancy.id}`, { version: detail.tenancy.version, monthly_rent: rent, due_day: 7 }, { method: 'PATCH', coalesceKey: `tenancy:${tenancy.id}` });
  phone8.box.enqueue(edit('13000'));
  phone8.box.enqueue(edit('14500'));
  expect(phone8.box.pendingCount()).toBe(1);                                     // the first edit was replaced
  expect(await phone8.box.flush()).toMatchObject({ sent: 1, failed: 0 });
  const after = await ok(call('GET', `/api/v1/owner/tenancies/${tenancy.id}`, { token: owner.token }), 'tenancy');
  expect(JSON.stringify(after)).toMatch(/14500|145/);                            // the later rent is the one that took effect
  expect(JSON.stringify(after)).not.toMatch(/"13000"/);
});

test('9. A CHARGE SAVED OFFLINE is charged once even if its reply is lost', async () => {
  const phone9 = new Phone(owner.token, owner.id);
  await phone9.box.setUser(owner.id);
  const tenancy = byName(await tenancies(), 'Live Ravi')[0];
  const month = new Date().toISOString().slice(0, 8) + '01';
  phone9.box.enqueue(entry('charge.create', `/api/v1/owner/tenancies/${tenancy.id}/charges`, { period_month: month, category: 'water', amount: '250' }));
  phone9.trouble = ['lose-reply'];
  await phone9.box.flush(); await phone9.box.flush();
  const bill = await ok(call('GET', `/api/v1/tenancies/${tenancy.id}/bill?month=${month}`, { token: owner.token }), 'bill');
  expect(JSON.stringify(bill).match(/"category":"water"/g)?.length ?? 0).toBe(1);
});

test('10. A RENTER WORKS OFFLINE TOO: a note and a message to the owner are saved, then arrive once', async () => {
  const renter = await makeRenter('Live Renter');
  const unit = await ok(call('POST', '/api/v1/owner/units', { token: owner.token, body: { property_id: propertyId, identifier: 'LIVE-10', kind: 'commercial' } }), 'unit');
  const created = await ok(call('POST', '/api/v1/owner/tenancies', { token: owner.token, body: renterBody(unit.id, 'Live Renter', renter.phone) }), 'tenancy');
  const invites = (await ok(call('GET', '/api/v1/tenant/invitations', { token: renter.token }), 'invitations')).items;
  for (const inv of invites) await ok(call('POST', `/api/v1/tenant/invitations/${inv.id}/accept`, { token: renter.token }), 'accept');

  const phone10 = new Phone(renter.token, renter.id);
  await phone10.box.setUser(renter.id);
  phone10.online = false;
  phone10.box.enqueue(entry('note.create', `/api/v1/tenancies/${created.tenancy_id}/notes`, { target_type: 'tenancy', target_id: created.tenancy_id, body: 'Water meter changed', input_method: 'typed' }));
  phone10.box.enqueue(entry('message.create', `/api/v1/tenant/tenancies/${created.tenancy_id}/messages`, { text: 'The tap is leaking', lang: 'en', input_method: 'typed' }));
  expect(await phone10.box.flush()).toMatchObject({ sent: 0, remaining: 2, stopped: 'offline' });
  phone10.online = true;
  phone10.trouble = ['lose-reply', 'none', 'lose-reply'];                         // replies are lost on the first tries
  await phone10.box.flush(); await phone10.box.flush(); await phone10.box.flush();
  expect(phone10.box.getSnapshot()).toEqual([]);
  const notes = (await ok(call('GET', `/api/v1/tenancies/${created.tenancy_id}/notes`, { token: owner.token }), 'notes')).items;
  expect(notes.filter((n: any) => /water meter changed/i.test(n.body))).toHaveLength(1);
});

test('11. A BIG BATCH: forty units saved offline all arrive exactly once, in the order they were entered', async () => {
  const phone11 = new Phone(owner.token, owner.id);
  await phone11.box.setUser(owner.id);
  phone11.online = false;
  for (let i = 1; i <= 25; i++) phone11.box.enqueue(entry('unit.create', '/api/v1/owner/units', { property_id: propertyId, identifier: `MASS-${String(i).padStart(2, '0')}`, kind: 'residential', floor: i % 10 }));
  await phone11.box.idle();
  await phone11.restart();                                                       // and the app is restarted while still offline
  expect(phone11.box.pendingCount()).toBe(25);
  phone11.online = true;
  phone11.trouble = ['none', 'lose-reply', 'none', 'drop-request'];             // with some trouble on the way
  let rounds = 0;
  while (phone11.box.pendingCount() > 0 && rounds++ < 40) await phone11.box.flush();
  expect(phone11.box.pendingCount()).toBe(0);
  const mass = (await units()).filter((u) => u.identifier.startsWith('MASS-')).map((u) => u.identifier).sort();
  expect(mass).toHaveLength(25);
  expect(new Set(mass).size).toBe(25);                                           // no duplicates
});

test('12. SAFETY: the same key from another person, or for another request, never returns someone else\'s result or does something else', async () => {
  const stranger = await makeRenter('Live Stranger');
  const key = `shared-${rnd(10)}-key`;
  const mine = await call('POST', '/api/v1/owner/units', { token: owner.token, key, body: { property_id: propertyId, identifier: 'KEY-A', kind: 'commercial' } });
  expect(mine.status).toBe(200);
  const other = await call('POST', '/api/v1/tenancies/00000000-0000-0000-0000-000000000000/notes', { token: stranger.token, key, body: { target_type: 'tenancy', target_id: '00000000-0000-0000-0000-000000000000', body: 'x' } });
  expect(JSON.stringify(other.json)).not.toContain(mine.json.id);                // never my reply
  const sameKeyDifferentRequest = await call('POST', '/api/v1/owner/units', { token: owner.token, key, body: { property_id: propertyId, identifier: 'KEY-B', kind: 'commercial' } });
  expect(sameKeyDifferentRequest.status).toBe(409);
  expect(sameKeyDifferentRequest.json.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  expect((await units()).filter((u) => u.identifier === 'KEY-B')).toHaveLength(0);
});
