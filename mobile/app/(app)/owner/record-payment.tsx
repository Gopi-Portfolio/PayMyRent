// Select tenant → amount → confirm. Cash is recorded immediately and labelled owner-recorded.
import { NeedsInternet } from '@/components/NeedsInternet';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, View } from 'react-native';
import React, { useRef, useState } from 'react';
import { Dialog, Icon, Portal, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { SearchableSelect } from '@/components/SearchableSelect';
import { AmountHero, BalancePreview, Chip2, ErrorBanner, Field, Panel, ResultView, Screen } from '@/components/ui';
import { goBack } from '@/components/ui';
import { api, newIdempotencyKey } from '@/lib/api';
import { Button } from '@/components/Buttons';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { capToDue, formatINR, parseRupeesToPaise, payNow } from '@/lib/format';
import { brand, radius } from '@/theme';

export default function RecordPayment() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['tenancies', owner, 'active'], queryFn: () => api<any>('/api/v1/owner/tenancies?status=active', { ownerAccount: owner }) });
  const params = useLocalSearchParams<{ tenancyId?: string }>();      // opened from a Pending / Overdue row: that renter is already chosen
  const [tenancy, setTenancy] = useState<string | null>(params.tenancyId ? String(params.tenancyId) : null);
  const [amount, setAmount] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [capped, setCapped] = useState(false);     // the last typing went over the due amount and was held at it
  const [read, setRead] = useState(false);          // the owner has read the notice and ticked the box
  const [done, setDone] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const idem = useRef(newIdempotencyKey());
  const paise = parseRupeesToPaise(amount);
  const sel = list.data?.items.find((x: any) => x.id === tenancy);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const p = await api<any>(`/api/v1/owner/tenancies/${tenancy}/payments/cash`, { ownerAccount: owner, body: { amount, idempotency_key: idem.current, cash_received_confirmed: read } });
      setDone(p);
      qc.invalidateQueries();
    } catch (e) { setErr(e); } finally { setBusy(false); setConfirm(false); }
  }

  if (done) {
    const again = () => { setDone(null); setTenancy(null); setAmount(''); setRead(false); setCapped(false); idem.current = newIdempotencyKey(); };
    return (
      <Screen>
        <NeedsInternet />
        <ResultView kind="success" title={t('pay.cashRecordedTitle', { defaultValue: 'Cash Payment Recorded' })}
                    lines={[`${sel?.tenant_name ?? ''} · ${sel?.identifier ?? ''}`, done.amount_display, `${t('pay.cashLabel')} · ${done.receipt_number}`, `${t('bill.totalDue')}: ${done.balance_after_display}`]}>
          <View style={{ backgroundColor: brand.teal50, borderRadius: radius.md, padding: 12 }} testID="cash-done-note">
            <Text style={{ lineHeight: 21, color: brand.ink, textAlign: 'center' }}>
              {t('pay.cashRecordedNote', { defaultValue: '{{name}} has been notified and can dispute this payment if it is wrong. It cannot be edited or deleted.', name: sel?.tenant_name ?? '' })}
            </Text>
          </View>
          <Button mode="outlined" icon="cash-plus" onPress={again} testID="record-another">{t('pay.recordAnother', { defaultValue: 'Record Another Payment' })}</Button>
          <Button mode="contained" icon="check" onPress={() => goBack()}>{t('common.done', { defaultValue: 'Done' })}</Button>
        </ResultView>
      </Screen>
    );
  }
  return (
    <Screen>
      <NeedsInternet />
      <Panel title={t('tenancy.tenantName')} icon="account-circle-outline">
        <SearchableSelect label={t('tenancy.tenantName')} value={tenancy} onChange={(v) => { setTenancy(v); setAmount(''); setCapped(false); }} testID="select-tenancy"
          options={(list.data?.items ?? []).map((x: any) => ({ value: x.id, label: `${x.tenant_name} · ${x.property_name ?? x.address} · ${x.identifier}`,
                                                              subtitle: formatINR(payNow(x)) }))} />
        {sel ? (
          <View style={{ backgroundColor: brand.teal50, borderRadius: radius.md, padding: 12, gap: 2 }} testID="renter-details">
            <Text style={{ fontWeight: '800', fontSize: 16 }}>{sel.tenant_name}</Text>
            <Text style={{ color: brand.ink }}>{`${sel.property_name ? `${sel.property_name} · ` : ''}${sel.identifier}`}</Text>
            {sel.address ? <Text style={{ color: brand.muted, lineHeight: 20 }}>{sel.address}</Text> : null}
          </View>
        ) : null}
      </Panel>
      {sel ? <AmountHero label={t('bill.totalDue')} paise={Math.max(0, payNow(sel))} icon="receipt-text-outline" tone="amber" compact /> : null}
      <Panel title={t('pay.amount')} icon="cash-edit" tone="green">
        <Field label={t('pay.amount')} value={amount} kind="amount"
               onChangeText={(v) => { const c = sel ? capToDue(v, Number(payNow(sel))) : { text: v, capped: false }; setAmount(c.text); setCapped(c.capped); }}
               error={amount && (paise === null || paise === 0) ? 'amount_invalid' : undefined} testID="amount" />
        {capped && sel ? <Text style={{ color: brand.amber700, fontWeight: '700' }} accessibilityLiveRegion="polite" testID="amount-capped">{t('pay.maxIsDue', { amount: formatINR(Math.max(0, payNow(sel))) })}</Text> : null}
        {sel && Number(payNow(sel)) <= 0 ? <Text style={{ color: brand.green600, fontWeight: '700' }}>{t('pay.nothingDue')}</Text> : null}
        {sel ? <BalancePreview duePaise={Number(payNow(sel))} paise={paise} /> : null}
        {sel ? <View style={{ flexDirection: 'row' }}><Chip2 icon="check-all" label={`${t('pay.full')} ${formatINR(payNow(sel))}`} onPress={() => setAmount(String(Math.max(0, payNow(sel)) / 100))} /></View> : null}
      </Panel>
      <View style={{ backgroundColor: brand.amber100, borderRadius: radius.md, padding: 14, gap: 10, borderWidth: 1, borderColor: '#F5C77E' }} testID="cash-notice">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon source="alert-decagram-outline" size={22} color={brand.amber700} />
          <Text style={{ fontWeight: '800', color: '#7A3E00' }}>{t('pay.cashNoticeTitle')}</Text>
        </View>
        <Text style={{ lineHeight: 21, color: '#5A3200' }}>{t('pay.cashNotice')}</Text>
        <Pressable onPress={() => setRead(!read)} accessibilityRole="checkbox" accessibilityState={{ checked: read }} testID="cash-read"
                   style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <Icon source={read ? 'checkbox-marked' : 'checkbox-blank-outline'} size={26} color={read ? brand.teal700 : '#7A3E00'} />
          <Text style={{ flex: 1, fontWeight: '700', color: '#5A3200' }}>{t('pay.cashRead')}</Text>
        </Pressable>
      </View>
      <ErrorBanner error={err} />
      <Button mode="contained" icon="cash-check" disabled={!tenancy || !paise || !read || !!(sel && paise > Math.max(0, Number(payNow(sel))))} onPress={() => setConfirm(true)}>{t('common.continue')}</Button>
      {tenancy && paise && !read ? <Text style={{ color: brand.amber700, fontWeight: '700' }}>{t('pay.cashTickFirst')}</Text> : null}
      <Portal>
        <Dialog visible={confirm} onDismiss={() => setConfirm(false)}>
          <Dialog.Title>{t('common.confirm')}</Dialog.Title>
          <Dialog.Content style={{ gap: 10 }}>
            <Text style={{ fontWeight: '800' }}>{`${sel?.tenant_name}\n${sel?.property_name ?? sel?.address} · ${sel?.identifier}`}</Text>
            <Text style={{ fontSize: 22, fontWeight: '800' }}>{paise ? formatINR(paise) : ''}</Text>
            <Text style={{ lineHeight: 21 }}>{t('pay.cashAuthorize')}</Text>
            <Text style={{ lineHeight: 20, color: brand.muted }}>{t('pay.cashNotifyNote', { defaultValue: 'The renter is told about this cash payment straight away and can dispute it if it is wrong.' })}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirm(false)}>{t('common.cancel')}</Button>
            <Button onPress={save} loading={busy} disabled={!read} testID="confirm-cash">{t('pay.cashConfirmBtn')}</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </Screen>
  );
}
