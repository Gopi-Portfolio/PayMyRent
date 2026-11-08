import { pushRoute } from '@/lib/push';

const mockApi = jest.fn(async () => ({}));
jest.mock('@/lib/api', () => ({ api: (...a: any[]) => (mockApi as any)(...a) }));
jest.mock('@/lib/queryClient', () => ({ queryClient: { invalidateQueries: jest.fn() } }));

test('a push opens the screen that matches what it is about', () => {
  expect(pushRoute('transfer_reported', 'owner')).toBe('/(app)/owner/transfers');
  expect(pushRoute('relief_requested', 'owner')).toBe('/(app)/owner/relief');
  expect(pushRoute('payment_received', 'tenant')).toBe('/(app)/tenant');
  expect(pushRoute('transfer_rejected', 'tenant')).toBe('/(app)/tenant');
  expect(pushRoute(undefined, 'owner')).toBe('/(app)/owner');
  expect(pushRoute('anything_new', null)).toBe('/(app)/tenant');
});

test('without Firebase (Expo Go / dev mode) registering does nothing and asks for nothing', async () => {
  const { registerPush, unregisterPush } = require('@/lib/push');
  await registerPush(() => 'owner');
  await unregisterPush();
  expect(mockApi).not.toHaveBeenCalled();
});

test('with Firebase: asks permission, sends the token, and takes it back on sign-out', async () => {
  const handlers: Record<string, (x?: any) => void> = {};
  const messaging = () => ({
    requestPermission: async () => 1, getToken: async () => 'fcm-token-' + 'x'.repeat(40), deleteToken: jest.fn(async () => {}),
    onTokenRefresh: (f: any) => { handlers.refresh = f; }, onMessage: (f: any) => { handlers.message = f; },
    onNotificationOpenedApp: (f: any) => { handlers.opened = f; }, getInitialNotification: async () => null,
  });
  const push = jest.fn();
  jest.resetModules();
  process.env.EXPO_PUBLIC_AUTH_MODE = 'firebase';
  jest.doMock('@react-native-firebase/messaging', () => ({ default: messaging }), { virtual: true });
  jest.doMock('expo-router', () => ({ router: { push } }));
  jest.doMock('@/lib/api', () => ({ api: (...a: any[]) => (mockApi as any)(...a) }));
  jest.doMock('@/lib/queryClient', () => ({ queryClient: { invalidateQueries: jest.fn() } }));
  mockApi.mockClear();
  const { registerPush, unregisterPush } = require('@/lib/push');
  await registerPush(() => 'owner');
  expect(mockApi).toHaveBeenCalledWith('/api/v1/me/push-token', { body: { token: 'fcm-token-' + 'x'.repeat(40), platform: expect.stringMatching(/ios|android/) } });
  handlers.opened({ data: { template: 'transfer_reported' } });                              // the owner taps "payment reported"
  expect(push).toHaveBeenCalledWith('/(app)/owner/transfers');
  await unregisterPush();
  expect(mockApi).toHaveBeenCalledWith('/api/v1/me/push-token/remove', { body: { token: 'fcm-token-' + 'x'.repeat(40) } });
  delete process.env.EXPO_PUBLIC_AUTH_MODE;
});
