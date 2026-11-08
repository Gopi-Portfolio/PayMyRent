// Tenant pays the owner's UPI ID directly (Google Pay or any UPI app). Free: PayMyRent only records it.
// Money moves in the UPI app. Back here the tenant enters the UPI reference (UTR); the owner checks their own bank/UPI app and confirms.
import { useQueryClient } from '@tanstack/react-query';
import React, { useRef, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { ErrorBanner, Field, Panel } from '@/components/ui';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { dmyToIso, todayDMY } from '@/lib/dates';
import { formatINR } from '@/lib/format';
import { upiLink } from '@/lib/upi';
import { brand, radius } from '@/theme';

export function UpiPay({ tenancyId, ownerName, upi, unit, paise, due, onReported }: { tenancyId: string; ownerName: string; upi: string; unit: string; paise: number | null; due: number; onReported: (p: any, ref: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [ref, setRef] = useState('');
  const [date, setDate] = useState(todayDMY());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [opened, setOpened] = useState(false);
  const [noApp, setNoApp] = useState(false);
  const idem = useRef(newIdempotencyKey());
  const amountOk = !!paise && paise > 0 && paise <= due;
  const iso = dmyToIso(date);
  const refOk = /^[A-Za-z0-9-]{4,40}$/.test(ref.trim());
  const refErr = err instanceof ApiError ? err.fields?.find((x) => x.field === 'reference')?.code : undefined;

  async function open(kind: 'gpay' | 'upi') {
    if (!amountOk) return;
    setNoApp(false); setErr(null);
    const p = { vpa: upi, name: ownerName, paise: paise!, note: `Rent ${unit}`.slice(0, 40) };
    // Google Pay on iPhone has its own address; everywhere else the standard UPI link opens the phone's UPI apps (Google Pay is one of them)
    const url = kind === 'gpay' && Platform.OS === 'ios' ? upiLink('gpay://upi/pay', p) : upiLink('upi://pay', p);
    try { await Linking.openURL(url); setOpened(true); } catch { setNoApp(true); }
  }

  async function submit() {
    if (!amountOk || !refOk || !iso) return;
    setBusy(true); setErr(null);
    try {
      const out = await api<any>(`/api/v1/tenant/tenancies/${tenancyId}/payments/manual-transfer`, { body: { amount: String(paise! / 100), paid_on: iso, reference: ref.trim(), idempotency_key: idem.current } });
      qc.invalidateQueries();
      onReported(out, ref.trim());
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <>
      <Panel title={t('upi.title')} icon="cellphone-check" tone="green">
        <View style={{ backgroundColor: brand.green100, borderRadius: radius.md, padding: 12, gap: 4 }}>
          <Text style={{ color: brand.muted, fontSize: 12, fontWeight: '700' }}>{t('upi.payTo')}</Text>
          <Text style={{ fontWeight: '800', fontSize: 16 }}>{ownerName}</Text>
          <Text selectable style={{ fontWeight: '800', fontSize: 18, color: brand.green600 }} testID="upi-id">{upi}</Text>
          <Text variant="bodySmall" style={{ color: brand.muted }}>{t('upi.copyHint')}</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
          <Icon source="shield-check-outline" size={20} color={brand.teal700} />
          <Text style={{ flex: 1, lineHeight: 20 }}>{t('upi.checkName', { owner: ownerName })}</Text>
        </View>
        <AppButton variant="green" icon="google" label={`${t('upi.gpay')} · ${paise ? formatINR(paise) : ''}`} disabled={!amountOk} onPress={() => open('gpay')} testID="upi-gpay" />
        <AppButton variant="outline" icon="cellphone-arrow-down" label={t('upi.otherApp')} disabled={!amountOk} onPress={() => open('upi')} testID="upi-other" />
        {!amountOk && paise ? <Text style={{ color: '#B45309', fontWeight: '700' }}>{t('pay.maxIsDue', { amount: formatINR(due) })}</Text> : null}
        {noApp ? <Text style={{ color: '#B45309', lineHeight: 20 }} testID="upi-noapp">{t('upi.noApp')}</Text> : null}
      </Panel>
      <Panel title={t('upi.afterTitle')} icon="receipt-text-check-outline" tone={opened ? 'amber' : 'teal'}>
        <Text style={{ color: brand.muted, lineHeight: 21 }}>{t('upi.afterHint')}</Text>
        <Field label={t('upi.ref')} value={ref} onChangeText={(v) => setRef(v.replace(/[^A-Za-z0-9-]/g, '').slice(0, 40))} testID="upi-ref"
               error={refErr === 'duplicate_reference' ? t('upi.duplicate') : ref && !refOk ? t('upi.refInvalid') : undefined} />
        <Text variant="bodySmall" style={{ color: brand.muted, marginTop: -6 }}>{t('upi.refHelp')}</Text>
        <Field label={`${t('upi.paidOn')} (DD-MM-YYYY)`} value={date} onChangeText={setDate} kind="date" error={date && !iso ? 'date_invalid' : undefined} />
        <ErrorBanner error={refErr === 'duplicate_reference' ? null : err} />
        <AppButton variant="accent" icon="check-circle-outline" label={t('upi.iPaid')} disabled={!amountOk || !refOk || !iso} loading={busy} onPress={submit} testID="upi-submit" />
        <Text variant="bodySmall" style={{ color: brand.muted, lineHeight: 18 }}>{t('upi.ownerConfirms')}</Text>
      </Panel>
    </>
  );
}
