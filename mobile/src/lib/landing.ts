import * as SecureStore from 'expo-secure-store';

// Whether this phone has ever signed in to an account. It survives sign-out, so a returning person gets the quick sign-in buttons on the landing page.
const REGISTERED_KEY = 'rg.registered';
export async function markRegistered(): Promise<void> { try { await SecureStore.setItemAsync(REGISTERED_KEY, '1'); } catch { /* only the shortcut is lost */ } }
export async function loadRegistered(): Promise<boolean> { try { return (await SecureStore.getItemAsync(REGISTERED_KEY)) === '1'; } catch { return false; } }

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
export const setPendingRole = (r: 'owner' | 'tenant' | null) => { pendingRole = r; };
export const getPendingRole = () => pendingRole;
