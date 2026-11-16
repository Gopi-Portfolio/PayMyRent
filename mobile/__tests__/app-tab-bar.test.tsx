import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Text, View } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { AppTabBar, MIN_BOTTOM_SPACE, TAB_HEIGHT } from '@/components/AppTabBar';

let mockInsets = { top: 0, bottom: 34, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => mockInsets }));

const icon = () => <View testID="icon" />;
const routes = [
  { key: 'owner-1', name: 'owner' }, { key: 'tenant-1', name: 'tenant' }, { key: 'pay-1', name: 'pay-tab' }, { key: 'search-1', name: 'search' }, { key: 'profile-1', name: 'profile/index' },
];
const descriptors = (over: Record<string, any> = {}) => ({
  'owner-1': { options: { title: 'Owner', tabBarIcon: icon } },
  'tenant-1': { options: { title: 'My Rentals', hidden: true, tabBarIcon: icon } },              // the other role's tab
  'pay-1': { options: { title: 'Pay', tabBarButton: () => null } },                               // an owner's Pay tab draws nothing
  'search-1': { options: { title: 'Search', tabBarIcon: icon } },
  'profile-1': { options: { title: 'Profile', tabBarIcon: icon } },
  ...over,
});
// the props expo-router really passes to a custom tab bar: state, descriptors, emitter and navigateToTab
const bar = (d = descriptors(), index = 0, nav: any = { emitter: { emit: jest.fn(() => ({ defaultPrevented: false })) }, navigateToTab: jest.fn() }) => ({
  nav, ui: render(<PaperProvider><AppTabBar state={{ index, routes }} descriptors={d} emitter={nav.emitter} navigateToTab={nav.navigateToTab} /></PaperProvider>),
});

test('an owner sees exactly Owner, Search and Profile, each in a slot of the same size, with no gap where Pay would be', () => {
  const { ui } = bar();
  const tabs = ui.getAllByRole('tab');
  expect(tabs.map((t) => t.props.testID)).toEqual(['tab-owner', 'tab-search', 'tab-profile/index']);
  expect(ui.queryByText('My Rentals')).toBeNull();
  expect(ui.queryByText('Pay')).toBeNull();
  const styles = tabs.map((t) => JSON.stringify([].concat(t.props.style).flat().reduce((a: any, s: any) => ({ ...a, ...s }), {})));
  expect(new Set(styles).size).toBe(1);                                                  // the very same box for every tab
});

test('a renter\'s Pay slider sits in a slot of the same width as the other tabs', () => {
  const d = descriptors({
    'owner-1': { options: { title: 'Owner', hidden: true, tabBarIcon: icon } },
    'tenant-1': { options: { title: 'My Rentals', tabBarIcon: icon } },
    'pay-1': { options: { title: 'Pay', tabBarButton: () => <Text>PAY-SLIDER</Text> } },
    'search-1': { options: { title: 'Search', hidden: true, tabBarIcon: icon } },
  });
  const { ui } = bar(d, 1);
  expect(ui.getByText('PAY-SLIDER')).toBeTruthy();
  expect(ui.getAllByRole('tab').map((t) => t.props.testID)).toEqual(['tab-tenant', 'tab-profile/index']);
});

test('tapping a tab announces the press and goes there; tapping the open tab does not navigate again', () => {
  const { ui, nav } = bar(descriptors(), 0);
  fireEvent.press(ui.getByTestId('tab-search'));
  expect(nav.emitter.emit).toHaveBeenCalledWith({ type: 'tabPress', target: 'search-1', canPreventDefault: true });
  expect(nav.navigateToTab).toHaveBeenCalledWith('search-1');
  nav.navigateToTab.mockClear();
  fireEvent.press(ui.getByTestId('tab-owner'));
  expect(nav.navigateToTab).not.toHaveBeenCalled();
});

test('a tap that something else has cancelled does not navigate', () => {
  const nav = { emitter: { emit: jest.fn(() => ({ defaultPrevented: true })) }, navigateToTab: jest.fn() };
  const { ui } = bar(descriptors(), 0, nav);
  fireEvent.press(ui.getByTestId('tab-profile/index'));
  expect(nav.navigateToTab).not.toHaveBeenCalled();
});

test('uses the props the navigator really passes: the library calls a custom tab bar with state, descriptors, emitter and navigateToTab', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../node_modules/expo-router/build/react-navigation/bottom-tabs/views/BottomTabView.js'), 'utf8');
  const call = src.slice(src.indexOf('tabBar({'), src.indexOf('tabBar({') + 400);
  for (const prop of ['state', 'descriptors', 'emitter', 'navigateToTab']) expect(call).toContain(prop);
  expect(call).not.toMatch(/\bnavigation\b/);                       // there is no navigation object, which is what the first version of the bar wrongly used
});

test('the open tab is marked as selected for screen readers', () => {
  const { ui } = bar(descriptors(), 3);
  expect(ui.getByTestId('tab-search').props.accessibilityState).toEqual({ selected: true });
  expect(ui.getByTestId('tab-owner').props.accessibilityState).toEqual({ selected: false });
});

test('the room under the labels is the phone\'s own bottom space, at least a few points, so the labels never touch the edge', () => {
  for (const bottom of [34, 21, 0]) {
    mockInsets = { top: 0, bottom, left: 0, right: 0 };
    const { ui } = bar();
    const style = [].concat(ui.getByTestId('tab-bar').props.style).flat().reduce((a: any, s: any) => ({ ...a, ...s }), {});
    const space = Math.max(bottom, MIN_BOTTOM_SPACE);
    expect(style.paddingBottom).toBe(space);
    expect(style.height).toBe(TAB_HEIGHT + space);
  }
});
