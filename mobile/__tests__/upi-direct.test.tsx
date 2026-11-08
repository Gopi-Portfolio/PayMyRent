import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { Linking, Platform } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { EMPTY_PAY_HOW, PayHow, type PayHowValue, payHowBody, payHowReady } from '@/components/PayHow';
import { OwnerPayDefault } from '@/components/OwnerPayDefault';
import { UpiPay } from '@/components/UpiPay';
import { maskUpi, upiLink, upiValid } from '@/lib/upi';
import '@/i18n';

const mockApi = jest.fn(async (path: string) => (path.endsWith('/upi-ids') ? { upi_ids: ['known@okhdfcbank'], default_upi_id: 'known@okhdfcbank', default_pay_method: 'upi', last_pay_method: 'upi', online_available: false } : { amount_display: '₹4,000', status: 'pending' }));
jest.mock('@/lib/api', () => ({ api: (...a: any[]) => (mockApi as any)(...a), newIdempotencyKey: () => 'idem-key-12345', ApiError: class extends Error {} }));
jest.mock('@/lib/auth', () => ({ ownerAccountId: () => 'o1', useAuth: () => ({ me: { owner_accounts: [{ owner_account_id: 'o1', role: 'owner' }] } }) }));

const wrap = (ui: React.ReactElement) => <QueryClientProvider client={new QueryClient()}><PaperProvider>{ui}</PaperProvider></QueryClientProvider>;

test('UPI IDs are checked and written the way UPI apps expect', () => {
  expect(upiValid(' Owner.Name@OkHDFCBank ')).toBe(true);
  expect(upiValid('no-at-sign')).toBe(false);
  expect(upiValid('a@b')).toBe(false);
  expect(maskUpi('ravi.kumar@okhdfcbank')).toBe('ra•••ar@okhdfcbank');
  const link = upiLink('upi://pay', { vpa: 'a.b@oksbi', name: 'Ravi Kumar', paise: 400050, note: 'Rent S-1' });
  expect(link).toBe('upi://pay?pa=a.b%40oksbi&pn=Ravi%20Kumar&am=4000.50&cu=INR&tn=Rent%20S-1');
});

test('the owner must choose a method; a new UPI ID needs a code, a known one does not', () => {
  const known = ['known@okhdfcbank'];
  const v = (o: Partial<PayHowValue>): PayHowValue => ({ ...EMPTY_PAY_HOW, ...o });
  expect(payHowReady(EMPTY_PAY_HOW, known, null)).toBe(false);
  expect(payHowReady(v({ method: 'cash' }), known, null)).toBe(true);
  expect(payHowReady(v({ method: 'online' }), known, null)).toBe(true);
  // no UPI ID in the profile yet: the owner types one (a new one needs the code)
  expect(payHowReady(v({ method: 'upi', upi: 'bad' }), known, null)).toBe(false);
  expect(payHowReady(v({ method: 'upi', upi: 'new@oksbi' }), known, null)).toBe(false);
  expect(payHowReady(v({ method: 'upi', upi: 'new@oksbi', otp: '123456' }), known, null)).toBe(true);
  expect(payHowReady(v({ method: 'upi', upi: 'Known@okhdfcbank' }), known, null)).toBe(true);
  // a UPI ID in the profile: nothing to type, nothing is sent
  expect(payHowReady(v({ method: 'upi' }), known, 'known@okhdfcbank')).toBe(true);
  expect(payHowBody(v({ method: 'upi' }), known, 'known@okhdfcbank')).toEqual({ pay_method: 'upi', pay_upi_id: null, otp_code: null });
  // ...unless this tenant gets its own
  expect(payHowReady(v({ method: 'upi', custom: true }), known, 'known@okhdfcbank')).toBe(false);
  expect(payHowBody(v({ method: 'upi', custom: true, upi: 'Shop@oksbi', otp: '123456' }), known, 'known@okhdfcbank')).toEqual({ pay_method: 'upi', pay_upi_id: 'shop@oksbi', otp_code: '123456' });
  expect(payHowBody(v({ method: 'upi', upi: 'Known@okhdfcbank' }), known, null)).toEqual({ pay_method: 'upi', pay_upi_id: 'known@okhdfcbank', otp_code: null });
  expect(payHowBody(v({ method: 'cash', upi: 'x@oksbi' }), known, null)).toEqual({ pay_method: 'cash', pay_upi_id: null, otp_code: null });
});

test('the owner is asked how they want to receive rent; UPI uses the profile ID unless changed', async () => {
  function Host() {
    const [v, setV] = React.useState<PayHowValue>(EMPTY_PAY_HOW);
    return <PayHow value={v} onChange={setV} showErrors />;
  }
  const ui = render(wrap(<Host />));
  expect(ui.getByText('How do you want to receive rent from this tenant?')).toBeTruthy();
  expect(ui.getByText('Choose how you want to receive rent')).toBeTruthy();        // nothing is chosen for the owner
  expect(ui.queryByTestId('payhow-profile-upi')).toBeNull();
  fireEvent.press(ui.getByTestId('payhow-upi'));
  await waitFor(() => ui.getByTestId('payhow-profile-upi'));                         // the profile UPI ID is used, nothing to type
  expect(ui.getByTestId('payhow-profile-upi').props.children).toBe('known@okhdfcbank');
  expect(ui.queryByTestId('payhow-upi-id')).toBeNull();
  fireEvent.press(ui.getByTestId('payhow-use-other'));                                // only if needed: a different ID for this tenant
  await waitFor(() => ui.getByTestId('payhow-upi-id'));
  fireEvent.press(ui.getByTestId('payhow-use-mine'));
  await waitFor(() => ui.getByTestId('payhow-profile-upi'));
  fireEvent.press(ui.getByTestId('payhow-cash'));
  expect(ui.queryByTestId('payhow-profile-upi')).toBeNull();
});

