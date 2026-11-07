import { render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { AgreementLink } from '@/components/AgreementLink';
import '@/i18n';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const wrap = (end: string | null) => render(<PaperProvider><AgreementLink tenancyId="t1" endDate={end} /></PaperProvider>);

test('a running agreement says when it ends; one that has ended says to renew now', () => {
  expect(wrap(day(200)).getByText(/Ends \d\d-\d\d-\d{4} · View or renew/)).toBeTruthy();
  expect(wrap(day(10)).getByText(/Ends \d\d-\d\d-\d{4} · View or renew/)).toBeTruthy();
  expect(wrap(day(-3)).getByText(/Ended \d\d-\d\d-\d{4} · Renew now/)).toBeTruthy();
  expect(wrap(null).getByText('No end date. This agreement keeps running.')).toBeTruthy();
});
