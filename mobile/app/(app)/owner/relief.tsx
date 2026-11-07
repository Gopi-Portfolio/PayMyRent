// Renters who asked to pay less than the full month now. Tap one to answer on that renter's bill.
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import React from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { Avatar, ErrorBanner, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { fmtMonth } from '@/lib/dates';
import { formatINR } from '@/lib/format';
import { brand, radius, shadow } from '@/theme';

export default function ReliefRequests() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const q = useQuery({ queryKey: ['relief-pending', owner], queryFn: () => api<any>('/api/v1/owner/rent-relief', { ownerAccount: owner }) });
  const items: any[] = q.data?.items ?? [];
  return (
    <Screen>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {q.data && items.length === 0 ? <Text style={{ color: brand.muted, textAlign: 'center', paddingVertical: 24 }}>{t('relief.none')}</Text> : null}
      {items.map((r) => (
        <Pressable key={r.id} onPress={() => router.push(`/(app)/owner/tenancy/${r.tenancy_id}`)} testID={`relief-${r.id}`}
                   style={({ pressed }) => [{ backgroundColor: '#fff', borderRadius: radius.md, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }, shadow, pressed && { backgroundColor: brand.teal50 }]}>
          <Avatar name={r.tenant_name ?? r.identifier} />
          <View style={{ flex: 1 }}>
            <Text variant="titleSmall" style={{ fontWeight: '700' }} numberOfLines={1}>{r.tenant_name ?? r.identifier}</Text>
            <Text variant="bodySmall" style={{ color: brand.muted }} numberOfLines={2}>{`${r.identifier} · ${fmtMonth(r.period_month)} · ${t('relief.canPayShort', { amount: formatINR(r.requested_pay_paise ?? 0) })}`}</Text>
            {r.reason ? <Text variant="bodySmall" style={{ color: brand.muted }} numberOfLines={2}>{r.reason}</Text> : null}
          </View>
          <Icon source="chevron-right" size={20} color={brand.muted} />
        </Pressable>
      ))}
    </Screen>
  );
}
