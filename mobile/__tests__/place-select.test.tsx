import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { PlaceSelect, type Place } from '@/components/PlaceSelect';
import '@/i18n';

const places: Place[] = [
  { id: 'a', identifier: 'S-01', floor: 1, vacant: false, tenancy_id: 't1', tenant_name: 'Ravi Kumar' },     // taken
  { id: 'b', identifier: 'S-02', floor: 2, vacant: true, tenancy_id: null },                                     // free
  { id: 'c', identifier: 'Room 3', floor: null, vacant: false, tenancy_id: 't3', tenant_name: 'Selvi' },        // taken
];

test('closed it is one line; open it lists every unit, with taken ones locked and disabled', () => {
  const onPick = jest.fn();
  const ui = render(<PaperProvider><PlaceSelect places={places} selectedId={null} onPick={onPick} /></PaperProvider>);
  expect(ui.getByText('Units in This Property (3)')).toBeTruthy();
  expect(ui.queryByTestId('unit-free-S-02')).toBeNull();                                  // nothing listed while closed
  fireEvent.press(ui.getByTestId('places-dropdown'));
  expect(ui.getByTestId('unit-locked-S-01').props.accessibilityState.disabled).toBe(true);
  expect(ui.getByTestId('unit-locked-Room 3').props.accessibilityState.disabled).toBe(true);
  expect(ui.getByTestId('unit-free-S-02').props.accessibilityState.disabled).toBe(false);
  expect(ui.getByText('Rented to Ravi Kumar')).toBeTruthy();                              // who holds a locked place, in words
  expect(ui.getByText('Rented to Selvi')).toBeTruthy();
  fireEvent.press(ui.getByTestId('unit-locked-S-01'));
  expect(onPick).not.toHaveBeenCalled();                                                  // a locked place cannot be chosen
  fireEvent.press(ui.getByTestId('unit-free-S-02'));
  expect(onPick).toHaveBeenCalledWith(places[1]);
  expect(ui.queryByTestId('unit-free-S-02')).toBeNull();                                  // closes after a pick
});

test('when every place is taken it says so', () => {
  const ui = render(<PaperProvider><PlaceSelect places={[places[0], places[2]]} selectedId={null} onPick={jest.fn()} /></PaperProvider>);
  expect(ui.getByTestId('no-free-unit')).toBeTruthy();
});

test('the open list says how many are vacant and occupied, lists the vacant units first, and says in words which are rented to whom', () => {
  const ui = render(<PaperProvider><PlaceSelect places={places} selectedId={null} onPick={jest.fn()} /></PaperProvider>);
  fireEvent.press(ui.getByTestId('places-dropdown'));
  expect(ui.getByText('1 vacant · 2 occupied')).toBeTruthy();
  expect(ui.getByTestId('unit-status-S-02').props.children).toBe('Vacant');
  const order = ui.getAllByTestId(/^unit-(free|locked)-/).map((r) => r.props.testID);
  expect(order).toEqual(['unit-free-S-02', 'unit-locked-S-01', 'unit-locked-Room 3']);     // vacant first, rented below
  expect(ui.getByLabelText(/^S-01\. Rented to Ravi Kumar\./)).toBeTruthy();               // a screen reader gets the same words
});

test('a rented unit with no name on record still says it is occupied', () => {
  const ui = render(<PaperProvider><PlaceSelect places={[{ id: 'x', identifier: 'G-9', vacant: false, tenancy_id: 't9', tenant_name: null }]} selectedId={null} onPick={jest.fn()} /></PaperProvider>);
  fireEvent.press(ui.getByTestId('places-dropdown'));
  expect(ui.getByTestId('unit-status-G-9').props.children).toBe('Occupied');
});
