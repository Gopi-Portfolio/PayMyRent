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

test('closed it is one line; open it lists every place, with taken ones locked and disabled', () => {
  const onPick = jest.fn();
  const ui = render(<PaperProvider><PlaceSelect places={places} selectedId={null} onPick={onPick} /></PaperProvider>);
  expect(ui.getByText('Places in This Property (3)')).toBeTruthy();
  expect(ui.queryByTestId('unit-free-S-02')).toBeNull();                                  // nothing listed while closed
  fireEvent.press(ui.getByTestId('places-dropdown'));
  expect(ui.getByTestId('unit-locked-S-01').props.accessibilityState.disabled).toBe(true);
  expect(ui.getByTestId('unit-locked-Room 3').props.accessibilityState.disabled).toBe(true);
  expect(ui.getByTestId('unit-free-S-02').props.accessibilityState.disabled).toBe(false);
  expect(ui.getByText('Ravi Kumar')).toBeTruthy();                                        // who holds a locked place
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
