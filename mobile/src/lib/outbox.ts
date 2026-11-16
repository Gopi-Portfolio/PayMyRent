// The outbox: data entries made on the phone that could not be sent yet (no network), kept safely on the phone and sent, in order, when the
// connection is back. This file is the engine only; it knows nothing about screens. Everything it needs from outside is handed in, so it can be
// tested without a phone: the storage, the way to send, and whether the phone is online.
//
// What it guarantees:
//  - an entry is saved on the phone BEFORE anything else happens, so closing the app or losing power does not lose it;
//  - entries are sent oldest first, one at a time;
//  - every entry carries its own idempotency key, so the server does it once even if the first reply was lost and the entry is sent again;
//  - a network problem leaves the entry waiting; a "no" from the server (a rule was broken) marks it "needs attention" and sends the others on;
//  - an entry that points at something another waiting entry creates ("local-<id>") is sent after it, with the real id filled in.
import type { KeyValue } from './storage';

export type OutboxStatus = 'pending' | 'failed';
export type OutboxError = { code: string; message: string; status: number };
export type OutboxItem = {
  id: string;
  kind: string;                    // what sort of entry: 'tenancy.create', 'unit.create', 'note.create' ...
  label: string;                   // a line the person can read in the list of saved changes, in the language they used
  method: string;
  path: string;
  body: unknown;
  ownerAccount: string | null;
  idempotencyKey: string;
  createdAt: number;
  status: OutboxStatus;
  attempts: number;                // times the server itself failed (5xx / busy); a lost connection is not counted
  nextAttemptAt?: number;          // after a server failure, not before this time
  error?: OutboxError;
  coalesceKey?: string;            // a later waiting entry with the same key replaces this one (editing the same thing twice offline sends only the last edit)
};
export type EnqueueInput = Pick<OutboxItem, 'kind' | 'label' | 'path'> & Partial<Pick<OutboxItem, 'method' | 'body' | 'ownerAccount' | 'idempotencyKey' | 'coalesceKey'>> & { id?: string };
export type SendFn = (item: OutboxItem) => Promise<unknown>;
export type FlushStop = 'offline' | 'auth' | 'server' | null;
export type FlushResult = { sent: number; failed: number; remaining: number; stopped: FlushStop };

type Saved = { v: 1; items: OutboxItem[]; idMap: Record<string, string> };

export const MAX_ITEMS = 200;                       // more than this waiting means something is wrong: ask the person to connect
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000;    // the server remembers a key for 35 days, so an older entry is not sent any more
const LOCAL = /local-[A-Za-z0-9_-]+/g;

export const localId = (opId: string) => `local-${opId}`;
export const isLocalId = (v: unknown): v is string => typeof v === 'string' && v.startsWith('local-');
/** The id the server gave to what an entry created (a new renter's tenancy, a new unit). */
const createdId = (result: any): string | null => (result && (result.tenancy_id ?? result.id)) ? String(result.tenancy_id ?? result.id) : null;
const backoffMs = (attempts: number) => Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

export class OutboxFullError extends Error { constructor() { super('OUTBOX_FULL'); } }

type Deps = {
  storage: KeyValue;
  keyFor: (userId: string) => string;
  send: SendFn;
  isOnline: () => boolean;
  newId: () => string;                              // a new, unique id for an entry
  now?: () => number;
  onSynced?: (item: OutboxItem, result: unknown) => void;
  onNeedsSignIn?: () => void;
};

export class Outbox {
  private items: OutboxItem[] = [];
  private idMap: Record<string, string> = {};
  private userId: string | null = null;
  private watchers = new Set<() => void>();
  private running: Promise<FlushResult> | null = null;
  private saving: Promise<void> = Promise.resolve();
  /** The server said the sign-in has run out: entries wait until the person signs in again. */
  authBlocked = false;
  constructor(private d: Deps) {}

  private now = () => (this.d.now ?? Date.now)();

  /* ---------- what the screens read ---------- */
  getSnapshot = (): OutboxItem[] => this.items;
  subscribe = (fn: () => void) => { this.watchers.add(fn); return () => { this.watchers.delete(fn); }; };
  pendingCount = () => this.items.filter((i) => i.status === 'pending').length;
  failedCount = () => this.items.filter((i) => i.status === 'failed').length;
  isSending = () => this.running !== null;
  private changed() { this.items = [...this.items]; this.watchers.forEach((w) => w()); }

  /* ---------- keeping it on the phone ---------- */
  /** Starts (or switches) to this person's saved entries. With no person, nothing is kept in memory. */
  async setUser(userId: string | null): Promise<void> {
    if (userId === this.userId) return;
    this.userId = userId;
    this.items = []; this.idMap = {}; this.authBlocked = false;
    if (userId) {
      const saved = await this.d.storage.getJson<Saved>(this.d.keyFor(userId));
      if (saved?.v === 1 && Array.isArray(saved.items) && this.userId === userId) { this.items = saved.items; this.idMap = saved.idMap ?? {}; }
    }
    this.changed();
  }
  /** Forget everything in memory (sign-out). The saved copy is removed by offlineData.clearOfflineData. */
  clear() { this.userId = null; this.items = []; this.idMap = {}; this.changed(); }
  /** Resolves when everything changed so far has been written to the phone. */
  idle(): Promise<void> { return this.saving; }
  private persist() {
    const userId = this.userId;
    if (!userId) return;
    const snapshot: Saved = { v: 1, items: this.items, idMap: this.idMap };
    this.saving = this.saving.then(() => this.d.storage.setJson(this.d.keyFor(userId), snapshot)).catch(() => undefined);
  }

