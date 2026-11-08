// Owner home: 4 metrics, 4 shortcuts, searchable tenant list. One screen, minimal scrolling.
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { FlatList, View } from 'react-native';
import { Banner, Icon, Searchbar, Text } from 'react-native-paper';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

import { PropertySwitcher } from '@/components/PropertySwitcher';
import { HeroAction, MiniAction } from '@/components/QuickActions';
import { ReliefChip } from '@/components/RentRelief';
import { KIND_GROUPS, floorLabel, kindIcon } from '@/lib/units';
import { Avatar, DemoBanner, ErrorBanner, FilterBar, ListFilter, NO_FILTER, SlideIn, IdentityRow, Metric, applyFilter } from '@/components/ui';
import { brand, radius, shadow } from '@/theme';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/dates';
import { formatINR } from '@/lib/format';

// The Vacant button is hidden for now (asked for). The vacant list, its "add renter" rows and the data behind them are all still here: set this to true to show the button again.
const SHOW_VACANT_BUTTON = false;

const rowStyle = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, padding: 14 };

// "Shops ₹x / Houses ₹y / Commercials ₹z" under a money total, for the kinds the owner has (shown when there are at least two)
function split(m: any, k: 'collected' | 'pending' | 'overdue', t: (key: string) => string): string | undefined {
  const have = KIND_GROUPS.filter((g) => (m?.[g.total] ?? 0) > 0);
  if (!m || have.length < 2) return undefined;
  return have.map((g) => `${t(g.label)} ${m[`${k}_${g.total}_paise`].display}`).join('\n');
}

