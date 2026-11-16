// One short message at the bottom of the screen ("Saved on this phone ..."), shown for a few seconds, from anywhere in the app.
import React from 'react';

let message: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const watchers = new Set<() => void>();
const notify = () => watchers.forEach((w) => w());
const subscribe = (fn: () => void) => { watchers.add(fn); return () => { watchers.delete(fn); }; };

export function showToast(text: string, ms = 5000): void {
  message = text; notify();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { message = null; notify(); }, ms);
}
export const hideToast = () => { if (timer) clearTimeout(timer); message = null; notify(); };
export const currentToast = () => message;
export function useToast(): string | null { return React.useSyncExternalStore(subscribe, currentToast, currentToast); }