test('tenant opens the UPI app with the amount filled in, then reports the reference', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
  const onReported = jest.fn();
  const ui = render(wrap(<UpiPay tenancyId="t1" ownerName="Gopi" upi="gopi@okhdfcbank" unit="S-01" paise={400000} due={1000000} onReported={onReported} />));
  expect(ui.getByTestId('upi-id').props.children).toBe('gopi@okhdfcbank');
  expect(ui.getByTestId('upi-submit').props.accessibilityState.disabled).toBe(true);        // no reference yet
  // iPhone: every app opens by its own link (the plain upi:// link is taken by WhatsApp); Android keeps the system chooser
  const ios = Platform.OS === 'ios';
  expect(ui.queryByTestId('upi-other') === null).toBe(ios);
  fireEvent.press(ui.getByTestId(ios ? 'upi-phonepe' : 'upi-other'));
  await waitFor(() => expect(open).toHaveBeenCalled());
  expect(open.mock.calls[0][0]).toContain(ios ? 'phonepe://pay?pa=gopi%40okhdfcbank' : 'upi://pay?pa=gopi%40okhdfcbank');
  expect(open.mock.calls[0][0]).toContain('am=4000.00');
  if (ios) {
    fireEvent.press(ui.getByTestId('upi-paytm'));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(open.mock.calls[1][0]).toContain('paytmmp://pay?pa=gopi%40okhdfcbank');
    expect(open.mock.calls.every((c: any[]) => !String(c[0]).startsWith('upi://'))).toBe(true);
  }
  fireEvent.changeText(ui.getByTestId('upi-ref'), 'UTR123456789');
  fireEvent.press(ui.getByTestId('upi-submit'));
  await waitFor(() => expect(onReported).toHaveBeenCalled());
  const call = mockApi.mock.calls.find((c: any[]) => String(c[0]).includes('manual-transfer')) as any[];
  expect(call[1].body).toMatchObject({ amount: '4000', reference: 'UTR123456789', idempotency_key: 'idem-key-12345' });
});

test('more than the due amount cannot be paid', () => {
  const ui = render(wrap(<UpiPay tenancyId="t1" ownerName="Gopi" upi="gopi@okhdfcbank" unit="S-01" paise={2000000} due={1000000} onReported={jest.fn()} />));
  expect(ui.getByTestId('upi-gpay').props.accessibilityState.disabled).toBe(true);
});

test('Profile: the usual way of receiving rent is shown, can be changed, and is saved once for all tenants', async () => {
  const ui = render(wrap(<OwnerPayDefault />));
  await waitFor(() => expect(ui.getByTestId('pay-default-current').props.children).toContain('UPI'));
  expect(ui.getByText('How I usually receive rent')).toBeTruthy();
  expect(ui.getByTestId('pay-default-save').props.accessibilityState.disabled).toBe(true);        // nothing changed yet
  expect(ui.getByTestId('payhow-online').props.accessibilityState.disabled).toBe(true);           // no live provider: online cannot be the default
  expect(ui.queryByTestId('payhow-use-other')).toBeNull();                                          // "a different ID for this tenant" belongs on a tenant, not here
  fireEvent.press(ui.getByTestId('payhow-cash'));
  await waitFor(() => expect(ui.getByTestId('pay-default-save').props.accessibilityState.disabled).toBe(false));
  fireEvent.press(ui.getByTestId('pay-default-save'));
  await waitFor(() => ui.getByTestId('pay-default-saved'));
  const call = mockApi.mock.calls.find((c: any[]) => String(c[0]).includes('/owner/pay-default')) as any[];
  expect(call[1]).toMatchObject({ method: 'PUT', body: { method: 'cash', upi_id: null, otp_code: null } });
});

test('the three UPI app buttons carry their official logos, not placeholders', () => {
  const { UPI_LOGOS, UPI_PLACEHOLDER } = require('@/lib/upiLogos');
  const { UpiAppButton } = require('@/components/UpiAppButton');
  for (const app of ['gpay', 'phonepe', 'paytm']) expect(UPI_LOGOS[app]).toBeTruthy();
  const ui = render(<PaperProvider><>
    <UpiAppButton app="gpay" label="Google Pay" onPress={jest.fn()} testID="b-gpay" />
    <UpiAppButton app="phonepe" label="PhonePe" onPress={jest.fn()} testID="b-phonepe" />
    <UpiAppButton app="paytm" label="Paytm" onPress={jest.fn()} testID="b-paytm" />
  </></PaperProvider>);
  for (const app of ['gpay', 'phonepe', 'paytm']) expect(ui.queryAllByText(UPI_PLACEHOLDER[app]).length).toBe(1);   // only the name label under the logo; the grey name tile (placeholder) is not drawn
  expect(ui.getByLabelText('PhonePe')).toBeTruthy();
});
