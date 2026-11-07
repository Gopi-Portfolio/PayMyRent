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
  const [amount, setAmount] = useState('');
  const edited = useRef(false);
  // the balance is already in the box when the screen opens (the renter can still change it to pay part)
  React.useEffect(() => {
    if (!edited.current && due > 0) setAmount(due % 100 === 0 ? String(due / 100) : (due / 100).toFixed(2));
  }, [due]);
  const [capped, setCapped] = useState(false);
  const [payment, setPayment] = useState<any>(null);
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
      {unavailable ? (
        <Panel><View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Icon source="information" size={22} color={brand.amber500} /><Text style={{ flex: 1 }}>{t('pay.onlineUnavailable')}</Text></View></Panel>
      ) : <ErrorBanner error={err} />}
      <AppButton variant="accent" label={paise ? `${t('pay.title')} · ${formatINR(paise)}` : t('pay.title')} icon="lock-check" disabled={!paise || due <= 0 || paise > due} loading={busy} onPress={start} testID="pay-now" />
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 22, opacity: 0.8 }}>
        {['shield-check', 'bank', 'qrcode-scan', 'credit-card-outline'].map((ic) => <Icon key={ic} source={ic} size={24} color={brand.teal700} />)}
      </View>
    </Screen>
  );
}
