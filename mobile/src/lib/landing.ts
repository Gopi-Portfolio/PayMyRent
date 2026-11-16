import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

// Whether this phone has ever signed in to an account. It survives sign-out, so a returning person gets the quick sign-in buttons on the landing page.
const REGISTERED_KEY = 'rg.registered';
export async function markRegistered(): Promise<void> { try { await SecureStore.setItemAsync(REGISTERED_KEY, '1'); } catch { /* only the shortcut is lost */ } }

// The landing page is the first screen of every app launch; once the user taps through, '/' goes to their home.
let seen = false;
export const landingSeen = () => seen;
export const markLandingSeen = () => { seen = true; };

// The plan a visitor tapped on the landing page; the plan screen preselects it after sign-in and owner setup.
let pendingPlan: string | null = null;
export const setPendingPlan = (code: string | null) => { pendingPlan = code; };
export const getPendingPlan = () => pendingPlan;

// Which door a visitor used on the landing page ("I'm an owner" / "I'm a renter"). The role screen after the first sign-in uses it, so they are not asked twice.
let pendingRole: 'owner' | 'tenant' | null = null;
const roleListeners = new Set<() => void>();
export const setPendingRole = (r: 'owner' | 'tenant' | null) => { pendingRole = r; roleListeners.forEach((l) => l()); };
export const getPendingRole = () => pendingRole;
/** Re-renders the caller when the door changes, so the sign-in pages can take the colour of the chosen role (owner green, renter blue). */
export const usePendingRole = () => useSyncExternalStore((l) => { roleListeners.add(l); return () => { roleListeners.delete(l); }; }, getPendingRole, getPendingRole);

// The full name typed on the mobile number screen. It is held here until the person has signed in, then the profile step starts with it filled in.
let pendingName = '';
export const setPendingName = (n: string) => { pendingName = n; };
export const getPendingName = () => pendingName;
