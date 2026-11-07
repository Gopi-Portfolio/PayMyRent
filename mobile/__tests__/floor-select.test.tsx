import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { FloorSelect } from '@/components/FloorSelect';
import '@/i18n';

function Host({ seen }: { seen: { v: number | null } }) {
  const [v, setV] = React.useState<number | null>(null);
  seen.v = v;
  return <PaperProvider><FloorSelect value={v} onChange={setV} /></PaperProvider>;
}

test('the floor dropdown lists None, Ground and 1st to 10th, and picking one closes it and sets the floor', () => {
  const seen = { v: null as number | null };
  const ui = render(<Host seen={seen} />);
  expect(ui.queryByTestId('floor-3')).toBeNull();                      // closed to begin with
  fireEvent.press(ui.getByTestId('floor-dropdown'));
  for (const n of ['none', 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) expect(ui.getByTestId(`floor-${n}`)).toBeTruthy();
  expect(ui.getByText('Ground floor')).toBeTruthy();
  expect(ui.getByText('10th floor')).toBeTruthy();
  expect(ui.queryByTestId('floor-11')).toBeNull();                     // the building tops out at the 10th
  fireEvent.press(ui.getByTestId('floor-3'));
  expect(seen.v).toBe(3);
  expect(ui.queryByTestId('floor-4')).toBeNull();                      // closed again
  expect(ui.getByText('3rd floor')).toBeTruthy();                      // the box shows the choice
});
