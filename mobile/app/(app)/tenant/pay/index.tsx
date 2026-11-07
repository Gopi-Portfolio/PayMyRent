// Pay several rentals at once. Every rental with a balance is listed and ticked; one button pays all the ticked ones in full.
// Each rental is still its own payment to its own owner with its own receipt (the server works out every amount).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { ErrorBanner, Panel, Screen, goBack } from '@/components/ui';
import { api, newIdempotencyKey, reachable } from '@/lib/api';
import { formatINR, payNow } from '@/lib/format';
import { OWNER_COLORS, brand, radius } from '@/theme';

export default function PayManyRentals() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const rentals = useQuery({ queryKey: ['rentals'], queryFn: () => api<any>('/api/v1/tenant/rentals') });
  const owners: string[] = [];
  const due = (rentals.data?.items ?? []).filter((r: any) => r.status === 'active' && payNow(r) > 0)
    .map((r: any) => { if (!owners.includes(r.owner_account_id)) owners.push(r.owner_account_id);
                       return { ...r, color: OWNER_COLORS[owners.indexOf(r.owner_account_id) % OWNER_COLORS.length] }; });
  const [off, setOff] = useState<string[]>([]);              // rentals the renter un-ticked (everything is ticked to start with)
  const chosen = due.filter((r: any) => !off.includes(r.id));
  const total = chosen.reduce((n: number, r: any) => n + payNow(r), 0);
  const keys = useRef<Record<string, string>>({});            // one idempotency key per rental: a retry never charges twice
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [paid, setPaid] = useState<any[] | null>(null);       // results after pressing pay

  async function payAll() {
    setErr(null); setBusy(true);
    try {
      const items = chosen.map((r: any) => ({ tenancy_id: r.id, idempotency_key: (keys.current[r.id] ??= newIdempotencyKey()) }));
      const res = await api<any>('/api/v1/tenant/payments/checkout-bulk', { body: { items } });
      setPaid(res.items);
      for (const it of res.items) {                           // one payment page after another
        if (it.payment?.checkout?.pay_url) await WebBrowser.openBrowserAsync(reachable(it.payment.checkout.pay_url));
      }
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const ids = (paid ?? []).filter((i) => i.payment).map((i) => i.payment.id as string);
  const status = useQuery({
    queryKey: ['bulk-status', ids.join(',')], enabled: ids.length > 0,
    queryFn: async () => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await api<any>(`/api/v1/tenant/payments/${id}/refresh`, { method: 'POST' })]))),
    refetchInterval: (q) => (Object.values(q.state.data ?? {}).some((p: any) => p.status === 'pending') || !q.state.data ? 3000 : false),
  });

  if (paid) {
    const st: Record<string, any> = status.data ?? {};
    return (
      <Screen>
        <Panel title={t('pay.bulkTitle')} icon="receipt-text-check-outline">
          {paid.map((i) => {
            const r = due.find((x: any) => x.id === i.tenancy_id);
            const p = i.payment ? st[i.payment.id] ?? i.payment : null;
            const s = i.error ? 'failed' : p?.status;
            const ok = s === 'confirmed';
            return (
              <View key={i.tenancy_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }}>
                <Icon source={ok ? 'check-circle' : s === 'failed' ? 'close-circle' : 'clock-outline'} size={24} color={ok ? brand.green600 : s === 'failed' ? '#B42318' : '#B45309'} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700' }} numberOfLines={1}>{r ? `${r.property_name ?? r.address} · ${r.identifier}` : i.tenancy_id}</Text>
                  <Text variant="bodySmall" style={{ color: brand.muted }}>{i.error ? i.error.message : ok ? `${p.receipt_number ?? ''}` : s === 'failed' ? t('pay.failed') : t('pay.pending')}</Text>
                </View>
                <Text style={{ fontWeight: '800' }}>{p ? formatINR(p.amount_paise) : ''}</Text>
              </View>
            );
          })}
        </Panel>
        <AppButton variant="outline" icon="refresh" label={t('identity.check')} onPress={() => status.refetch()} />
        <AppButton label={t('common.continue')} icon="check" onPress={() => { qc.invalidateQueries(); goBack(); }} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Panel title={t('pay.pickTitle')} icon="cash-fast">
        {due.length === 0 ? <Text style={{ color: brand.muted }}>{t('pay.nothingDue')}</Text> : null}
        {due.map((item: any) => {
          const on = !off.includes(item.id);
          return (
            <Pressable key={item.id} onPress={() => setOff((o) => (on ? [...o, item.id] : o.filter((x) => x !== item.id)))} testID={`pay-${item.id}`}
                       accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                       style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 6, borderRadius: radius.md }, pressed && { backgroundColor: brand.teal50 }]}>
              <Icon source={on ? 'checkbox-marked' : 'checkbox-blank-outline'} size={26} color={on ? '#2563EB' : brand.muted} />
              <View style={{ flex: 1 }}>
                <Text variant="titleSmall" style={{ fontWeight: '700' }} numberOfLines={1}>{item.property_name ?? item.address} · {item.identifier}</Text>
                <Text variant="bodySmall" style={{ color: item.color.fg, fontWeight: '700' }} numberOfLines={1}>{item.owner_name}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ fontWeight: '800', fontSize: 16, color: '#B45309' }}>{formatINR(payNow(item))}</Text>
                <Pressable onPress={() => router.replace(`/(app)/tenant/pay/${item.id}`)} hitSlop={8} accessibilityLabel={t('pay.partOnly')}>
                  <Text variant="labelSmall" style={{ color: '#2563EB', fontWeight: '700' }}>{t('pay.partOnly')}</Text>
                </Pressable>
              </View>
            </Pressable>
          );
        })}
      </Panel>
      <ErrorBanner error={err} />
      <AppButton variant="accent" icon="lock-check" label={chosen.length ? `${t('pay.payAll')} (${chosen.length}) · ${formatINR(total)}` : t('pay.payAll')}
                 disabled={chosen.length === 0} loading={busy} onPress={payAll} testID="pay-all" />
    </Screen>
  );
}
