// Offline capture, put together: the queue (outbox.ts) wired to the real API, the phone's connection (network.ts) and the app's life
// (opening, coming back to the front, the connection returning).
//
// A screen that saves data calls submitOrQueue():
//   online  -> it is sent at once, exactly as before;
//   offline -> it is kept on the phone, shown as "waiting to send", and sent by itself when the connection is back.
// If a request is sent while online but the reply never comes, it is queued with the SAME key, so the server still does it only once.
import React from 'react';
import { AppState } from 'react-native';

import i18n from '@/i18n';

import { API_URL, ApiError, api, newIdempotencyKey } from './api';
import { isOnline, onReconnect, reportUnreachable, setOnline } from './network';
import { KEYS, registerCleaner } from './offlineData';
import { Outbox, OutboxFullError, type EnqueueInput, type OutboxItem } from './outbox';
import { queryClient } from './queryClient';
import { storage } from './storage';
import { showToast } from './toast';

export { OutboxFullError, localId, isLocalId } from './outbox';
export type { OutboxItem } from './outbox';

export const outbox = new Outbox({
  storage,
  keyFor: KEYS.outbox,
  send: (item) => api(item.path, { method: item.method, body: item.body, ownerAccount: item.ownerAccount, idempotencyKey: item.idempotencyKey }),
  isOnline,
  newId: newIdempotencyKey,
});
// signing out: finish any write to the phone that is still in flight FIRST, so it cannot land after the wipe and bring the old person's entries back
registerCleaner(async () => { await outbox.idle(); outbox.clear(); });

export type Submission = Pick<EnqueueInput, 'kind' | 'label' | 'path' | 'method' | 'body' | 'ownerAccount' | 'coalesceKey'> & {
  /** Runs only when the entry was saved for later: shows it in the screens' saved data (for example the unit as "rented", marked waiting). */
  optimistic?: (item: OutboxItem) => void;
};
export type Submitted<T> = { queued: false; result: T } | { queued: true; item: OutboxItem };

export async function submitOrQueue<T = any>(spec: Submission): Promise<Submitted<T>> {
  const key = newIdempotencyKey();
  // an entry that points at something another waiting entry creates ("local-...") can only be sent behind it, so it always goes through the queue
  const behindAnother = /local-[A-Za-z0-9_-]+/.test(`${spec.path}\n${JSON.stringify(spec.body ?? null)}`);
  if (isOnline() && !behindAnother) {
    try {
      const result = await api<T>(spec.path, { method: spec.method, body: spec.body, ownerAccount: spec.ownerAccount, idempotencyKey: key });
      return { queued: false, result };
    } catch (e) {
      // anything the server answered (a refusal, a validation message) is shown as before; only "could not reach it" is saved for later
      if (!(e instanceof ApiError && (e.code === 'OFFLINE' || e.code === 'TIMEOUT'))) throw e;
      reportUnreachable();
    }
  }
  let item: OutboxItem;
  try {
    item = outbox.enqueue({ kind: spec.kind, label: spec.label, path: spec.path, method: spec.method, body: spec.body, ownerAccount: spec.ownerAccount, coalesceKey: spec.coalesceKey, idempotencyKey: key });
  } catch (e) {
    if (e instanceof OutboxFullError) throw new Error(i18n.t('offline.tooMany'));
    throw e;
  }
  spec.optimistic?.(item);
  if (isOnline()) void syncNow();                                   // online but waiting behind another entry: it goes right after it
  else showToast(i18n.t('offline.savedOffline'));
  return { queued: true, item };
}

/** Send what is waiting now. Refreshes the screens' data when something went through. */
export async function syncNow(opts: { force?: boolean } = {}) {
  const result = await outbox.flush(opts);
  if (result.sent > 0) queryClient.invalidateQueries();
  return result;
}

/** The phone may say "offline" while the server is in fact reachable (or the other way round), so a quiet check settles it. */
async function probe(): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try { await fetch(`${API_URL}/api/v1/plans`, { signal: ctl.signal }); setOnline(true); } catch { /* still unreachable */ } finally { clearTimeout(timer); }
}

/** Sends saved entries when it is right to: when the connection returns, when the app comes to the front, and every 20 seconds while something waits.
 *  (The phone's own connection state is followed by startNetworkMonitor in the root layout.) Returns the function that stops it. */
export function startOfflineSync(): () => void {
  const stopReconnect = onReconnect(() => { void syncNow(); });
  const appState = AppState.addEventListener('change', (s) => { if (s === 'active') void tick(); });
  const timer = setInterval(() => { void tick(); }, 20_000);
  async function tick() {
    if (!isOnline()) await probe();                         // a way back online even if the phone never announces it
    if (isOnline() && outbox.pendingCount() > 0) await syncNow();
  }
  void tick();
  return () => { stopReconnect(); appState.remove(); clearInterval(timer); };
}

/** What the screens show: the saved entries and how they are doing. */
export function useOutbox() {
  const items = React.useSyncExternalStore(outbox.subscribe, outbox.getSnapshot, outbox.getSnapshot);
  return {
    items,
    pending: items.filter((i) => i.status === 'pending').length,
    failed: items.filter((i) => i.status === 'failed').length,
    sending: outbox.isSending(),
    authBlocked: outbox.authBlocked,
  };
}
