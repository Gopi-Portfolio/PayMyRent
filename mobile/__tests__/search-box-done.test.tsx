import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Keyboard } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { SearchBox } from '@/components/SearchBox';
import '@/i18n';

test('the search bar shows a tick that closes the keyboard while it is being typed in', () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  const ui = render(<PaperProvider><SearchBox value="" onChangeText={() => {}} placeholder="Search" filterLabel="Filters" testID="sb" /></PaperProvider>);
  expect(ui.queryByTestId('sb-done')).toBeNull();
  fireEvent(ui.getByTestId('sb'), 'focus');
  fireEvent.press(ui.getByTestId('sb-done'));
  expect(dismiss).toHaveBeenCalled();
  fireEvent(ui.getByTestId('sb'), 'blur');
  expect(ui.queryByTestId('sb-done')).toBeNull();
  dismiss.mockRestore();
});
