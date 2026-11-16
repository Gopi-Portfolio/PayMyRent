import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { LinearGradient } from 'expo-linear-gradient';
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
  { key: 'property', icon: 'home-plus', title: 'Add Property', message: 'Add a building or a shop complex, then the units inside it.', footnote: '2 Vacant', colors: ['#176F01', '#1F8A02'] as const, onPress, testID: 'add-property' },
  { key: 'renter', icon: 'account-plus', title: 'Add Renter', message: "Record a renter's name, mobile, address and photo ID.", colors: ['#00346F', '#0B58A8'] as const, onPress, testID: 'add-tenant' },
  { key: 'allot', icon: 'home-account', title: 'Allot Renter', message: 'Give a new renter a property and unit, set the rent, and tell them by SMS, WhatsApp and email.', colors: ['#E0620C', '#F97A1B'] as const, onPress, testID: 'allot-renter' },
];
const laidOut = (ui: ReturnType<typeof render>, width = 360) =>
  act(() => ui.getByTestId('action-carousel').props.onLayout({ nativeEvent: { layout: { width, height: 200 } } }));

test('each swipe card says what it does in a sentence, and opens on a tap', () => {
  const onPress = jest.fn();
  const ui = wrap(<ActionCarousel cards={CARDS(onPress)} />);
  laidOut(ui);
  for (const [title, message] of [['Add Property', 'Add a building or a shop complex, then the units inside it.'], ['Add Renter', "Record a renter's name, mobile, address and photo ID."], ['Allot Renter', 'Give a new renter a property and unit, set the rent, and tell them by SMS, WhatsApp and email.']]) {
    expect(ui.getByText(title)).toBeTruthy();
    expect(ui.getByText(message)).toBeTruthy();
  }
  expect(ui.getByText('2 Vacant')).toBeTruthy();                                         // the vacant count is on the Add Property card
  expect(ui.getByLabelText('Add Property. Add a building or a shop complex, then the units inside it.. 2 Vacant')).toBeTruthy();
  fireEvent.press(ui.getByTestId('add-tenant'));
  expect(onPress).toHaveBeenCalledTimes(1);                                               // a tap on the card opens it; the arrow only scrolls
});

test('each card is the full width, one at a time, with the swipe arrow on it', () => {
  const ui = wrap(<ActionCarousel cards={CARDS()} />);
  laidOut(ui, 360);
  const scroll = ui.getByTestId('action-scroll');
  expect(scroll.props.horizontal).toBe(true);
  expect(scroll.props.snapToInterval).toBe(360 + 12);                                    // exactly one full-width card plus the gap per swipe
  for (const i of [0, 1, 2]) expect(ui.getByTestId(`arrow-${i}`)).toBeTruthy();
  expect(ui.getByLabelText('Add Renter')).toBeTruthy();                                  // card 1's arrow is labelled with where it goes: the next card
});

test('the arrow slides to the next card, and on the last card goes back to the first', () => {
  const ui = wrap(<ActionCarousel cards={CARDS()} />);
  laidOut(ui, 360);
  const on = (i: number) => JSON.stringify(ui.getByTestId(`dot-${i}`, { includeHiddenElements: true }).props.style).includes('"width":20');
  fireEvent.press(ui.getByTestId('arrow-0'));
  expect([on(0), on(1), on(2)]).toEqual([false, true, false]);
  fireEvent.press(ui.getByTestId('arrow-1'));
  expect([on(0), on(1), on(2)]).toEqual([false, false, true]);
  fireEvent.press(ui.getByTestId('arrow-2'));
  expect([on(0), on(1), on(2)]).toEqual([true, false, false]);
});

test('the dots show which card is open and move as you swipe', () => {
  const ui = wrap(<ActionCarousel cards={CARDS()} />);
  laidOut(ui, 360);
  const on = (i: number) => JSON.stringify(ui.getByTestId(`dot-${i}`, { includeHiddenElements: true }).props.style).includes('"width":20');
  expect([on(0), on(1), on(2)]).toEqual([true, false, false]);
  const step = 360 + 12;
  act(() => ui.getByTestId('action-scroll').props.onScroll({ nativeEvent: { contentOffset: { x: step } } }));
  expect([on(0), on(1), on(2)]).toEqual([false, true, false]);
  act(() => ui.getByTestId('action-scroll').props.onScroll({ nativeEvent: { contentOffset: { x: step * 2 } } }));
  expect([on(0), on(1), on(2)]).toEqual([false, false, true]);
});

test('the three cards are drawn in three different colours', () => {
  const ui = wrap(<ActionCarousel cards={CARDS()} />);
  laidOut(ui);
  const drawn = ui.UNSAFE_getAllByType(LinearGradient).map((g: any) => JSON.stringify(g.props.colors));
  expect(drawn).toHaveLength(3);
  expect(new Set(drawn).size).toBe(3);
});

test('a tap anywhere on the card opens it: the card itself is the button, and the colour is only a background that cannot take the tap', () => {
  const onPress = jest.fn();
  const ui = render(<ActionCarousel cards={[{ key: 'a', icon: 'home-plus', title: 'Add Property', message: 'm', colors: ['#176F01', '#1F8A02'] as const, onPress, testID: 'card-a' }]} />);
  fireEvent(ui.getByTestId('action-carousel'), 'layout', { nativeEvent: { layout: { width: 300, height: 100 } } });
  const card = ui.getByTestId('card-a');
  expect(card.props.accessibilityRole).toBe('button');
  fireEvent.press(ui.getByText('Add Property'));       // pressing the text, the icon or the empty part is the same press
  expect(onPress).toHaveBeenCalledTimes(1);
});
