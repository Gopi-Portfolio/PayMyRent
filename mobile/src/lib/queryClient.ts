import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient } from '@tanstack/react-query';

import { KEYS, registerCleaner } from './offlineData';

/** How long a saved screen can still be shown after the app is closed: a day. Anything older is dropped. */
export const CACHE_MAX_AGE = 24 * 3600 * 1000;

/** One shared cache. Kept on the phone for a day so screens still open with no connection, and wiped on sign-out (privacy). */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000, gcTime: CACHE_MAX_AGE }, mutations: { retry: 0 } },
});

export const persister = createAsyncStoragePersister({ storage: AsyncStorage, key: KEYS.queryCache, throttleTime: 1500 });
registerCleaner(async () => { queryClient.clear(); await persister.removeClient(); });

/** Answers about other people (is this number's ID verified?) are never written to the phone. */
const NOT_SAVED = new Set(['renter-check']);
export const shouldSave = (query: { state: { status: string }; queryKey: readonly unknown[] }) => query.state.status === 'success' && !NOT_SAVED.has(String(query.queryKey[0]));
