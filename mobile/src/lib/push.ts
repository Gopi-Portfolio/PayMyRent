// Phone push (Firebase Cloud Messaging). After sign-in the app gets this phone's token and gives it to the server; on sign-out it takes it back.
// A push shows only a short text. Tapping it opens the right screen. Push needs a build with Firebase (not Expo Go), so in dev mode this does nothing.
import { Platform } from 'react-native';

import { api } from './api';
import { queryClient } from './queryClient';

const FIREBASE = process.env.EXPO_PUBLIC_AUTH_MODE === 'firebase';
let messaging: any = null;
let lastToken: string | null = null;
let listening = false;

function fcm(): any {
  if (!FIREBASE) return null;
  if (messaging === null) {
    try { messaging = require('@react-native-firebase/messaging').default; } catch { messaging = false; }   // the build has no messaging module
  }
  return messaging || null;
}

/** Which screen a push opens. The push carries only the kind of message (the template), never amounts or names. */
export function pushRoute(template: string | undefined, role: 'owner' | 'tenant' | null): string {
  switch (template) {
    case 'transfer_reported': return '/(app)/owner/transfers';
    case 'relief_requested': return '/(app)/owner/relief';
    case 'vacate_requested': return '/(app)/owner/vacate';
    default: return role === 'owner' ? '/(app)/owner' : '/(app)/tenant';
  }
}

async function send(token: string) {
  lastToken = token;
  await api('/api/v1/me/push-token', { body: { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' } });
}

export async function registerPush(getRole: () => 'owner' | 'tenant' | null): Promise<void> {
  const m = fcm();
  if (!m) return;
  try {
    const status = await m().requestPermission();
    const allowed = status === 1 || status === 2 || status === true;      // authorized / provisional (iOS), granted (Android)
    if (!allowed) return;
    await send(await m().getToken());
    if (listening) return;
    listening = true;
    const open = (msg: any) => {
      if (!msg) return;
      const { router } = require('expo-router');
      router.push(pushRoute(msg.data?.template, getRole()));
    };
    m().onTokenRefresh((t: string) => { send(t).catch(() => {}); });
    m().onMessage(() => { queryClient.invalidateQueries(); });             // app open: the bell and lists refresh by themselves
    m().onNotificationOpenedApp(open);
    m().getInitialNotification().then(open).catch(() => {});             // the app was opened by tapping a push
  } catch { /* no permission or no network: the app works the same without push */ }
}

/** Sign-out: this phone stops receiving this person's alerts. Call before the sign-in token is dropped. */
export async function unregisterPush(): Promise<void> {
  const m = fcm();
  if (!m || !lastToken) return;
  const token = lastToken;
  lastToken = null;
  try { await api('/api/v1/me/push-token/remove', { body: { token } }); await m().deleteToken(); } catch { /* best effort */ }
}