export default function OwnerHome() {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');   // what is sent to the server, 300 ms after the owner stops typing
  useEffect(() => { const id = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(id); }, [q]);
  const [filter, setFilter] = useState<ListFilter>(NO_FILTER);
  const dash = useQuery({ queryKey: ['dash', owner], queryFn: () => api<any>('/api/v1/owner/dashboard', { ownerAccount: owner }) });
  // units with no renter (e.g. after the renter's period ended and they moved out): one tap to add a new renter
  const [showVacant, setShowVacant] = useState(false);
  const vacant = useQuery({ queryKey: ['vacant', owner], queryFn: () => api<any>('/api/v1/owner/units?vacant=true', { ownerAccount: owner }) });
  const vacantUnits: any[] = vacant.data?.items ?? [];
  const list = useQuery({ queryKey: ['tenancies', owner, term], placeholderData: (prev) => prev, queryFn: () =>   // keep showing the last result until the new one arrives
    api<any>(`/api/v1/owner/tenancies?status=live${term ? `&q=${encodeURIComponent(term)}` : ''}`, { ownerAccount: owner }) });
  const transfers = useQuery({ queryKey: ['transfers', owner], refetchInterval: 20000, queryFn: () => api<any>('/api/v1/owner/payments/pending-transfers', { ownerAccount: owner }) });
  const transferCount: number = transfers.data?.items?.length ?? 0;      // UPI payments tenants reported, waiting for the owner to check and confirm
  // tenants with no chosen way of receiving rent yet (older tenants): the owner is asked to choose
  const unsetPay: any[] = term ? [] : (list.data?.items ?? []).filter((x: any) => !x.effective_pay_method);
  const m = dash.data?.metrics;
  const state = dash.data?.subscription.state;
  const acct = me?.owner_accounts.find((o) => o.owner_account_id === owner);
  const propStatus = acct?.property_status ?? null;

  return (
    <View style={{ flex: 1 }}>
      <DemoBanner />
      <SlideIn>
      {!acct?.verification || acct.verification === 'rejected' ? (
        <Banner visible icon="badge-account-horizontal" actions={[{ label: t('ownerDetails.submit'), onPress: () => router.push('/(onboarding)/owner-details') }]}>
          {t('ownerDetails.banner')}
        </Banner>
      ) : null}
      {state === 'read_only' || state === 'none' ? (
        <Banner visible icon="lock" actions={[{ label: t('pricing.cta'), onPress: () => router.push('/(onboarding)/plan') }]}>
          {state === 'none' ? t('owner.subscriptionNeeded') : t('owner.readOnly')}
        </Banner>
      ) : null}
      {(state === 'active' || state === 'grace') && !propStatus ? (
        <Banner visible icon="home-plus-outline" actions={[{ label: t('property.add'), onPress: () => router.push('/(app)/owner/add-property') }]}>{t('property.addYourProperty')}</Banner>
      ) : null}
      {propStatus === 'submitted' ? <Banner visible icon="clock-outline">{t('property.verifying')}</Banner> : null}
      {unsetPay.length > 0 ? (
        <Banner visible icon="wallet-outline" actions={[{ label: t('payhow.bulkCta'), onPress: () => router.push('/(app)/owner/payment-method') }]}>{t('payhow.banner', { count: unsetPay.length })}</Banner>
      ) : null}
      {transferCount > 0 ? (
        <Banner visible icon="cellphone-check" actions={[{ label: t('relief.review'), onPress: () => router.push('/(app)/owner/transfers') }]}>{t('transfers.banner', { count: transferCount })}</Banner>
      ) : null}
      {(m?.relief_pending ?? 0) > 0 ? (
        <Banner visible icon="hand-heart-outline" actions={[{ label: t('relief.review'), onPress: () => router.push('/(app)/owner/relief') }]}>{t('relief.bannerOwner', { count: m.relief_pending })}</Banner>
      ) : null}
      {(m?.vacate_pending ?? 0) > 0 ? (
        <Banner visible icon="door-open" actions={[{ label: t('relief.review'), onPress: () => router.push('/(app)/owner/vacate') }]}>{t('vacate.bannerOwner', { count: m.vacate_pending })}</Banner>
      ) : null}
      {propStatus === 'rejected' ? (
        <Banner visible icon="alert-circle-outline" actions={[{ label: t('property.add'), onPress: () => router.push('/(app)/owner/add-property') }]}>{t('property.rejected')}</Banner>
      ) : null}
      <ErrorBanner error={dash.error || list.error} onRetry={() => { dash.refetch(); list.refetch(); }} />
      <FlatList
        data={showVacant ? vacantUnits : applyFilter<any>(list.data?.items ?? [], filter)}
        keyExtractor={(i: any) => `${i.vacant ? 'v' : 't'}${i.id}`}
        refreshing={list.isFetching}
        onRefresh={() => list.refetch()}
        contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 32 }}
        ListHeaderComponent={
          <View style={{ gap: 16, marginBottom: 6 }}>
            <PropertySwitcher />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              <Metric label={t('owner.collected')} paise={m?.collected_paise.value ?? 0} detail={split(m, 'collected', t)} icon="check-circle-outline" tone="green" onPress={() => router.push('/(app)/owner/report/collected')} />
              <Metric label={t('owner.pending')} paise={m?.pending_paise.value ?? 0} detail={split(m, 'pending', t)} icon="clock-outline" tone="amber" onPress={() => router.push('/(app)/owner/report/pending')} />
              <Metric label={t('owner.overdue')} paise={m?.overdue_paise.value ?? 0} detail={split(m, 'overdue', t)} icon="alert-circle-outline" tone="red" onPress={() => router.push('/(app)/owner/report/overdue')} />
              {/* every place the owner lets out, with how many of each kind: residential and commercial */}
              <Metric label={t('owner.allUnits')} count={m?.units ?? 0} icon="home-city-outline" tone="blue"
                      detail={KIND_GROUPS.map((g) => `${m?.[g.total] ?? 0} ${t(g.label)}`).join('\n')}
                      onPress={() => router.push('/(app)/owner/report/units')} />
            </View>
            {/* the two things done most are big cards; then one row of Reminders, Ask AI and Approvals. The same for every owner. */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <HeroAction icon="account-plus" label={t('owner.addTenant')} sub={t('owner.addTenantSub')} note={vacant.data ? { label: t('property.vacant'), value: vacantUnits.length } : undefined} colors={['#0F766E', '#14B8A6']} testID="add-tenant"
                          onPress={() => router.push('/(app)/owner/add-tenant')} />
              <HeroAction icon="hand-coin" label={t('owner.recordPayment')} sub={t('owner.recordPaymentSub')} colors={['#B45309', '#F59E0B']} testID="record-payment"
                          onPress={() => router.push('/(app)/owner/record-payment')} />
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <MiniAction icon="bell-ring" label={t('owner.reminders')} fg="#B45309" bg={brand.amber100} onPress={() => router.push('/(app)/owner/ai')} />
              <MiniAction icon="creation" label={t('owner.askAi')} fg={brand.blue600} bg={brand.blue100} onPress={() => router.push('/(app)/owner/ai')} />
              <MiniAction icon="thumb-up-outline" label={t('owner.approvals')} fg={brand.red600} bg={brand.red100} count={m?.approvals_pending ?? 0} clearText={t('owner.allClear')} testID="approvals"
                          onPress={() => router.push('/(app)/owner/approvals')} />
              {SHOW_VACANT_BUTTON ? (
                <MiniAction icon="door-open" label={t('property.vacant')} fg="#7C3AED" bg="#EDE9FE" count={vacantUnits.length} active={showVacant} testID="metric-compact"
                            onPress={() => setShowVacant(!showVacant)} />
              ) : null}
            </View>
            {me?.identity_status !== 'verified' ? <IdentityRow /> : null}
            {showVacant ? null : (
              <>
                <Searchbar placeholder={t('common.search')} value={q} onChangeText={setQ} style={{ backgroundColor: '#fff', borderRadius: radius.md }} elevation={0} />
                <FilterBar items={list.data?.items ?? []} value={filter} onChange={setFilter} />
              </>
            )}
          </View>
        }
        ListEmptyComponent={showVacant ? <Text style={{ color: brand.muted, textAlign: 'center', padding: 24 }}>{t('property.noVacant')}</Text> : undefined}
        renderItem={({ item }) => item.vacant ? (
          <View style={[rowStyle, shadow]}>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: brand.amber100, alignItems: 'center', justifyContent: 'center' }}>
              <Icon source={kindIcon(item.kind)} size={24} color="#B45309" />
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall" style={{ fontWeight: '800' }} numberOfLines={1}>{t('property.unitNo', { unit: item.identifier })}{item.floor !== null && item.floor !== undefined ? ` · ${floorLabel(item.floor, t, i18n.language)}` : ''}</Text>
              <Text variant="bodySmall" style={{ color: brand.muted }} numberOfLines={1}>{item.property_name ?? item.address}</Text>
              <Text variant="bodySmall" style={{ color: '#B45309', fontWeight: '700' }}>{item.vacant_since ? t('property.vacantSince', { date: fmtDate(item.vacant_since) }) : t('property.neverLet')}</Text>
              {item.last_rent_paise ? <Text variant="bodySmall" style={{ color: brand.muted }}>{`${t('tenancy.rent')}: ${formatINR(item.last_rent_paise)}`}</Text> : null}
            </View>
            <Pressable onPress={() => router.push({ pathname: '/(app)/owner/add-tenant', params: { unitId: item.id, identifier: item.identifier, rent: item.last_rent_paise ? String(Math.round(item.last_rent_paise / 100)) : '' } })}
                       accessibilityRole="button" testID="add-renter-to-vacant"
                       style={{ backgroundColor: brand.teal700, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', gap: 6, alignItems: 'center' }}>
              <Icon source="account-plus" size={18} color="#fff" />
              <Text style={{ color: '#fff', fontWeight: '800' }}>{t('property.addRenter')}</Text>
            </Pressable>
          </View>
        ) : (
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
            <Text style={{ fontWeight: '800', fontSize: 16, color: item.balance_paise > 0 ? '#B45309' : brand.green600 }}>{formatINR(item.balance_paise)}</Text>
            <Icon source="chevron-right" size={20} color={brand.muted} />
          </Pressable>
        )}
      />
      </SlideIn>
    </View>
  );
}
