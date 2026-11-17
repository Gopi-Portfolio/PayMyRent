import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { DemoBanner } from '@/components/ui';
import '@/i18n';

// The heading in the top bar is named after the page. A page with no name falls back to "Home", so every page that can be opened needs a name.
let mockPath = '/search';
jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }, usePathname: () => mockPath, useFocusEffect: () => undefined }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/lib/api', () => ({ api: jest.fn(async () => ({ items: [], unread: 0 })), ApiError: class extends Error {} }));
jest.mock('@/lib/auth', () => ({
  useAuth: () => ({ me: { id: 'u1', roles: ['owner'], owner_accounts: [], profile_complete: true }, activeRole: 'owner', setActiveRole: jest.fn(), gender: null, signOut: jest.fn(), selectOwner: jest.fn() }),
  ownerAccountId: () => 'o1',
}));

const heading = (path: string) => {
  mockPath = path;
  const ui = render(<QueryClientProvider client={new QueryClient()}><PaperProvider><DemoBanner /></PaperProvider></QueryClientProvider>);
  return ui;
};

test.each([
  ['/search', 'SEARCH'],
  ['/owner/report/renters', 'ALL|Renters'],           // a two-word name is drawn on two lines
  ['/owner/report/properties', 'ALL|Properties'],
  ['/owner/report/units', 'UNITS'],
])('the heading on %s is %s, not Home', (path, name) => {
  const ui = heading(path);
  for (const line of name.split('|')) expect(ui.getAllByText(line).length).toBeGreaterThan(0);
  expect(ui.queryByText('HOME')).toBeNull();
});
