// The Search tab (owners): the search bar, the filters and the list of renters, moved here from the dashboard.
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { FlatList, Platform, Pressable, View } from 'react-native';
import { Icon, Searchbar, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { PropertySwitcher } from '@/components/PropertySwitcher';
import { ReliefChip } from '@/components/RentRelief';
import { Avatar, DemoBanner, ErrorBanner, FilterBar, ListFilter, NO_FILTER, SlideIn, applyFilter } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/dates';
import { formatINR, payNow } from '@/lib/format';
import { floorLabel, kindIcon } from '@/lib/units';
import { brand, radius, shadow } from '@/theme';

const rowStyle = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, padding: 14 };

export default function SearchTab() {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');   // what is sent to the server, 300 ms after the owner stops typing
  useEffect(() => { const id = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(id); }, [q]);
  const [filter, setFilter] = useState<ListFilter>(NO_FILTER);
  const list = useQuery({ queryKey: ['tenancies', owner, term], placeholderData: (prev) => prev, queryFn: () =>   // keep showing the last result until the new one arrives
    api<any>(`/api/v1/owner/tenancies?status=live${term ? `&q=${encodeURIComponent(term)}` : ''}`, { ownerAccount: owner }) });

  return (
    <View style={{ flex: 1 }}>
      <DemoBanner />
      <SlideIn>
        <ErrorBanner error={list.error} onRetry={() => list.refetch()} />
        <FlatList
          keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          data={applyFilter<any>(list.data?.items ?? [], filter)}
          keyExtractor={(i: any) => String(i.id)}
          refreshing={list.isFetching}
          onRefresh={() => list.refetch()}
          contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 32 }}
          ListHeaderComponent={
            <View style={{ gap: 16, marginBottom: 6 }}>
              <PropertySwitcher />
              <Searchbar placeholder={t('common.search')} value={q} onChangeText={setQ} style={{ backgroundColor: '#fff', borderRadius: radius.md }} elevation={0} testID="search-input" />
              <FilterBar items={list.data?.items ?? []} value={filter} onChange={setFilter} />
            </View>
          }
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/(app)/owner/tenancy/${item.id}`)} style={({ pressed }) => [rowStyle, shadow, pressed && { backgroundColor: brand.teal50, transform: [{ scale: 0.99 }] }]}>
              <Avatar name={item.tenant_name ?? item.identifier} />
              <View style={{ flex: 1 }}>
                <Text variant="titleSmall" style={{ fontWeight: '700' }}>{item.tenant_name ?? item.identifier}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Icon source={kindIcon(item.unit_kind)} size={14} color={brand.muted} />
                  <Text variant="bodySmall" style={{ color: brand.muted }}>
                    {`${item.identifier}${item.unit_floor !== null && item.unit_floor !== undefined ? ` · ${floorLabel(item.unit_floor, t, i18n.language)}` : ''} · ${item.status === 'invited' ? t('tenancy.invited') : t('dates.since', { date: fmtDate(item.start_date) })}`}
                  </Text>
                </View>
                <ReliefChip relief={item.relief} who="owner" />
              </View>
              {/* the same "due now" figure the renter sees on their card; anything relief moves to next month is noted, not added in */}
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ fontWeight: '800', fontSize: 16, color: payNow(item) > 0 ? '#B45309' : brand.green600 }}>{formatINR(payNow(item))}</Text>
                {Number(item.balance_paise) > payNow(item) ? <Text variant="labelSmall" style={{ color: brand.muted }}>{t('relief.movesToNext', { amount: formatINR(Number(item.balance_paise) - payNow(item)) })}</Text> : null}
              </View>
              <Icon source="chevron-right" size={20} color={brand.muted} />
            </Pressable>
          )}
        />
      </SlideIn>
    </View>
  );
}
