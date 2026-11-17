import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { PropertySwitcher } from '@/components/PropertySwitcher';
import { askForProperty, setViewAll } from '@/lib/propertyView';
import { combineMetrics } from '../app/(app)/owner/index';
import '@/i18n';

const mockSelect = jest.fn();
let mockOwners = [
  { owner_account_id: 'o1', role: 'owner', property_name: 'Tower', property_status: 'verified', property_kind: 'residential' },
  { owner_account_id: 'o2', role: 'owner', property_name: 'Villa', property_status: 'verified', property_kind: 'residential' },
  { owner_account_id: 'o3', role: 'owner', property_name: 'Shops', property_status: 'verified', property_kind: 'commercial' },
];
jest.mock('@/lib/auth', () => ({ useAuth: () => ({ me: { owner_accounts: mockOwners }, selectOwner: mockSelect }), ownerAccountId: () => 'o2', ownerProperties: (me: any) => me.owner_accounts }));
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

test('before any property has answered there are no totals yet (the screen shows zeros instead of failing)', () => {
  expect(combineMetrics([undefined, undefined])).toBeUndefined();
  expect(combineMetrics([])).toBeUndefined();
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

test('an empty account left after a property was removed is not listed while another account has a property', () => {
  const real = jest.requireActual('@/lib/auth') as typeof import('@/lib/auth');
  const empty = { owner_account_id: 'x', role: 'owner', property_name: null, property_address: null, property_status: null };
  const full = { owner_account_id: 'o1', role: 'owner', property_name: 'Tower', property_address: '1 Road', property_status: 'verified' };
  expect(real.ownerProperties({ owner_accounts: [full, empty] } as any).map((o) => o.owner_account_id)).toEqual(['o1']);
  expect(real.ownerProperties({ owner_accounts: [empty] } as any).map((o) => o.owner_account_id)).toEqual(['x']);          // a new owner still sees the starting account
});

test('the dropdown shows R or C for each property instead of an icon, and the chosen one is ticked', () => {
  mockOwners = [
    { owner_account_id: 'o1', role: 'owner', property_name: 'Tower', property_status: 'verified', property_kind: 'residential' },
    { owner_account_id: 'o2', role: 'owner', property_name: 'Shops', property_status: 'verified', property_kind: 'commercial' }];
  const ui = wrap();
  fireEvent.press(ui.getByTestId('property-dropdown'));
  expect(ui.getByTestId('property-kind-0').props.accessibilityLabel).toBe('Residential');
  expect(ui.getByTestId('property-kind-1').props.accessibilityLabel).toBe('Commercial');
  expect(ui.getByText('R')).toBeTruthy(); expect(ui.getByText('C')).toBeTruthy();
  fireEvent.press(ui.getByTestId('property-1'));
  expect(ui.getByTestId('property-shown-kind').props.accessibilityLabel).toBe('Commercial');      // the closed dropdown shows the chosen property's badge
});
