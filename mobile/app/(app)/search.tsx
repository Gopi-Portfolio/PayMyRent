// The Search tab (owners). One dropdown chooses what to look at: Properties or Renters. The list appears under the search bar, the filter button sits
// inside the search bar, and a + next to the dropdown adds a property or a renter (it is blurred out until one of the two is chosen).
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { FlatList, Platform, Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { PropertyCards } from '@/components/PropertyCards';
import { ReliefChip } from '@/components/RentRelief';
import { SearchBox } from '@/components/SearchBox';
import { DemoBanner, ErrorBanner, FilterBar, ListFilter, NO_FILTER, SlideIn, applyFilter } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/dates';
import { formatINR, payNow } from '@/lib/format';
import { KindBadge } from '@/components/KindBadge';
import { floorLabel } from '@/lib/units';
import { brand, radius, shadow } from '@/theme';

type Mode = 'properties' | 'renters';
const rowStyle = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, padding: 14 };

export default function SearchTab() {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const acct = me?.owner_accounts.find((o) => o.owner_account_id === owner);
  const [mode, setMode] = useState<Mode | null>(null);          // nothing is shown until the owner chooses
  const [menu, setMenu] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');   // what is sent to the server, 300 ms after the owner stops typing
  useEffect(() => { const id = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(id); }, [q]);
  const [filter, setFilter] = useState<ListFilter>(NO_FILTER);
  const renters = mode === 'renters';
  const list = useQuery({ queryKey: ['tenancies', owner, term], enabled: renters, placeholderData: (prev) => prev, queryFn: () =>   // keep showing the last result until the new one arrives
    api<any>(`/api/v1/owner/tenancies?status=live${term ? `&q=${encodeURIComponent(term)}` : ''}`, { ownerAccount: owner }) });
  const filterOn = filter.kind !== 'all' || filter.pay !== 'all';

  function choose(m: Mode) { setMode(m); setMenu(false); setQ(''); setTerm(''); setFilter(NO_FILTER); setShowFilters(false); }
  function add() { router.push(mode === 'properties' ? '/(app)/owner/add-property' : '/(app)/owner/add-tenant'); }

  const modeLabel = mode === 'properties' ? t('searchTab.properties') : mode === 'renters' ? t('searchTab.renters') : t('searchTab.choose');
  const modeIcon = mode === 'properties' ? 'home-city-outline' : mode === 'renters' ? 'account-group-outline' : 'format-list-bulleted';

  const header = (
    <View style={{ gap: 12, marginBottom: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Pressable onPress={() => setMenu(!menu)} accessibilityRole="button" accessibilityState={{ expanded: menu }} accessibilityLabel={modeLabel} testID="search-mode"
                   style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 46, paddingHorizontal: 12, borderRadius: radius.md, backgroundColor: '#fff',
                            borderWidth: 1.5, borderColor: menu ? brand.teal700 : brand.line }}>
          <Icon source={modeIcon} size={20} color={brand.teal700} />
          <Text numberOfLines={1} style={{ flex: 1, fontWeight: '800', color: mode ? brand.ink : brand.muted }}>{modeLabel}</Text>
          <Icon source={menu ? 'menu-up' : 'menu-down'} size={24} color={brand.teal700} />
        </Pressable>
        <Pressable onPress={mode ? add : undefined} disabled={!mode} accessibilityRole="button" accessibilityState={{ disabled: !mode }} testID="search-add"
                   accessibilityLabel={mode === 'properties' ? t('property.add') : mode === 'renters' ? t('owner.addTenant') : t('searchTab.choose')}
                   style={({ pressed }) => ({ width: 46, height: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
                                              backgroundColor: pressed ? brand.teal900 : brand.teal700, opacity: mode ? 1 : 0.3 })}>
          <Icon source="plus" size={26} color="#fff" />
        </Pressable>
      </View>
      {menu ? (
        <View style={{ borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1, borderColor: brand.line, overflow: 'hidden' }}>
          {([['properties', 'home-city-outline', t('searchTab.properties')], ['renters', 'account-group-outline', t('searchTab.renters')]] as const).map(([m, icon, label], i) => (
            <Pressable key={m} onPress={() => choose(m)} accessibilityRole="button" accessibilityState={{ selected: mode === m }} testID={`search-mode-${m}`}
                       style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 13,
                                                  backgroundColor: mode === m || pressed ? brand.teal50 : '#fff', borderBottomWidth: i === 0 ? 1 : 0, borderBottomColor: brand.line })}>
              <Icon source={mode === m ? 'check-circle' : icon} size={20} color={brand.teal700} />
              <Text style={{ flex: 1, fontWeight: mode === m ? '800' : '600', color: brand.ink }}>{label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <SearchBox value={q} onChangeText={setQ} placeholder={t('common.search')} disabled={!mode} testID="search-input" filterLabel={t('searchTab.filters')}
                 filterEnabled={renters} filterActive={filterOn} onFilter={() => setShowFilters(!showFilters)} />
      {renters && showFilters ? (
        <View style={{ borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1, borderColor: brand.line, padding: 10 }} testID="search-filters">
          <FilterBar items={list.data?.items ?? []} value={filter} onChange={setFilter} />
        </View>
      ) : null}
      {renters && (acct?.property_name || acct?.property_address) ? (
        <Text style={{ color: brand.muted, fontSize: 12 }} numberOfLines={1}>{t('searchTab.forProperty', { name: acct?.property_name || acct?.property_address })}</Text>
      ) : null}
      {mode === 'properties' ? <PropertyCards term={term} /> : null}
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <DemoBanner />
      <SlideIn>
        <ErrorBanner error={renters ? list.error : null} onRetry={() => list.refetch()} />
        <FlatList
          keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          data={renters ? applyFilter<any>(list.data?.items ?? [], filter) : []}
          keyExtractor={(i: any) => String(i.id)}
          refreshing={renters && list.isFetching}
          onRefresh={() => { if (renters) list.refetch(); }}
          contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 32 }}
          ListHeaderComponent={header}
          ListEmptyComponent={!mode ? <Text style={{ color: brand.muted, textAlign: 'center', padding: 28 }}>{t('searchTab.pickPrompt')}</Text>
            : renters && !list.isLoading ? <Text style={{ color: brand.muted, textAlign: 'center', padding: 24 }}>{t('searchTab.noRenters')}</Text> : undefined}
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/(app)/owner/tenancy/${item.id}`)} style={({ pressed }) => [rowStyle, shadow, pressed && { backgroundColor: brand.teal50, transform: [{ scale: 0.99 }] }]}>
              <View style={{ flex: 1 }}>
                <Text variant="titleSmall" style={{ fontWeight: '700' }}>{item.tenant_name ?? item.identifier}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <KindBadge kind={item.unit_kind} size={18} />
                  <Text variant="bodySmall" style={{ color: brand.muted }}>
                    {`${item.identifier}${item.unit_floor !== null && item.unit_floor !== undefined ? ` · ${floorLabel(item.unit_floor, t, i18n.language)}` : ''} · ${item.status === 'invited' ? t('tenancy.invited') : t('dates.since', { date: fmtDate(item.start_date) })}`}
                  </Text>
                </View>
                <ReliefChip relief={item.relief} who="owner" />
              </View>
              {/* the same "due now" figure the renter sees on their card; anything relief moves to next month is noted, not added in */}
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ fontWeight: '800', fontSize: 16, color: payNow(item) > 0 ? brand.amber700 : brand.green600 }}>{formatINR(payNow(item))}</Text>
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
