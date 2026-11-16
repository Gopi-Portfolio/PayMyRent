// Thin fetch wrapper. The server is authoritative for every amount and status; the app
// only displays what it returns and never sends prices or "paid" flags.
import { getRandomValues } from 'expo-crypto';

import i18n from '@/i18n';
import { getIdToken } from './auth';

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';
// A release build must talk to the server over HTTPS only (development builds may use a LAN address).
if (!__DEV__ && !API_URL.startsWith('https://')) throw new Error('EXPO_PUBLIC_API_URL must be an https:// address in a release build');

/** Server-provided links may say "localhost" (the API's own view). Point them at the address this app actually uses. */
export function reachable(url: string): string {
  try {
    const u = new URL(url);
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(u.hostname) ? `${API_URL}${u.pathname}${u.search}` : url;
  } catch { return url; }
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: { field: string; code: string }[],
              public details?: Record<string, unknown>) {
    super(message);
  }
}

type Opts = { method?: string; body?: unknown; form?: FormData; ownerAccount?: string | null; auth?: boolean; headers?: Record<string, string>; timeoutMs?: number;
              idempotencyKey?: string };   // data entry that may be sent twice (a retry, or a saved entry sent later): the server does it once per key

export async function api<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-App-Language': i18n.language, ...(opts.headers ?? {}) };   // the server writes in the language on screen
  if (opts.auth !== false) {
    const token = await getIdToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (opts.ownerAccount) headers['X-Owner-Account'] = opts.ownerAccount;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15000);
  try {
    res = await fetch(`${API_URL}${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal: ctl.signal });
  } catch (e) {
    const aborted = (e as { name?: string })?.name === 'AbortError';
    // what the person sees is plain and translated; the technical hint for a developer goes to the console only
    if (__DEV__) console.warn(`[api] ${aborted ? 'no reply from' : 'cannot reach'} ${API_URL}${path} (${(e as Error)?.name}: ${(e as Error)?.message}): check that the API is running and that EXPO_PUBLIC_API_URL in mobile/.env is this computer's current IP`);
    throw new ApiError(0, aborted ? 'TIMEOUT' : 'OFFLINE', i18n.t(aborted ? 'error.timeout' : 'error.offline'));
  } finally { clearTimeout(timer); }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? res.statusText, e.fields, e.details);
  }
  return data as T;
}

function safeJson(t: string) {
  try { return JSON.parse(t); } catch { return { raw: t }; }
}

/** Random idempotency key, created once per user intent (kept in component state across retries). */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  // Use expo-crypto directly: SDK 58 no longer guarantees a global crypto polyfill.
  getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
