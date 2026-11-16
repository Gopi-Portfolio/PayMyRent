import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Keyboard, Platform } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { Field } from '@/components/ui';
import '@/i18n';

const wrap = (ui: React.ReactElement) => <PaperProvider>{ui}</PaperProvider>;
const input = (ui: ReturnType<typeof render>, id: string) => ui.getByTestId(id);

test('every kind of form field can be closed: Return on text boxes, a Done bar on number pads and multi-line boxes', () => {
  const cases: [string, any][] = [
    ['text', { kind: 'name' }], ['amount', { kind: 'amount' }], ['otp', { kind: 'otp' }], ['mobile', { kind: 'mobile' }],
    ['date', { kind: 'date' }], ['day', { kind: 'day' }], ['address', { kind: 'address', multiline: true }],
  ];
  for (const [id, props] of cases) {
    const ui = render(wrap(<Field label={id} value="" onChangeText={() => {}} testID={id} {...props} />));
    const p = input(ui, id).props;
    if (props.multiline) {
      expect(p.returnKeyType).toBeUndefined();                        // Return is a new line here ...
      if (Platform.OS === 'ios') expect(p.inputAccessoryViewID).toBeTruthy();   // ... so a Done bar closes it
    } else {
      expect(p.returnKeyType).toBe('done');
      expect(p.blurOnSubmit).toBe(true);
      const numberPad = ['number-pad', 'decimal-pad', 'phone-pad'].includes(p.keyboardType);
      if (numberPad && Platform.OS === 'ios') expect(p.inputAccessoryViewID).toBeTruthy();   // number pads have no Return key
    }
  }
});

test('pressing Return on a single-line field closes the keyboard', () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
  const ui = render(wrap(<Field label="Name" value="" onChangeText={() => {}} testID="n" kind="name" />));
  ui.getByTestId('n').props.onSubmitEditing();
  expect(dismiss).toHaveBeenCalled();
});

// The bar above the iOS keyboard is not reliable, so a number pad also has a tick inside the box that closes the keyboard, on any phone.
test('while a number pad is open, the box shows a tick that closes the keyboard; a text box has none', () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  const pad = render(wrap(<Field label="Code" value="" onChangeText={() => {}} testID="code" keyboardType="number-pad" />));
  expect(pad.queryByTestId('code-done')).toBeNull();                      // not shown until the box is being typed in
  fireEvent(pad.getByTestId('code'), 'focus');
  fireEvent.press(pad.getByTestId('code-done'));
  expect(dismiss).toHaveBeenCalled();                                     // (the test's press reaches both layers of Paper's icon button; a real tap reaches one)
  fireEvent(pad.getByTestId('code'), 'blur');
  expect(pad.queryByTestId('code-done')).toBeNull();                      // and gone again when the keyboard closes

  const text = render(wrap(<Field label="Name" value="" onChangeText={() => {}} testID="name" kind="name" />));
  fireEvent(text.getByTestId('name'), 'focus');
  expect(text.queryByTestId('name-done')).toBeNull();                     // a text keyboard has its own Done key
  dismiss.mockRestore();
});

test('amount, mobile and code boxes all get the tick (they all use a number pad)', () => {
  for (const [id, props] of [['amount', { kind: 'amount' }], ['mobile', { kind: 'mobile' }], ['otp', { kind: 'otp' }]] as const) {
    const ui = render(wrap(<Field label={id} value="" onChangeText={() => {}} testID={id} {...props} />));
    fireEvent(ui.getByTestId(id), 'focus');
    expect(ui.getByTestId(`${id}-done`)).toBeTruthy();
  }
});
