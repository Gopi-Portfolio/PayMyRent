import { act, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { NeedsInternet } from '@/components/NeedsInternet';
import { setOnline } from '@/lib/network';
import { fs, path } from '../test-support/files';
import '@/i18n';

beforeEach(() => setOnline(true));

test('online: nothing is shown', () => {
  expect(render(<PaperProvider><NeedsInternet /></PaperProvider>).queryByTestId('needs-internet')).toBeNull();
});

test('offline: a plain note says this screen needs the internet, and it goes away by itself when the connection returns', () => {
  const ui = render(<PaperProvider><NeedsInternet /></PaperProvider>);
  act(() => setOnline(false));
  expect(ui.getByText('This needs the internet. Please connect and try again.')).toBeTruthy();
  act(() => setOnline(true));
  expect(ui.queryByTestId('needs-internet')).toBeNull();
});

test('every screen that cannot work offline carries the note (payments, adding a property, import, the AI, messages that are translated, plans, ID and owner details)', () => {
  const screens = ['app/(app)/owner/record-payment.tsx', 'app/(app)/owner/add-property.tsx', 'app/(app)/owner/import.tsx', 'app/(app)/owner/ai.tsx', 'app/(app)/owner/message.tsx',
    'app/(app)/tenant/pay/index.tsx', 'app/(app)/tenant/pay/[id].tsx', 'app/(onboarding)/plan.tsx', 'app/(onboarding)/identity.tsx', 'app/(onboarding)/owner-details.tsx'];
  const missing = fs.walk(['app'], /\.tsx$/).filter((f) => screens.includes(path.rel(f).replace(/^mobile\//, '')) && !fs.read(f).includes('<NeedsInternet />'));
  expect(missing.map((f) => path.rel(f))).toEqual([]);
});
