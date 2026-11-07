// jest-expo component tests: `npx jest`
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { SearchableSelect } from '@/components/SearchableSelect';
import '@/i18n';
import { graphemeCount } from '@/lib/format';

test('250 Tamil graphemes count as 250', () => {
  expect(graphemeCount('கி'.repeat(250))).toBe(250);
});

test('searchable select filters and selects', () => {
  const onChange = jest.fn();
  const ui = render(
    <PaperProvider>
      <SearchableSelect label="Tenant" value={null} onChange={onChange} testID="sel"
        options={[{ value: 'a', label: 'S-01 · Ravi' }, { value: 'b', label: 'S-02 · Kavya' }]} />
    </PaperProvider>,
  );
  fireEvent.press(ui.getByTestId('sel'));
  fireEvent.changeText(ui.getByPlaceholderText('Search'), 'kav');
  expect(ui.queryByText('S-01 · Ravi')).toBeNull();
  fireEvent.press(ui.getByText('S-02 · Kavya'));
  expect(onChange).toHaveBeenCalledWith('b');
});
