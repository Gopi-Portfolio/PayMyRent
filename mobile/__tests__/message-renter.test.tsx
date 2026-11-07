import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { LanguageSelect } from '@/components/LanguageSelect';
import MessageRenter from '../app/(app)/owner/message';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('@/lib/api', () => {
  function ApiError(this: any, status: number, code: string, message: string) { this.status = status; this.code = code; this.message = message; }
  ApiError.prototype = Object.create(Error.prototype);
  return { api: jest.fn(), ApiError, newIdempotencyKey: () => 'key-' + Math.random().toString(36).slice(2, 12) };
});
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: { owner_accounts: [] } }), ownerAccountId: () => 'o1' }));
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ tenancyId: 't1' }), router: { push: jest.fn() } }));
jest.mock('@/components/ui', () => {
  const R = require('react'); const RN = require('react-native'); const a = jest.requireActual('@/components/ui');
  return { ...a, Screen: ({ children }: any) => R.createElement(RN.View, null, children) };       // the page frame (top bar etc.) is not what is tested here
});

const mockApi = api as jest.Mock;
const wrap = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PaperProvider><MessageRenter /></PaperProvider></QueryClientProvider>);
const serve = (translate: () => Promise<any> | any) => mockApi.mockImplementation(async (path: string, opts?: any) => {
  if (path.includes('/message-info')) return { renter_name: 'Ravi Kumar', unit: 'S-01', renter_language: 'ta', can_message: true };
  if (path.includes('/messages/channels')) return { bell: { available: true, mode: 'live' }, sms: { available: true, mode: 'test' }, whatsapp: { available: false, mode: 'not_connected' } };
  if (path.includes('/messages/translate')) return translate();
  if (path.endsWith('/messages') && opts?.body) return { id: 'm1', status: 'queued' };
  if (path.includes('/messages')) return { items: [] };
  return {};
});
beforeEach(() => mockApi.mockReset());

test('speak or type, pick the language, check the translation, choose SMS, send', async () => {
  serve(() => ({ translation: '[ta] Rent is due', back_translation: '[en] Rent is due', numbers_ok: true, same_language: false }));
  const ui = wrap();
  await waitFor(() => expect(ui.getByText(/Ravi Kumar/)).toBeTruthy());
  expect(ui.getByLabelText('Send in: தமிழ்')).toBeTruthy();                                // starts on the renter's own language
  fireEvent.changeText(ui.getByTestId('message-text'), 'Rent is due');
  await act(async () => { fireEvent.press(ui.getByTestId('translate')); });
  await waitFor(() => expect(ui.getByTestId('final-text').props.value).toBe('[ta] Rent is due'));
  expect(ui.getByTestId('check-back')).toBeTruthy();                                       // what it says back, in my language
  expect(ui.getByText('[en] Rent is due')).toBeTruthy();
  expect(ui.getByTestId('channel-whatsapp').props.accessibilityState.disabled).toBe(true);  // not connected yet
  fireEvent.press(ui.getByTestId('channel-sms'));
  await act(async () => { fireEvent.press(ui.getByTestId('send-message')); });
  await waitFor(() => expect(ui.getByTestId('sent-ok')).toBeTruthy());
  const post = mockApi.mock.calls.find(([p, o]) => p.endsWith('/messages') && o?.body);
  expect(post[1].body).toMatchObject({ text: '[ta] Rent is due', original_text: 'Rent is due', from_lang: 'en', to_lang: 'ta', input_method: 'typed', channels: ['sms'] });
});

test('changing "Send in" after writing translates again into the new language', async () => {
  const calls: string[] = [];
  serve(() => { const to = calls.length; calls.push(String(to)); return { translation: `[x${to}] hello`, back_translation: null, numbers_ok: true, same_language: false }; });
  const ui = wrap();
  await waitFor(() => expect(ui.getByText(/Ravi Kumar/)).toBeTruthy());
  fireEvent.changeText(ui.getByTestId('message-text'), 'hello');
  await act(async () => { fireEvent.press(ui.getByTestId('translate')); });
  await waitFor(() => expect(ui.getByTestId('final-text').props.value).toBe('[x0] hello'));
  fireEvent.press(ui.getByTestId('lang-to-box'));
  await act(async () => { fireEvent.press(ui.getByTestId('lang-to-hi')); });
  await waitFor(() => expect(ui.getByTestId('final-text').props.value).toBe('[x1] hello'));
  const second = mockApi.mock.calls.filter(([p]) => p.includes('/messages/translate'))[1][1].body;
  expect(second).toMatchObject({ from_lang: 'en', to_lang: 'hi', text: 'hello' });
});

test('when translation is not in the plan the message can still be sent as written', async () => {
  const { ApiError } = jest.requireMock('@/lib/api');
  serve(() => { throw new ApiError(402, 'AI_FEATURE_NOT_IN_PLAN', 'AI is available on Growth and Business plans'); });
  const ui = wrap();
  await waitFor(() => expect(ui.getByText(/Ravi Kumar/)).toBeTruthy());
  fireEvent.changeText(ui.getByTestId('message-text'), 'Please call me');
  await act(async () => { fireEvent.press(ui.getByTestId('translate')); });
  await waitFor(() => expect(ui.getByTestId('send-as-is')).toBeTruthy());
  fireEvent.press(ui.getByTestId('send-as-is'));
  expect(ui.getByTestId('final-text').props.value).toBe('Please call me');
  await act(async () => { fireEvent.press(ui.getByTestId('send-message')); });
  const post = mockApi.mock.calls.find(([p, o]) => p.endsWith('/messages') && o?.body);
  expect(post[1].body).toMatchObject({ text: 'Please call me', from_lang: 'en', to_lang: 'en', channels: [] });          // sent in the language it was written
});

test('a language dropdown lists the 8 languages by their own names and reports the choice', () => {
  const onChange = jest.fn();
  const ui = render(<PaperProvider><LanguageSelect label="Send in" value="en" onChange={onChange} testID="pick" /></PaperProvider>);
  fireEvent.press(ui.getByTestId('pick-box'));
  for (const c of ['en', 'ta', 'hi', 'te', 'kn', 'ml', 'mr', 'bn']) expect(ui.getByTestId(`pick-${c}`)).toBeTruthy();
  expect(ui.getByText('தமிழ்')).toBeTruthy();
  fireEvent.press(ui.getByTestId('pick-hi'));
  expect(onChange).toHaveBeenCalledWith('hi');
});
