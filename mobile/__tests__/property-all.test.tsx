import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { PropertySwitcher } from '@/components/PropertySwitcher';
import { askForProperty, setViewAll } from '@/lib/propertyView';
import { combineMetrics } from '../app/(app)/owner/index';
import '@/i18n';

const mockSelect = jest.fn();
let mockOwners = [
  { owner_account_id: 'o1', role: 'owner', property_name: 'Tower', property_status: 'verified' },
  { owner_account_id: 'o2', role: 'owner', property_name: 'Villa', property_status: 'verified' },
  { owner_account_id: 'o3', role: 'owner', property_name: 'Shops', property_status: 'verified' },
];
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: { owner_accounts: mockOwners }, selectOwner: mockSelect }), ownerAccountId: () => 'o2' }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/components/ui', () => ({ ...jest.requireActual('@/components/ui') }));
const wrap = () => render(<PaperProvider><PropertySwitcher /></PaperProvider>);

beforeEach(() => { mockSelect.mockReset(); act(() => setViewAll(true)); });

test('by default every property is shown together, with the count', () => {
  const ui = wrap();
  expect(ui.getByTestId('property-shown').props.children).toBe('All properties (3)');
});

test('the list has All properties first, then each property, and no Add property row', () => {
  const ui = wrap();
  fireEvent.press(ui.getByTestId('property-dropdown'));
  expect(ui.getByTestId('property-all')).toBeTruthy();
  for (const i of [0, 1, 2]) expect(ui.getByTestId(`property-${i}`)).toBeTruthy();
  expect(ui.queryByTestId('add-property')).toBeNull();
  expect(ui.queryByText('Add Property')).toBeNull();
});

test('choosing one property narrows to it, and All properties brings everything back', () => {
  const ui = wrap();
  fireEvent.press(ui.getByTestId('property-dropdown'));
  fireEvent.press(ui.getByTestId('property-1'));
  expect(mockSelect).toHaveBeenCalledWith('o2');
  expect(ui.getByTestId('property-shown').props.children).toBe('Villa');
  fireEvent.press(ui.getByTestId('property-dropdown'));
  fireEvent.press(ui.getByTestId('property-all'));
  expect(ui.getByTestId('property-shown').props.children).toBe('All properties (3)');
});

test('a button that needs one property opens the list with a note to choose one', () => {
  const ui = wrap();
  expect(ui.queryByTestId('choose-property-first')).toBeNull();
  act(() => askForProperty());
  expect(ui.getByTestId('choose-property-first')).toBeTruthy();
  expect(ui.getByTestId('property-1')).toBeTruthy();
  fireEvent.press(ui.getByTestId('property-1'));
  expect(ui.queryByTestId('choose-property-first')).toBeNull();
});

test('with one property there is no All row and no count: it is simply that property', () => {
  mockOwners = [mockOwners[0]];
  const ui = wrap();
  expect(ui.getByTestId('property-shown').props.children).toBe('Tower');
  fireEvent.press(ui.getByTestId('property-dropdown'));
  expect(ui.queryByTestId('property-all')).toBeNull();
});

test('the totals of all properties are added up, money keeps its display', () => {
  const a = { collected_paise: { value: 100000, display: '' }, units: 3, vacate_pending: 1 };
  const b = { collected_paise: { value: 50000, display: '' }, units: 2, vacate_pending: 0 };
  const sum = combineMetrics([a, b, undefined]);
  expect(sum.collected_paise.value).toBe(150000);
  expect(sum.collected_paise.display).toContain('1,500');
  expect(sum.units).toBe(5);
  expect(sum.vacate_pending).toBe(1);
});
