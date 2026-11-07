import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { Field } from '@/components/ui';
import '@/i18n';

function Host({ kind, max, maxNumber, min, seen }: { kind: 'amount' | 'day'; max?: number; maxNumber?: number; min?: number; seen: { v: string } }) {
  const [v, setV] = React.useState('');
  seen.v = v;
  return <PaperProvider><Field label="Box" testID="box" value={v} onChangeText={setV} kind={kind} maxPaise={max} maxNumber={maxNumber} min={min} /></PaperProvider>;
}

test('an amount box that allows up to Rs 5,000 stops at 5,000 however much is typed', () => {
  const seen = { v: '' };
  const ui = render(<Host kind="amount" max={500000} seen={seen} />);
  fireEvent.changeText(ui.getByTestId('box'), '1000000');
  expect(seen.v).toBe('5000');
  expect(ui.getByTestId('field-limit')).toBeTruthy();
  fireEvent.changeText(ui.getByTestId('box'), '4999.50');
  expect(seen.v).toBe('4999.50');                                            // below the limit is left alone
});

test('with no limit given, an amount box still stops at the server ceiling of Rs 1,00,00,000', () => {
  const seen = { v: '' };
  const ui = render(<Host kind="amount" seen={seen} />);
  fireEvent.changeText(ui.getByTestId('box'), '999999999');
  expect(seen.v).toBe('10000000');
});

test('a day box stays between 1 and 31', () => {
  const seen = { v: '' };
  const ui = render(<Host kind="day" maxNumber={31} min={1} seen={seen} />);
  fireEvent.changeText(ui.getByTestId('box'), '99');
  expect(seen.v).toBe('31');
  fireEvent.changeText(ui.getByTestId('box'), '0');
  expect(seen.v).toBe('1');
});
