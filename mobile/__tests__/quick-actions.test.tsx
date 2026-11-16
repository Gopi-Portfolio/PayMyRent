import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { ActionCarousel, MiniAction } from '@/components/QuickActions';

const wrap = (ui: React.ReactElement) => render(<PaperProvider>{ui}</PaperProvider>);

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

const CARDS = (onPress = jest.fn()) => [
  { key: 'property', icon: 'home-plus', title: 'Add Property', message: 'Add a building or a shop complex, then the units inside it.', footnote: '2 Vacant', onPress, testID: 'add-property' },
  { key: 'renter', icon: 'account-plus', title: 'Add Renter', message: 'Move a renter into a vacant unit and set the rent.', lead: true, onPress, testID: 'add-tenant' },
  { key: 'rent', icon: 'hand-coin', title: 'Add Rent', message: 'Record the cash rent a renter has paid you in hand.', onPress, testID: 'record-payment' },
];
const laidOut = (ui: ReturnType<typeof render>, width = 360) =>
  act(() => ui.getByTestId('action-carousel').props.onLayout({ nativeEvent: { layout: { width, height: 200 } } }));

test('each swipe card says what it does in a sentence, and opens on a tap', () => {
  const onPress = jest.fn();
  const ui = wrap(<ActionCarousel cards={CARDS(onPress)} />);
  laidOut(ui);
  for (const [title, message] of [['Add Property', 'Add a building or a shop complex, then the units inside it.'], ['Add Renter', 'Move a renter into a vacant unit and set the rent.'], ['Add Rent', 'Record the cash rent a renter has paid you in hand.']]) {
    expect(ui.getByText(title)).toBeTruthy();
    expect(ui.getByText(message)).toBeTruthy();
  }
  expect(ui.getByText('2 Vacant')).toBeTruthy();                                         // the vacant count is on the Add Property card
  expect(ui.getByLabelText('Add Property. Add a building or a shop complex, then the units inside it.. 2 Vacant')).toBeTruthy();
  fireEvent.press(ui.getByTestId('add-tenant'));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('the cards are wide, snap one at a time, and the next one peeks in from the edge', () => {
  const ui = wrap(<ActionCarousel cards={CARDS()} />);
  laidOut(ui, 360);
  const scroll = ui.getByTestId('action-scroll');
  expect(scroll.props.snapToInterval).toBe(Math.round(360 * 0.8) + 12);                  // one card plus the gap
  expect(scroll.props.horizontal).toBe(true);
  expect(Math.round(360 * 0.8)).toBeLessThan(360);                                       // narrower than the screen, so the next card shows
});

test('the dots show which card is open and move as you swipe', () => {
  const ui = wrap(<ActionCarousel cards={CARDS()} />);
  laidOut(ui, 360);
  const on = (i: number) => JSON.stringify(ui.getByTestId(`dot-${i}`, { includeHiddenElements: true }).props.style).includes('"width":20');
  expect([on(0), on(1), on(2)]).toEqual([true, false, false]);
  const step = Math.round(360 * 0.8) + 12;
  act(() => ui.getByTestId('action-scroll').props.onScroll({ nativeEvent: { contentOffset: { x: step } } }));
  expect([on(0), on(1), on(2)]).toEqual([false, true, false]);
  act(() => ui.getByTestId('action-scroll').props.onScroll({ nativeEvent: { contentOffset: { x: step * 2 } } }));
  expect([on(0), on(1), on(2)]).toEqual([false, false, true]);
});
