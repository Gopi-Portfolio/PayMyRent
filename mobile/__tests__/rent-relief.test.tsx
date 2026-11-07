import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { OwnerRelief, ReliefSummary, RenterRelief } from '@/components/RentRelief';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('@/lib/api', () => ({ api: jest.fn(async () => ({})), ApiError: class extends Error {} }));

const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}><PaperProvider>{ui}</PaperProvider></QueryClientProvider>);
const bill = (relief: any = null) => ({ summary: { this_month_open_paise: 1000000, total_due_paise: 1000000, payable_now_paise: 1000000 }, relief });

test('the renter cannot ask to pay as much as the full unpaid amount, and the request goes to the server', async () => {
  const ui = wrap(<RenterRelief tenancyId="t1" month="2026-11-01" bill={bill()} />);
  fireEvent.press(ui.getByTestId('relief-open'));
  fireEvent.changeText(ui.getByTestId('relief-amount'), '999999');          // far more than the 10,000 unpaid
  expect(ui.getByTestId('relief-amount').props.value).toBe('9999.99');      // held just under what is unpaid
  fireEvent.changeText(ui.getByTestId('relief-amount'), '6000');
  await act(async () => { fireEvent.press(ui.getByTestId('relief-send')); });
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/v1/tenancies/t1/rent-relief', { body: { period_month: '2026-11-01', pay_amount: '6000', reason: null } }));
});

test('once the owner has agreed, both sides see the full bill, the amount to pay now and what moves on', () => {
  const agreed = { status: 'approved', billed_paise: 1000000, agreed_pay_paise: 600000, deferred_paise: 400000, next_month: '2026-12-01', owner_note: 'Festival month' };
  const ui = wrap(<ReliefSummary bill={bill(agreed)} />);
  expect(ui.getByText('₹10,000')).toBeTruthy();
  expect(ui.getByText('₹6,000')).toBeTruthy();
  expect(ui.getByText('₹4,000')).toBeTruthy();
  expect(ui.getByText('Festival month')).toBeTruthy();
});

test('the owner answers a request: the agree button needs an amount below what is unpaid', async () => {
  const asked = { id: 'r1', status: 'requested', requested_pay_paise: 600000, reason: 'Salary delayed', initiated_by: 'renter' };
  const ui = wrap(<OwnerRelief tenancyId="t1" month="2026-11-01" bill={bill(asked)} owner="o1" />);
  expect(ui.getByText('Salary delayed')).toBeTruthy();
  await act(async () => { fireEvent.press(ui.getByTestId('relief-approve')); });
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/v1/owner/rent-relief/r1/decide', { ownerAccount: 'o1', body: { action: 'approve', pay_amount: '6000', note: null } }));
});
