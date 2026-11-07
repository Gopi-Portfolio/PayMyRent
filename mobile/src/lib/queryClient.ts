import { QueryClient } from '@tanstack/react-query';

/** One shared cache. Kept for 10 minutes after a screen leaves (memory), and wiped on sign-out (privacy). */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000, gcTime: 10 * 60_000 }, mutations: { retry: 0 } },
});
