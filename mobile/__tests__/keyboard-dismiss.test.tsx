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
test('while any box is being typed in (number pad or text), it shows a tick that closes the keyboard', () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  const pad = render(wrap(<Field label="Code" value="" onChangeText={() => {}} testID="code" keyboardType="number-pad" />));
  expect(pad.queryByTestId('code-done')).toBeNull();                      // not shown until the box is being typed in
  fireEvent(pad.getByTestId('code'), 'focus');
  fireEvent.press(pad.getByTestId('code-done'));
  expect(dismiss).toHaveBeenCalled();                                     // (the test's press reaches both layers of Paper's icon button; a real tap reaches one)
  fireEvent(pad.getByTestId('code'), 'blur');
  expect(pad.queryByTestId('code-done')).toBeNull();                      // and gone again when the keyboard closes

  const text = render(wrap(<Field label="Name" value="" onChangeText={() => {}} testID="name" kind="name" />));
  expect(text.queryByTestId('name-done')).toBeNull();                     // not shown until the box is being typed in
  fireEvent(text.getByTestId('name'), 'focus');
  fireEvent.press(text.getByTestId('name-done'));                         // a text box has the same tick, so every box closes the same way
  expect(dismiss).toHaveBeenCalled();
  fireEvent(text.getByTestId('name'), 'blur');
  expect(text.queryByTestId('name-done')).toBeNull();
  dismiss.mockRestore();
});

test('amount, mobile and code boxes all get the tick (they all use a number pad)', () => {
  for (const [id, props] of [['amount', { kind: 'amount' }], ['mobile', { kind: 'mobile' }], ['otp', { kind: 'otp' }]] as const) {
    const ui = render(wrap(<Field label={id} value="" onChangeText={() => {}} testID={id} {...props} />));
    fireEvent(ui.getByTestId(id), 'focus');
    expect(ui.getByTestId(`${id}-done`)).toBeTruthy();
  }
});

test('a multi-line box (address, notes, items provided) also gets the tick, since Return there only starts a new line', () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  const ui = render(wrap(<Field label="Address" value="" onChangeText={() => {}} testID="addr" kind="address" multiline />));
  expect(ui.queryByTestId('addr-done')).toBeNull();
  fireEvent(ui.getByTestId('addr'), 'focus');
  fireEvent.press(ui.getByTestId('addr-done'));
  expect(dismiss).toHaveBeenCalled();
  dismiss.mockRestore();
});

test('every kind of box shows the tick: text, name, address, email, document number, amount, day and multi-line', () => {
  for (const [id, props] of [['t', { kind: 'text' }], ['nm', { kind: 'name' }], ['ad', { kind: 'address', multiline: true }], ['em', { kind: 'email' }], ['pr', { kind: 'text', maxLength: 40 }],
                              ['am', { kind: 'amount' }], ['dy', { kind: 'day' }], ['ml', { multiline: true, lines: 3 }]] as const) {
    const ui = render(wrap(<Field label={id} value="" onChangeText={() => {}} testID={id} {...(props as any)} />));
    fireEvent(ui.getByTestId(id), 'focus');
    expect(ui.getByTestId(`${id}-done`)).toBeTruthy();
  }
});
