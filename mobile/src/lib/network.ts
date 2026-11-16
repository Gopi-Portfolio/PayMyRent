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

/** Starts listening to the phone's connection. Returns the function that stops it. */
export function startNetworkMonitor(): () => void {
  return NetInfo.addEventListener((s) => setOnline(s.isConnected !== false && s.isInternetReachable !== false));
}
