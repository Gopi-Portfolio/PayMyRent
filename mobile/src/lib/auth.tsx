// Authentication. Production: Firebase Phone Auth (+91 OTP) — the backend verifies the Firebase
// ID token on every request. Local: a DEMO OTP simulator served by the API (never in production).
import * as SecureStore from 'expo-secure-store';
import { setActionCodesRequired } from './actionCodes';
import { markRegistered } from './landing';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, api } from './api';
import { registerPush, unregisterPush } from './push';
import { queryClient } from './queryClient';

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

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>('/api/v1/me');
      setAuthError(null);
      setMe(m);
      setActionCodesRequired(m.action_codes_required !== false);
      markRegistered();
      const saved = (await SecureStore.getItemAsync(ROLE_KEY)) as 'owner' | 'tenant' | null;
      setRole(saved && m.roles.includes(saved) ? saved : m.roles[0] ?? null);
      return m;
    } catch (e) {
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
        // e.g. Firebase not configured in this build: show the login screen instead of an endless spinner
        setAuthError(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

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
        body: { phone: s.phoneE164, code }, auth: linkToCurrent,
      });
      devToken = r.id_token;
      await SecureStore.setItemAsync(DEV_TOKEN_KEY, r.id_token);
    }
    if (!linkToCurrent) {
      await api('/api/v1/auth/session', { method: 'POST' });
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
