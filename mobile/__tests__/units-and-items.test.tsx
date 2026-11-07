import { render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { ItemsProvided, splitItems } from '@/components/ItemsProvided';
import { applyFilter, NO_FILTER } from '@/components/ui';
import { kindGroup, kindIcon } from '@/lib/units';
import '@/i18n';

test('there are only two kinds of place: residential and commercial (a shop is commercial)', () => {
  expect(['shop', 'office', 'commercial', 'other', undefined].map(kindGroup)).toEqual(['commercial', 'commercial', 'commercial', 'commercial', 'commercial']);
  expect(['house', 'flat', 'residential'].map(kindGroup)).toEqual(['residential', 'residential', 'residential']);
  expect(kindIcon('residential')).toBe('home-variant-outline');
  expect(kindIcon('shop')).toBe('office-building-outline');
});

test('the renter list can be narrowed to residential only or commercial only', () => {
  const rows = [{ id: 1, unit_kind: 'shop' }, { id: 2, unit_kind: 'flat' }, { id: 3, unit_kind: 'commercial' }, { id: 4, kind: 'other' }, { id: 5, kind: 'residential' }];
  expect(applyFilter(rows, { ...NO_FILTER, kind: 'commercial' }).map((r: any) => r.id)).toEqual([1, 3, 4]);
  expect(applyFilter(rows, { ...NO_FILTER, kind: 'residential' }).map((r: any) => r.id)).toEqual([2, 5]);
});

test('items typed with commas, semicolons or new lines become a tidy list', () => {
  expect(splitItems('2 fans, geyser\n  Gas stove ;; Water tank\n\n')).toEqual(['2 fans', 'geyser', 'Gas stove', 'Water tank']);
  expect(splitItems('   ')).toEqual([]);
  const ui = render(<PaperProvider><ItemsProvided text={'3-phase power, 2 loading docks\nCrane'} /></PaperProvider>);
  expect(ui.getByText('3-phase power')).toBeTruthy();
  expect(ui.getByText('2 loading docks')).toBeTruthy();
  expect(ui.getByText('Crane')).toBeTruthy();
  expect(render(<PaperProvider><ItemsProvided text="" /></PaperProvider>).queryByTestId('items-provided')).toBeNull();
});

import { sanitize } from '@/lib/inputs';
import { floorChip, floorLabel } from '@/lib/units';
import { placeSchema } from '@/lib/validation';

const tt = (k: string, o?: any) => (k === 'tenancy.ground' ? 'Ground floor' : k === 'tenancy.groundShort' ? 'Ground' : k === 'tenancy.floorN' ? `Floor ${o.n}` : k);

test('floors read Ground, 1st, 2nd, 3rd ... 10th in English and "Floor n" elsewhere', () => {
  expect([0, 1, 2, 3, 4, 10].map((n) => floorLabel(n, tt, 'en'))).toEqual(['Ground floor', '1st floor', '2nd floor', '3rd floor', '4th floor', '10th floor']);
  expect(floorLabel(11, tt, 'en')).toBe('11th floor');                  // never reached (the limit is 10), but the rule is right
  expect(floorLabel(3, tt, 'ta')).toBe('Floor 3');
  expect(floorLabel(null, tt, 'en')).toBe('');
  expect([0, 1, 2, 10].map((n) => floorChip(n, tt, 'en'))).toEqual(['Ground', '1st', '2nd', '10th']);
});

test('a place is a number or a short description, for residential and commercial alike', () => {
  for (const ok of ['12', '4B', 'Flat 3, Block A', 'S-01', '10-50 hostel', '2 shops, 5 houses', 'Factory shed (rear)', 'A & B Complex']) expect(placeSchema.safeParse(ok).success).toBe(true);
  expect(placeSchema.safeParse('x'.repeat(81)).success).toBe(false);
  expect(placeSchema.safeParse('Bad <name>').success).toBe(false);
  expect(sanitize('place', '10-50 hostel, 2 shops; 5 houses!')).toBe('10-50 hostel, 2 shops 5 houses');
  expect(sanitize('place', 'y'.repeat(100)).length).toBe(80);
});
