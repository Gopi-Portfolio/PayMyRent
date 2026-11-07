import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { HeroAction, MiniAction } from '@/components/QuickActions';

const wrap = (ui: React.ReactElement) => render(<PaperProvider>{ui}</PaperProvider>);

test('a big action card shows its name and what it is for, and opens on a tap', () => {
  const onPress = jest.fn();
  const ui = wrap(<HeroAction icon="hand-coin" label="Record Payment" sub="Receive cash in hand" colors={['#BE185D', '#F472B6']} onPress={onPress} testID="record-payment" />);
  expect(ui.getByText('Record Payment')).toBeTruthy();
  expect(ui.getByText('Receive cash in hand')).toBeTruthy();
  expect(ui.getByLabelText('Record Payment. Receive cash in hand')).toBeTruthy();
  fireEvent.press(ui.getByTestId('record-payment'));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('a small button shows a number only when something is waiting, and can be selected', () => {
  const none = wrap(<MiniAction icon="door-open" label="Vacant" fg="#7C3AED" bg="#EDE9FE" onPress={jest.fn()} testID="vacant" />);
  expect(none.queryByText('3')).toBeNull();
  const some = wrap(<MiniAction icon="door-open" label="Vacant" fg="#7C3AED" bg="#EDE9FE" count={3} active onPress={jest.fn()} testID="vacant-on" />);
  expect(some.getByText('3')).toBeTruthy();
  expect(some.getByTestId('vacant-on').props.accessibilityState.selected).toBe(true);
  expect(wrap(<MiniAction icon="x" label="Approvals" fg="#f00" bg="#fee" count={120} onPress={jest.fn()} />).getByText('99+')).toBeTruthy();
});

import { WideAction } from '@/components/QuickActions';

test('the Approvals row is always there: a number when charges wait, "All clear" when none do', () => {
  const waiting = wrap(<WideAction icon="clipboard-check" label="Approvals" sub="Charges your renters sent for your decision" fg="#DC2626" bg="#FEE2E2" count={4} clearText="All clear" onPress={jest.fn()} testID="approvals" />);
  expect(waiting.getByText('Approvals')).toBeTruthy();
  expect(waiting.getByTestId('approvals-count')).toBeTruthy();
  expect(waiting.getByText('4')).toBeTruthy();
  expect(waiting.queryByText('All clear')).toBeNull();
  const onPress = jest.fn();
  const clear = wrap(<WideAction icon="clipboard-check" label="Approvals" fg="#DC2626" bg="#FEE2E2" count={0} clearText="All clear" onPress={onPress} testID="approvals" />);
  expect(clear.getByText('Approvals')).toBeTruthy();                       // same row, same place, same look
  expect(clear.getByTestId('approvals-clear')).toBeTruthy();
  expect(clear.getByText('All clear')).toBeTruthy();
  fireEvent.press(clear.getByTestId('approvals'));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('a small button can show a green tick when nothing is waiting, so Approvals looks the same for everyone', () => {
  const waiting = wrap(<MiniAction icon="clipboard-check" label="Approvals" fg="#DC2626" bg="#FEE2E2" count={2} clearText="All clear" onPress={jest.fn()} testID="approvals" />);
  expect(waiting.getByTestId('mini-count')).toBeTruthy();
  expect(waiting.queryByTestId('mini-clear')).toBeNull();
  const clear = wrap(<MiniAction icon="clipboard-check" label="Approvals" fg="#DC2626" bg="#FEE2E2" count={0} clearText="All clear" onPress={jest.fn()} testID="approvals" />);
  expect(clear.getByTestId('mini-clear')).toBeTruthy();
  expect(clear.getByLabelText('Approvals, All clear')).toBeTruthy();
});

test('the Add Renter card shows "Vacant" next to the icon with the number under it', () => {
  const ui = wrap(<HeroAction icon="account-plus" label="Add Renter" sub="Invite a new renter" note={{ label: 'Vacant', value: 3 }} colors={['#0F766E', '#14B8A6']} onPress={jest.fn()} testID="add-tenant" />);
  expect(ui.getByTestId('hero-note')).toBeTruthy();
  expect(ui.getByText('Vacant')).toBeTruthy();                                   // the label next to the icon ...
  expect(ui.getByTestId('hero-note-value').props.children).toBe(3);              // ... and the number under it
  expect(ui.getByLabelText('Add Renter. Invite a new renter. 3 Vacant')).toBeTruthy();
  expect(wrap(<HeroAction icon="x" label="Record Payment" colors={['#000', '#111']} onPress={jest.fn()} />).queryByTestId('hero-note')).toBeNull();
});
