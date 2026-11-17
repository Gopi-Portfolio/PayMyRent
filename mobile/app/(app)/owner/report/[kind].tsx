// What is behind a home-screen box: Collected, Pending, Overdue, Units, Renters or Properties. Shows only that information.
import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { DownloadButtons } from '@/components/DownloadButtons';
import { AppButton } from '@/components/Buttons';
import { Avatar, ErrorBanner, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { fmtDate, fmtMonth } from '@/lib/dates';
import { formatINR } from '@/lib/format';
import { brand, radius, shadow } from '@/theme';

type Kind = 'collected' | 'pending' | 'overdue' | 'units' | 'renters' | 'properties';
const META: Record<Kind, { icon: string; tone: 'green' | 'amber' | 'red' | 'blue' | 'violet' | 'teal'; label: string; amount: string }> = {
  collected: { icon: 'check-circle-outline', tone: 'green', label: 'owner.collected', amount: brand.green600 },
  pending: { icon: 'clock-outline', tone: 'amber', label: 'owner.pending', amount: brand.amber700 },
  overdue: { icon: 'alert-circle-outline', tone: 'red', label: 'owner.overdue', amount: brand.red600 },
  units: { icon: 'home-city-outline', tone: 'blue', label: 'owner.units', amount: brand.ink },
  renters: { icon: 'account-group-outline', tone: 'violet', label: 'owner.allRenters', amount: brand.ink },
  properties: { icon: 'office-building-outline', tone: 'teal', label: 'owner.allProperties', amount: brand.ink },
};

// Renters, units and properties are lists you also add to: the button at the top of each opens the add screen for it.
const ADD: Partial<Record<Kind, { label: string; icon: string; to: string | { pathname: string; params: Record<string, string> } }>> = {
  renters: { label: 'owner.addTenant', icon: 'account-plus', to: '/(app)/owner/add-tenant' },
  units: { label: 'property.addPlace', icon: 'door-open', to: { pathname: '/(app)/owner/add-property', params: { units: '1' } } },
  properties: { label: 'property.add', icon: 'home-plus', to: '/(app)/owner/add-property' },
};

export default function Report() {
  const { t } = useTranslation();
  const { kind } = useLocalSearchParams<{ kind: Kind }>();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const k: Kind = (['collected', 'pending', 'overdue', 'units', 'renters', 'properties'] as const).includes(kind as Kind) ? (kind as Kind) : 'pending';
  const meta = META[k];
  const q = useQuery({ queryKey: ['dash-detail', owner, k], queryFn: () => api<any>(`/api/v1/owner/dashboard/${k}`, { ownerAccount: owner }) });
  const items: any[] = q.data?.items ?? [];
  const collectible = k === 'pending' || k === 'overdue';          // money is still owed on these two pages: cash can be received from here

  const methodLabel = (m: string) => t(m === 'cash' ? 'report.cash' : m === 'gateway' ? 'report.online' : 'report.transfer');
  const rowText = (r: any): { title: string; sub: string; amount?: number; extra?: string } => {
    const who = r.tenant_name ?? r.identifier;
    switch (k) {
      case 'collected': return { title: who, sub: `${r.identifier} · ${methodLabel(r.method)} · ${t('report.paidOn', { date: fmtDate(r.paid_on) })}`, amount: +r.amount_paise };
      case 'pending': return { title: who, sub: `${r.identifier} · ${t('report.months', { count: +r.open_months })} · ${t('dates.dueOn', { date: fmtDate(r.oldest_due) })}`, amount: +r.amount_paise };
      case 'overdue': return { title: who, sub: `${r.identifier} · ${fmtMonth(r.period_month)} · ${t('dates.dueOn', { date: fmtDate(r.due_date) })}`, amount: +r.amount_paise,
                               extra: t('report.days', { count: +r.days_overdue }) };
      case 'renters': return { title: who, sub: `${r.identifier} · ${r.property_name ?? r.address ?? ''}`, amount: +r.amount_paise };
      case 'properties': return { title: r.property_name || r.address, sub: `${r.unit_count} ${t('owner.units')} · ${r.vacant_count} ${t('report.vacant')}${r.property_name ? ` · ${r.address}` : ''}` };
      default: return { title: `${r.identifier} · ${r.property_name ?? r.address ?? ''}`, sub: r.tenant_name ? r.tenant_name : t('report.vacant'), amount: r.tenant_name ? +r.amount_paise : undefined };
    }
  };

  return (
    <Screen>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {collectible ? <AppButton label={t('report.collection')} icon="hand-coin" variant="accent" testID="collection" onPress={() => router.push('/(app)/owner/record-payment')} /> : null}
      {q.data?.total_display ? (
        <View style={[{ backgroundColor: '#fff', borderRadius: radius.lg, padding: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, shadow]}>
          <Text variant="titleSmall" style={{ color: brand.muted }}>{t('report.total')}</Text>
          <Text style={{ fontSize: 26, fontWeight: '800', color: meta.amount }}>{formatINR(+q.data.total_paise)}</Text>
        </View>
      ) : q.data ? (
        <Text variant="titleSmall" style={{ color: brand.muted }}>{`${t('report.total')}: ${items.length}`}</Text>
      ) : null}
      {q.data && items.length === 0 ? <Text style={{ color: brand.muted, textAlign: 'center', paddingVertical: 24 }}>{t('report.empty')}</Text> : null}
      {items.map((r) => {
        const x = rowText(r);
        return (
          <Pressable key={r.id ?? r.tenancy_id} disabled={!r.tenancy_id} onPress={() => router.push(`/(app)/owner/tenancy/${r.tenancy_id}`)}
                     style={({ pressed }) => [{ backgroundColor: '#fff', borderRadius: radius.md, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }, shadow, pressed && { backgroundColor: brand.teal50 }]}>
            {/* a unit is named by its number, so no first-letter circle on that list */}
            {k === 'units' ? null : <Avatar name={r.tenant_name ?? r.identifier ?? r.property_name ?? r.address} />}
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall" style={{ fontWeight: '700' }} numberOfLines={1}>{x.title}</Text>
              <Text variant="bodySmall" style={{ color: brand.muted }} numberOfLines={2}>{x.sub}</Text>
              {x.extra ? <Text variant="labelSmall" style={{ color: brand.red600, fontWeight: '800' }}>{x.extra}</Text> : null}
              {collectible && r.tenancy_id ? (
                <Pressable onPress={() => router.push({ pathname: '/(app)/owner/record-payment', params: { tenancyId: r.tenancy_id } })} hitSlop={8}
                           accessibilityRole="button" accessibilityLabel={`${t('report.collection')}: ${r.tenant_name ?? r.identifier}`} testID={`collect-${r.tenancy_id}`}
                           style={({ pressed }) => ({ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill,
                                                      backgroundColor: pressed ? '#FDE68A' : brand.amber100 })}>
                  <Icon source="hand-coin" size={15} color={brand.amber700} />
                  <Text style={{ fontSize: 12, fontWeight: '800', color: brand.amber700 }}>{t('report.collection')}</Text>
                </Pressable>
              ) : null}
            </View>
            {x.amount !== undefined ? <Text style={{ fontWeight: '800', fontSize: 16, color: meta.amount }}>{formatINR(x.amount)}</Text> : null}
            {r.tenancy_id ? <Icon source="chevron-right" size={20} color={brand.muted} /> : null}
          </Pressable>
        );
      })}
      {/* the add button and the downloads sit below the list */}
      {ADD[k] ? <AppButton label={t(ADD[k]!.label)} icon={ADD[k]!.icon} testID="report-add" onPress={() => router.push(ADD[k]!.to as any)} /> : null}
      <DownloadButtons path={`/api/v1/owner/dashboard/${k}/export`} fileName={`paymyrent-${k}`} ownerAccount={owner} />
    </Screen>
  );
}
