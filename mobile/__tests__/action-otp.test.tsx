import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { ActionOtp, otpReady } from '@/components/ActionOtp';
import '@/i18n';

jest.mock('@/lib/api', () => ({ api: jest.fn(async () => ({ sent_to: '+91•••••8398', demo_code: '123456' })) }));

function Host({ onCode }: { onCode: (c: string) => void }) {
  const [code, setCode] = React.useState('');
  onCode(code);
  return <PaperProvider><ActionOtp action="property" code={code} onChange={setCode} /></PaperProvider>;
}

test('send a code, type it, and the code is ready to submit', async () => {
  let seen = '';
  const ui = render(<Host onCode={(c) => { seen = c; }} />);
  fireEvent.press(ui.getByTestId('otp-send-property'));
  await waitFor(() => ui.getByTestId('otp-property'));
  await act(async () => { fireEvent.changeText(ui.getByTestId('otp-property'), '123456'); });
  expect(seen).toBe('123456');
  expect(otpReady(seen)).toBe(true);
});

test('the confirmation code box has a tick to close the keyboard, and the keyboard closes by itself when all six digits are in', async () => {
  const { Keyboard } = require('react-native');
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  const ui = render(<Host onCode={() => {}} />);
  fireEvent.press(ui.getByTestId('otp-send-property'));
  await waitFor(() => ui.getByTestId('otp-property'));
  fireEvent(ui.getByTestId('otp-property'), 'focus');
  expect(ui.getByTestId('otp-property-done')).toBeTruthy();                      // a way to close the number pad that has no Return key
  fireEvent.press(ui.getByTestId('otp-property-done'));
  expect(dismiss).toHaveBeenCalledTimes(1);
  dismiss.mockClear();
  await act(async () => { fireEvent.changeText(ui.getByTestId('otp-property'), '12345'); });
  expect(dismiss).not.toHaveBeenCalled();                                         // five digits: still typing
  await act(async () => { fireEvent.changeText(ui.getByTestId('otp-property'), '123456'); });
  expect(dismiss).toHaveBeenCalledTimes(1);                                       // the sixth: the keyboard closes
  dismiss.mockRestore();
});
