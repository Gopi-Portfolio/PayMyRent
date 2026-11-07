import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import Phone from '../app/(public)/phone';
import '@/i18n';

const mockRouter = { canGoBack: jest.fn(() => true), back: jest.fn(), replace: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({ usePathname: () => '/phone', get router() { return mockRouter; }, useFocusEffect: () => undefined }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ requestOtp: jest.fn(), me: null }) }));

test('the mobile-number screen has a visible Back button under Send OTP that goes back to the plans', () => {
  const ui = render(<PaperProvider><Phone /></PaperProvider>);
  expect(ui.getByText('Send OTP')).toBeTruthy();
  fireEvent.press(ui.getByTestId('back-below'));
  expect(ui.getByText('Back')).toBeTruthy();
  expect(mockRouter.back).toHaveBeenCalledTimes(1);
});


// React Native's own rule: a bare string directly inside a View is an error on the phone ("Text strings must be rendered within a <Text> component")
function strayStrings(node: any, parent = 'root', out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === 'string') { if (!/^(Text|TextInput|RNText|Animated\.Text|ExpoLinearGradient)$/.test(parent) && !parent.includes('Text')) out.push(`"${node}" inside ${parent}`); return out; }
  (Array.isArray(node) ? node : [node]).forEach((n) => { if (typeof n === 'string') strayStrings(n, parent, out); else if (n) (n.children ?? []).forEach((c: any) => strayStrings(c, n.type, out)); });
  return out;
}

test('the mobile-number screen draws no bare text outside a text element', () => {
  const ui = render(<PaperProvider><Phone /></PaperProvider>);
  expect(strayStrings(ui.toJSON())).toEqual([]);
});