  /* ---------- adding, retrying, discarding ---------- */
  enqueue(input: EnqueueInput): OutboxItem {
    if (!this.userId) throw new Error('OUTBOX_NO_USER');
    // editing the same thing again before the first edit was sent: only the newest edit is kept (the older one would arrive with an out-of-date version)
    const replaced = input.coalesceKey ? this.items.filter((i) => i.status === 'pending' && i.coalesceKey === input.coalesceKey && !this.dependedOn(i.id)) : [];
    if (this.items.length - replaced.length >= MAX_ITEMS) throw new OutboxFullError();
    if (replaced.length) this.items = this.items.filter((i) => !replaced.includes(i));
    const item: OutboxItem = {
      id: input.id ?? this.d.newId(), kind: input.kind, label: input.label, method: input.method ?? 'POST', path: input.path, body: input.body,
      ownerAccount: input.ownerAccount ?? null, idempotencyKey: input.idempotencyKey ?? this.d.newId(), createdAt: this.now(), status: 'pending', attempts: 0, coalesceKey: input.coalesceKey,
    };
    this.items = [...this.items, item];
    this.persist(); this.changed();
    return item;
  }
  /** Another try for an entry the server did not accept (the person fixed the cause elsewhere, for example freed the unit). */
  retry(id: string) {
    const it = this.items.find((i) => i.id === id);
    if (!it || it.status !== 'failed') return;
    it.status = 'pending'; it.error = undefined; it.nextAttemptAt = undefined;
    this.persist(); this.changed();
  }
  discard(id: string) {
    const gone = this.items.find((i) => i.id === id);
    this.items = this.items.filter((i) => i.id !== id);
    // anything that was waiting for it can no longer be sent
    if (gone) for (const dep of this.items) if (dep.status === 'pending' && this.references(dep).includes(id) && !(id in this.idMap)) this.fail(dep, { code: 'DEPENDENCY_DISCARDED', message: 'The change this one depended on was discarded.', status: 0 });
    this.persist(); this.changed();
  }

  /* ---------- sending ---------- */
  private dependedOn(id: string): boolean { return this.items.some((i) => i.id !== id && this.references(i).includes(id)); }
  private references(item: OutboxItem): string[] {
    const text = `${item.path}\n${JSON.stringify(item.body ?? null)}`;
    return [...new Set((text.match(LOCAL) ?? []).map((m) => m.slice('local-'.length)))];
  }
  private resolve(item: OutboxItem): OutboxItem {
    const swap = (s: string) => s.replace(LOCAL, (m) => this.idMap[m.slice('local-'.length)] ?? m);
    return { ...item, path: swap(item.path), body: item.body === undefined ? undefined : JSON.parse(swap(JSON.stringify(item.body))) };
  }
  private fail(item: OutboxItem, error: OutboxError) { item.status = 'failed'; item.error = error; item.nextAttemptAt = undefined; }

  /** Sends what is waiting. Safe to call at any time: if it is already running, the running one is returned. */
  flush(opts: { force?: boolean } = {}): Promise<FlushResult> {
    if (this.running) return this.running;
    this.running = this.run(!!opts.force).finally(() => { this.running = null; this.changed(); });
    this.changed();
    return this.running;
  }

  private async run(force: boolean): Promise<FlushResult> {
    let sent = 0, failed = 0; let stopped: FlushStop = null;
    for (const item of [...this.items]) {
      if (item.status !== 'pending' || !this.items.includes(item)) continue;
      if (!force && !this.d.isOnline()) { stopped = 'offline'; break; }
      if (!force && item.nextAttemptAt && this.now() < item.nextAttemptAt) continue;           // waiting out a server problem
      if (this.now() - item.createdAt > MAX_AGE_MS) { this.fail(item, { code: 'EXPIRED', message: 'This was saved more than 30 days ago and can no longer be sent.', status: 0 }); failed++; this.persist(); this.changed(); continue; }
      const waitingFor = this.references(item).filter((r) => !(r in this.idMap));
      if (waitingFor.length) {
        const dep = this.items.find((i) => i.id === waitingFor[0]);
        if (!dep) { this.fail(item, { code: 'DEPENDENCY_MISSING', message: 'The change this one depended on is gone.', status: 0 }); failed++; this.persist(); this.changed(); }
        else if (dep.status === 'failed') { this.fail(item, { code: 'DEPENDENCY_FAILED', message: 'The change this one depended on needs attention first.', status: 0 }); failed++; this.persist(); this.changed(); }
        continue;                                                                             // otherwise it waits for the earlier entry to be sent
      }
      try {
        const result = await this.d.send(this.resolve(item));
        this.items = this.items.filter((i) => i.id !== item.id);
        const made = createdId(result);
        if (made) this.idMap[item.id] = made;
        sent++; this.authBlocked = false;
        this.persist(); this.changed();
        this.d.onSynced?.(item, result);
      } catch (e) {
        const status = typeof (e as any)?.status === 'number' ? (e as any).status : 0;
        const code = String((e as any)?.code ?? 'ERROR'), message = String((e as any)?.message ?? 'The change could not be sent.');
        if (status === 0) { stopped = 'offline'; break; }                                     // no connection: it keeps waiting, nothing is lost
        if (status === 401) { stopped = 'auth'; this.authBlocked = true; this.changed(); this.d.onNeedsSignIn?.(); break; }            // sign in again; the entry keeps waiting
        if (status === 429 || status >= 500) {                                                // the server is busy or unwell: try again later
          item.attempts += 1; item.nextAttemptAt = this.now() + backoffMs(item.attempts); stopped = 'server';
          this.persist(); this.changed(); break;
        }
        this.fail(item, { code, message, status }); failed++;                                  // the server said no: the person must look at it
        this.persist(); this.changed();
      }
    }
    return { sent, failed, remaining: this.pendingCount(), stopped };
  }
}
