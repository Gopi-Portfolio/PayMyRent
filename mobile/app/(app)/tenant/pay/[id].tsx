// Full or partial online payment. Paid only when the SERVER says so (verified webhook / status check).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { Icon, Text, TextInput } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { sanitize } from '@/lib/inputs';
import { AppButton } from '@/components/Buttons';
import { UpiPay } from '@/components/UpiPay';
import { BillView } from '@/components/BillView';
import { BalancePreview, Chip2, ErrorBanner, Panel, ResultView, Screen } from '@/components/ui';
import { goBack } from '@/components/ui';
import { ApiError, api, newIdempotencyKey, reachable } from '@/lib/api';
import { capToDue, formatINR, parseRupeesToPaise } from '@/lib/format';
import { brand, radius } from '@/theme';

export default function Pay() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const bill = useQuery({ queryKey: ['bill', id, 'now'], queryFn: () => api<any>(`/api/v1/tenancies/${id}/bill`) });
  const due = Number(bill.data?.summary.payable_now_paise ?? bill.data?.summary.total_due_paise ?? 0);
  // how THIS owner wants to be paid by this renter: UPI direct (free), online checkout, or cash / bank transfer
  const rentals = useQuery({ queryKey: ['rentals'], queryFn: () => api<any>('/api/v1/tenant/rentals') });
  const rental = rentals.data?.items?.find((x: any) => x.id === id);
  const mode: string = rental?.pay_mode ?? 'online';       // 'upi' | 'cash' | 'online' (a live provider only) | 'none'; the demo checkout is never offered
  const [amount, setAmount] = useState('');
  const edited = useRef(false);
  // the balance is already in the box when the screen opens (the renter can still change it to pay part)
  React.useEffect(() => {
    if (!edited.current && due > 0) setAmount(due % 100 === 0 ? String(due / 100) : (due / 100).toFixed(2));
  }, [due]);
  const [capped, setCapped] = useState(false);
  const [payment, setPayment] = useState<any>(null);
  const [reported, setReported] = useState<{ p: any; ref: string } | null>(null);     // a UPI payment the renter says they made, waiting for the owner
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const idem = useRef(newIdempotencyKey());
  const paise = parseRupeesToPaise(amount);

  const status = useQuery({
    queryKey: ['payment', payment?.id], enabled: !!payment,
    queryFn: () => api<any>(`/api/v1/tenant/payments/${payment.id}/refresh`, { method: 'POST' }),
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 3000 : false),
  });

  async function start() {
    setErr(null); setBusy(true);
    try {
      const p = await api<any>(`/api/v1/tenant/tenancies/${id}/payments/checkout`, { body: { amount, idempotency_key: idem.current } });
      setPayment(p);
      if (p.checkout?.pay_url) await WebBrowser.openBrowserAsync(reachable(p.checkout.pay_url));
      // Razorpay: open the native checkout with p.checkout (UPI intent/QR where the PSP enables it).
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const s = status.data?.status;
  if (reported) {
    return (
      <Screen>
        <ResultView kind="review" title={t('upi.reportedTitle')} lines={[reported.p.amount_display, `${t('upi.ref')}: ${reported.ref}`]} hint={t('upi.reportedHint', { owner: rental?.owner_name ?? '' })}>
          <AppButton label={t('common.continue')} icon="check" onPress={() => { qc.invalidateQueries(); goBack(); }} testID="upi-done" />
        </ResultView>
      </Screen>
    );
  }
  if (payment) {
    return (
      <Screen>
        {s === 'confirmed' ? (
          <ResultView kind="success" title={t('pay.success')} lines={[status.data.amount_display, `${status.data.receipt_number} · ${t('bill.totalDue')} ${status.data.balance_after_display}`]}>
            <AppButton label={t('common.continue')} icon="check" onPress={() => { qc.invalidateQueries(); goBack(); }} />
          </ResultView>
        ) : s === 'failed' ? (
          <ResultView kind="failed" title={t('pay.failed')}>
            <AppButton label={t('common.retry')} icon="refresh" onPress={() => { idem.current = newIdempotencyKey(); setPayment(null); }} />
          </ResultView>
        ) : (
          <ResultView kind="pending" title={t('pay.pending')} hint={t('pay.waitHint')} error={status.error}>
            <AppButton variant="outline" icon="refresh" label={t('identity.check')} onPress={() => status.refetch()} />
          </ResultView>
        )}
      </Screen>
    );
  }
  const unavailable = err instanceof ApiError && err.code === 'PAYMENTS_UNAVAILABLE';
  return (
    <Screen>
      {/* what the amount is made of: rent, maintenance, electricity, water, miscellaneous, previous dues, payments and credit */}
      <BillView bill={bill.data} />
      <Panel title={t('pay.amount')} icon="cash-edit" tone="green">
        <TextInput mode="outlined" value={amount} onChangeText={(v) => { edited.current = true; const c = capToDue(sanitize('amount', v), due); setAmount(c.text); setCapped(c.capped); }} keyboardType="decimal-pad" maxLength={12} placeholder="0" left={<TextInput.Affix text="₹" />}
                   outlineStyle={{ borderRadius: radius.md }} style={{ backgroundColor: '#fff', fontSize: 28, fontWeight: '800', height: 68 }} error={!!amount && !paise}
                   accessibilityLabel={t('pay.amount')} testID="pay-amount" />
        {capped ? <Text style={{ color: '#B45309', fontWeight: '700' }} accessibilityLiveRegion="polite">{t('pay.maxIsDue', { amount: formatINR(due) })}</Text> : null}
        <BalancePreview duePaise={due} paise={paise} />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <Chip2 icon="check-all" label={`${t('pay.full')} ${formatINR(due)}`} onPress={() => setAmount(String(due / 100))} />
          {due > 0 ? <Chip2 icon="circle-half-full" label={formatINR(Math.round(due / 2))} onPress={() => setAmount(String(Math.round(due / 2) / 100))} /> : null}
        </View>
      </Panel>
      {mode === 'upi' && rental?.pay_upi_id ? (
        <UpiPay tenancyId={String(id)} ownerName={rental.owner_name} upi={rental.pay_upi_id} unit={rental.identifier} paise={paise} due={due} onReported={(p, ref) => setReported({ p, ref })} />
      ) : mode === 'cash' ? (
        <Panel title={t('upi.cashTitle')} icon="cash" tone="amber">
          <Text style={{ lineHeight: 21 }} testID="pay-cash-info">{t('upi.cashBody', { owner: rental?.owner_name ?? '' })}</Text>
        </Panel>
      ) : mode === 'none' ? (
        <Panel title={t('upi.noneTitle')} icon="information-outline" tone="amber">
          <Text style={{ lineHeight: 21 }} testID="pay-none-info">{t('upi.noneBody', { owner: rental?.owner_name ?? '' })}</Text>
        </Panel>
      ) : null}
      {mode !== 'online' ? null : unavailable ? (
        <Panel><View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Icon source="information" size={22} color={brand.amber500} /><Text style={{ flex: 1 }}>{t('pay.onlineUnavailable')}</Text></View></Panel>
      ) : <ErrorBanner error={err} />}
      {mode !== 'online' ? null : (
        <>
          <AppButton variant="accent" label={paise ? `${t('pay.title')} · ${formatINR(paise)}` : t('pay.title')} icon="lock-check" disabled={!paise || due <= 0 || paise > due} loading={busy} onPress={start} testID="pay-now" />
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 22, opacity: 0.8 }}>
            {['shield-check', 'bank', 'qrcode-scan', 'credit-card-outline'].map((ic) => <Icon key={ic} source={ic} size={24} color={brand.teal700} />)}
          </View>
        </>
      )}
    </Screen>
  );
}
