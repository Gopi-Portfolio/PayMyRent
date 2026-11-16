// "All properties" or one property? The owner screens show every property together by default; picking one property narrows them to it.
// Anything that works on a single property (adding a renter, allotting, reports) needs one chosen, so those buttons ask first (askForProperty).
import * as SecureStore from 'expo-secure-store';
import React from 'react';

const KEY = 'rg.viewAll';
let viewAll = true;
let asking = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

try { SecureStore.getItemAsync(KEY).then((v) => { if (v === 'false') { viewAll = false; emit(); } }).catch(() => {}); } catch { /* the default (all) stays */ }

export function setViewAll(v: boolean): void {
  viewAll = v; asking = false; emit();
  try { SecureStore.setItemAsync(KEY, String(v)).catch(() => {}); } catch { /* not saved */ }
}
export const useViewAll = (): boolean => React.useSyncExternalStore(subscribe, () => viewAll, () => viewAll);

/** Opens the property list with a note to choose one. */
export function askForProperty(): void { asking = true; emit(); }
export function closePropertyAsk(): void { if (asking) { asking = false; emit(); } }
export const useAskingForProperty = (): boolean => React.useSyncExternalStore(subscribe, () => asking, () => asking);
