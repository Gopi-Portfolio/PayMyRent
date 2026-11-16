// Is the phone online? One answer for the whole app, fed by the phone's own connection state and by what actually happens to requests.
// It also tells react-query, so saved screens stay quietly on screen while offline and refresh by themselves when the connection is back.
import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import React from 'react';

let online = true;
const watchers = new Set<() => void>();
const reconnectors = new Set<() => void>();

export const isOnline = () => online;

export function setOnline(value: boolean): void {
  if (value === online) return;
  online = value;
  onlineManager.setOnline(value);
  watchers.forEach((w) => w());
  if (value) reconnectors.forEach((r) => r());
}

/** A request failed because the server could not be reached: from now on the app behaves as offline until a probe or the phone says otherwise. */
export const reportUnreachable = () => setOnline(false);

export function onReconnect(fn: () => void): () => void { reconnectors.add(fn); return () => { reconnectors.delete(fn); }; }
const subscribe = (fn: () => void) => { watchers.add(fn); return () => { watchers.delete(fn); }; };
export function useOnline(): boolean { return React.useSyncExternalStore(subscribe, isOnline, isOnline); }

/** Starts listening to the phone's connection. Returns the function that stops it.
 *  "No connection at all" is believed at once. But "connected, internet not confirmed" is often a false alarm (a simulator, a slow Wi-Fi check),
 *  so the app's own server is asked before the phone is called offline: a banner that says "no internet" while it works is worse than a short wait. */
export function startNetworkMonitor(): () => void {
  let seq = 0;
  return NetInfo.addEventListener((s) => {
    const mine = ++seq;
    if (s.isConnected === false) { setOnline(false); return; }
    if (s.isInternetReachable !== false) { setOnline(true); return; }
    const url = `${process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000'}/api/v1/plans`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    fetch(url, { signal: ctl.signal }).then(() => { if (mine === seq) setOnline(true); }, () => { if (mine === seq) setOnline(false); }).finally(() => clearTimeout(timer));
  });
}
