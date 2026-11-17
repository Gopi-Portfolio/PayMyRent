import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { Metric } from '@/components/ui';
import '@/i18n';

jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

test('the home tiles show a count and a black name, and a tap opens what is behind them', () => {
  const onPress = jest.fn();
  const ui = render(<PaperProvider><Metric compact tinted label="All Renters" count={7} icon="account-group-outline" tone="violet" testID="metric-renters" onPress={onPress} /></PaperProvider>);
  expect(ui.getByText('7')).toBeTruthy();
  const label = ui.getByText('All Renters');
  expect(JSON.stringify(label.props.style)).toContain('#000');
  fireEvent.press(ui.getByTestId('metric-renters'));
  expect(onPress).toHaveBeenCalledTimes(1);
});
