import { NO_FILTER, applyFilter } from '@/components/ui';

const rows = [
  { id: 1, kind: 'shop', balance_paise: 0 },
  { id: 2, unit_kind: 'shop', balance_paise: 5000 },
  { id: 3, kind: 'house', balance_paise: 0 },
  { id: 4, unit_kind: 'house', balance_paise: 100 },
  { id: 5, kind: 'house', balance_paise: -300 },   // credit balance counts as paid up
];
const ids = (f: any) => applyFilter(rows, f).map((r) => r.id);

test('no filter keeps everything', () => expect(ids(NO_FILTER)).toEqual([1, 2, 3, 4, 5]));
test('commercial only / residential only (owner list uses unit_kind, renter list uses kind)', () => {
  expect(ids({ ...NO_FILTER, kind: 'commercial' })).toEqual([1, 2]);
  expect(ids({ ...NO_FILTER, kind: 'residential' })).toEqual([3, 4, 5]);
});
test('paid up and unpaid', () => {
  expect(ids({ ...NO_FILTER, pay: 'paid' })).toEqual([1, 3, 5]);
  expect(ids({ ...NO_FILTER, pay: 'unpaid' })).toEqual([2, 4]);
});
test('kind and payment combine', () => expect(ids({ kind: 'residential', pay: 'unpaid' })).toEqual([4]));
