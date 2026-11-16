// Everything the phone keeps for offline use belongs to the person signed in, so it is all removed when they sign out
// (or when a different person signs in): nothing from one account may ever be seen by the next.
import { storage } from './storage';

export const KEYS = {
  queryCache: 'rg-query-cache',
  me: 'rg-offline-me',
  lastUser: 'rg-offline-last-user',
  outbox: (userId: string) => `rg-outbox-v1-${userId}`,
};

const cleaners = new Set<() => void | Promise<void>>();
/** Other parts (the queue in memory, the saved cache) register how to forget their own data. */
export function registerCleaner(fn: () => void | Promise<void>): () => void { cleaners.add(fn); return () => { cleaners.delete(fn); }; }

export async function clearOfflineData(userId?: string | null): Promise<void> {
  const who = userId ?? (await storage.getJson<string>(KEYS.lastUser));
  await Promise.all([...cleaners].map((c) => Promise.resolve().then(c).catch(() => undefined)));
  await Promise.all([storage.remove(KEYS.queryCache), storage.remove(KEYS.me), storage.remove(KEYS.lastUser), who ? storage.remove(KEYS.outbox(who)) : Promise.resolve()]);
}

/** The person last seen on this phone. If someone else signs in, the old person's saved data is removed first. */
export async function switchUser(userId: string): Promise<boolean> {
  const last = await storage.getJson<string>(KEYS.lastUser);
  const changed = !!last && last !== userId;
  if (changed) await clearOfflineData(last);
  await storage.setJson(KEYS.lastUser, userId);
  return changed;
}
