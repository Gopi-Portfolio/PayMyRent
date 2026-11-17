// Authentication. Production: Firebase Phone Auth (+91 OTP) — the backend verifies the Firebase
// ID token on every request. Local: a DEMO OTP simulator served by the API (never in production).
import * as SecureStore from 'expo-secure-store';
import { setActionCodesRequired } from './actionCodes';
import { markRegistered } from './landing';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, api } from './api';
import { reportUnreachable } from './network';
import { getPendingPlan, getPendingRole } from './landing';
import { KEYS, clearOfflineData, switchUser } from './offlineData';
import { registerPush, unregisterPush } from './push';
import { queryClient } from './queryClient';
import { storage } from './storage';

const MODE = (process.env.EXPO_PUBLIC_AUTH_MODE ?? 'dev') as 'dev' | 'firebase';
const DEV_TOKEN_KEY = 'rg.devToken';
const ROLE_KEY = 'rg.activeRole';
const GENDER_KEY = 'rg.gender';
const OWNER_KEY = 'rg.ownerAccount';
let chosenOwner: string | null = null;      // the property (owner account) being worked on; read by ownerAccountId()
export type Gender = 'male' | 'female' | null;

let firebaseAuth: any = null;
if (MODE === 'firebase') {
  // Loaded lazily so Expo Go (dev mode) works without native Firebase modules.
  firebaseAuth = require('@react-native-firebase/auth').default;
}

let devToken: string | null = null;

export async function getIdToken(forceRefresh = false): Promise<string | null> {
  if (MODE === 'firebase') {
    const u = firebaseAuth().currentUser;
    return u ? u.getIdToken(forceRefresh) : null;
  }
  if (!devToken) devToken = await SecureStore.getItemAsync(DEV_TOKEN_KEY);
  return devToken;
}

export type Me = {
  id: string; full_name: string | null; address: string | null; preferred_language: string; profile_complete: boolean;
  version: number; roles: ('owner' | 'tenant')[];
  contacts: { id: string; kind: 'mobile' | 'email'; value: string; is_primary: boolean; verified: boolean; for_mobile_id?: string | null }[];
  notification_preferences: Record<string, any> | null;
  owner_accounts: { owner_account_id: string; role: string; state: 'active' | 'grace' | 'read_only' | 'none'; verification?: 'submitted' | 'verified' | 'rejected' | null;
    property_name?: string | null; property_address?: string | null; property_status?: 'submitted' | 'verified' | 'rejected' | null;
    property_count?: number; property_capacity?: number }[];     // how many properties this account holds, and how many its plan allows (Max: up to 100)
  pending_invitations: number; action_codes_required?: boolean; identity_status?: 'none' | 'pending' | 'verified' | 'manual_review' | 'failed' | 'rejected';
};

/** The door and plan chosen on the landing page. The server uses them to refuse a first-time owner who has not chosen a plan (no account, no token). */
function signInIntent(): { role?: 'owner' | 'tenant'; plan?: string } {
  const role = getPendingRole(), plan = getPendingPlan();
  return { ...(role ? { role } : {}), ...(plan ? { plan } : {}) };
}
type OtpSession = { phoneE164: string; confirm?: any; demoCode?: string };

type Ctx = {
  me: Me | null; loading: boolean; mode: typeof MODE; authError: unknown;
  activeRole: 'owner' | 'tenant' | null; setActiveRole: (r: 'owner' | 'tenant') => void;
  selectedOwner: string | null; selectOwner: (id: string) => void;     // the property (owner account) the owner is working on
  gender: Gender; setGender: (g: 'male' | 'female') => void;
  requestOtp: (phoneE164: string, linkToCurrent?: boolean) => Promise<OtpSession>;
  verifyOtp: (s: OtpSession, code: string, linkToCurrent?: boolean) => Promise<void>;
  refresh: () => Promise<Me | null>; signOut: () => Promise<void>;
};

const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<unknown>(null);
  const [activeRole, setRole] = useState<'owner' | 'tenant' | null>(null);
  const [gender, setGenderState] = useState<Gender>(null);
  const [selectedOwner, setSelectedOwnerState] = useState<string | null>(null);
  useEffect(() => { SecureStore.getItemAsync(OWNER_KEY).then((v) => { if (v) { chosenOwner = v; setSelectedOwnerState(v); } }).catch(() => {}); }, []);
  const selectOwner = useCallback((id: string) => { chosenOwner = id; setSelectedOwnerState(id); SecureStore.setItemAsync(OWNER_KEY, id).catch(() => {}); queryClient.invalidateQueries(); }, []);
  useEffect(() => { SecureStore.getItemAsync(GENDER_KEY).then((g) => { if (g === 'male' || g === 'female') setGenderState(g); }).catch(() => {}); }, []);
  const setGender = useCallback((g: 'male' | 'female') => { setGenderState(g); SecureStore.setItemAsync(GENDER_KEY, g).catch(() => {}); }, []);

  const apply = useCallback(async (m: Me) => {
    setAuthError(null);
    setMe(m);
    setActionCodesRequired(m.action_codes_required !== false);
    const saved = (await SecureStore.getItemAsync(ROLE_KEY)) as 'owner' | 'tenant' | null;
    setRole(saved && m.roles.includes(saved) ? saved : m.roles[0] ?? null);
  }, []);

  /** With no connection, the app opens as the person who was signed in last time, using the profile kept on the phone. */
  const openOffline = useCallback(async (): Promise<Me | null> => {
    const kept = await storage.getJson<Me>(KEYS.me);
    if (!kept) return null;
    reportUnreachable();
    await apply(kept);
    return kept;
  }, [apply]);

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>('/api/v1/me');
      await apply(m);
      markRegistered();
      void storage.setJson(KEYS.me, m);
      void switchUser(m.id).then((otherPerson) => { if (otherPerson) queryClient.clear(); });     // never show the previous person's saved data to this one
      return m;
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'OFFLINE' || e.code === 'TIMEOUT')) { const kept = await openOffline(); if (kept) return kept; }
      // keep network problems visible instead of silently dropping back to the login screen
      setAuthError(e instanceof ApiError && (e.code === 'OFFLINE' || e.code === 'TIMEOUT' || e.status >= 500) ? e : null);
      setMe(null);
      return null;
    }
  }, []);

  const roleRef = useRef<'owner' | 'tenant' | null>(null);
  roleRef.current = activeRole;
  useEffect(() => { if (me?.id) registerPush(() => roleRef.current); }, [me?.id]);     // this phone's push token goes to the server once signed in

  useEffect(() => {
    (async () => {
      try {
        if (await getIdToken()) await refresh();
      } catch (e) {
        // no connection and the sign-in token cannot be renewed right now: open with what is kept on the phone; otherwise (e.g. Firebase not configured
        // in this build) show the login screen instead of an endless spinner
        if (!(await openOffline())) setAuthError(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh, openOffline]);

  const requestOtp = useCallback(async (phoneE164: string, linkToCurrent = false): Promise<OtpSession> => {
    if (MODE === 'firebase') {
      const auth = firebaseAuth();
      if (linkToCurrent && auth.currentUser) {
        const verificationId = await auth.verifyPhoneNumber(phoneE164);
        return { phoneE164, confirm: verificationId };
      }
      return { phoneE164, confirm: await auth.signInWithPhoneNumber(phoneE164) };
    }
    const r = await api<{ demo_code: string }>('/api/v1/dev/otp/request', { body: { phone: phoneE164 }, auth: false });
    return { phoneE164, demoCode: r.demo_code };
  }, []);

  const verifyOtp = useCallback(async (s: OtpSession, code: string, linkToCurrent = false) => {
    if (MODE === 'firebase') {
      const auth = firebaseAuth();
      if (linkToCurrent) {
        // Change primary mobile: attach the new number to the SAME Firebase user (uid unchanged).
        const cred = firebaseAuth.PhoneAuthProvider.credential(s.confirm.verificationId ?? s.confirm, code);
        await auth.currentUser.updatePhoneNumber(cred);
      } else {
        await s.confirm.confirm(code);
      }
      await getIdToken(true);
    } else {
      const r = await api<{ id_token: string }>('/api/v1/dev/otp/verify', {
        body: { phone: s.phoneE164, code, ...(linkToCurrent ? {} : signInIntent()) }, auth: linkToCurrent,
      });
      devToken = r.id_token;
      await SecureStore.setItemAsync(DEV_TOKEN_KEY, r.id_token);
    }
    if (!linkToCurrent) {
      await api('/api/v1/auth/session', { method: 'POST', body: signInIntent() });
      await refresh();
    }
  }, [refresh]);

  const signOut = useCallback(async () => {
    await unregisterPush();            // while still signed in: this phone stops getting this person's alerts
    if (MODE === 'firebase') await firebaseAuth().signOut();
    devToken = null;
    await SecureStore.deleteItemAsync(DEV_TOKEN_KEY);
    chosenOwner = null; setSelectedOwnerState(null);
    await Promise.all([SecureStore.deleteItemAsync(ROLE_KEY), SecureStore.deleteItemAsync(GENDER_KEY), SecureStore.deleteItemAsync(OWNER_KEY)]).catch(() => {});
    queryClient.clear();            // nothing from this account may be visible to the next person who signs in on this phone
    await clearOfflineData();       // the saved cache, the saved profile and any entries still waiting to be sent
    setRole(null); setGenderState(null);
    setMe(null);
  }, []);

  const setActiveRole = useCallback((r: 'owner' | 'tenant') => {
    setRole(r);
    SecureStore.setItemAsync(ROLE_KEY, r);
  }, []);

  const value = useMemo(() => ({ me, loading, authError, mode: MODE, activeRole, setActiveRole, selectedOwner, selectOwner, gender, setGender, requestOtp, verifyOtp, refresh, signOut }),
    [me, loading, authError, activeRole, setActiveRole, selectedOwner, selectOwner, gender, setGender, requestOtp, verifyOtp, refresh, signOut]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): Ctx {
  const c = useContext(AuthCtx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}

export function ownerAccountId(me: Me | null): string | null {
  const mine = me?.owner_accounts ?? [];
  if (chosenOwner && mine.some((o) => o.owner_account_id === chosenOwner)) return chosenOwner;       // the property the owner picked
  return mine.find((o) => o.role === 'owner')?.owner_account_id ?? mine[0]?.owner_account_id ?? null;
}

/** The owner's properties for the dropdown and the totals. An account with no property in it (the empty one left after a property is removed) is not listed
 *  while another account has a property; a brand-new owner with none still sees the one starting account. */
export function ownerProperties(me: Me | null) {
  const mine = (me?.owner_accounts ?? []).filter((o) => o.role === 'owner' || o.role === 'co_owner');
  const has = (o: (typeof mine)[number]) => !!(o.property_name || o.property_address || o.property_status);
  return mine.some(has) ? mine.filter(has) : mine;
}
