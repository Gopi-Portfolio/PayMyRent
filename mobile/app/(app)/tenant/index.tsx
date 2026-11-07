// Tenant home: nothing appears until an owner adds you. Rentals are grouped by OWNER (each with its own colour,
// verification badge and the locked mobile mapping), so several landlords are never mixed up.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, SectionList, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { DownloadButtons } from '@/components/DownloadButtons';
import { ReliefChip } from '@/components/RentRelief';
import { KIND_GROUPS, floorLabel, kindGroup, kindIcon } from '@/lib/units';
import { Avatar, DemoBanner, ErrorBanner, FilterBar, ListFilter, Metric, NO_FILTER, SlideIn, applyFilter } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/dates';
import { formatINR, payNow } from '@/lib/format';
import { OWNER_COLORS, brand, radius, shadow } from '@/theme';

function VerifyBadge({ status }: { status?: string }) {
  const { t } = useTranslation();
  const ok = status === 'verified';
  const pending = status === 'submitted';
  if (!ok && !pending) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: ok ? brand.green100 : brand.amber100, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Icon source={ok ? 'shield-check' : 'shield-half-full'} size={13} color={ok ? brand.green600 : '#B45309'} />
      <Text style={{ fontSize: 11, fontWeight: '800', color: ok ? brand.green600 : '#B45309' }}>{t(ok ? 'ownerDetails.verified' : 'ownerDetails.submitted')}</Text>
    </View>
  );
}

export default function TenantHome() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<ListFilter>(NO_FILTER);
  const rentals = useQuery({ queryKey: ['rentals'], refetchInterval: 30000, queryFn: () => api<any>('/api/v1/tenant/rentals') });   // the owner's answer and changes show up by themselves
  const updates = useQuery({ queryKey: ['updates'], refetchInterval: 30000, queryFn: () => api<any>('/api/v1/tenant/updates') });   // owner's rent / advance / cash changes
  const invites = useQuery({ queryKey: ['invites'], queryFn: () => api<any>('/api/v1/tenant/invitations') });
  const decide = async (id: string, d: 'accept' | 'reject') => {
    await api(`/api/v1/tenant/invitations/${id}/${d}`, { method: 'POST' });
    qc.invalidateQueries();
  };

  // group by owner, keeping a stable colour per owner
  const groups: { owner: any; color: (typeof OWNER_COLORS)[number]; data: any[] }[] = [];
  const allRentals: any[] = rentals.data?.items ?? [];
  const shown = applyFilter(allRentals, filter);   // totals, tiles and the list all follow the filter chips
  for (const r of shown) {
    let g = groups.find((x) => x.owner.id === r.owner_ref);
    if (!g) { g = { owner: { id: r.owner_ref, name: r.owner_name, verification: r.owner_verification, yours: r.your_mobile },
                    color: OWNER_COLORS[groups.length % OWNER_COLORS.length], data: [] }; groups.push(g); }
    g.data.push(r);
  }
  const multi = groups.length > 1;

  // totals across all my rentals, split between shops and houses (the split lines show only when I rent both kinds)
  const all: any[] = shown.filter((r: any) => r.status !== 'ended');
  const sum = (kind: string | null, f: (r: any) => number) => all.filter((r) => !kind || kindGroup(r.kind) === kind).reduce((a, r) => a + f(r), 0);
  const due = (r: any) => payNow(r);
  const dep = (r: any) => Number(r.deposit_held_paise ?? 0);
  const have = KIND_GROUPS.filter((g) => all.some((r) => kindGroup(r.kind) === g.group));     // the kinds I rent: residential, commercial
  const two = (f: (r: any) => number) => (have.length > 1 ? have.map((g) => `${t(g.label)} ${formatINR(sum(g.group, f))}`).join('\n') : undefined);

  return (
    <View style={{ flex: 1 }}>
      <DemoBanner />
      <SlideIn>
      <ErrorBanner error={rentals.error} onRetry={() => rentals.refetch()} />
      <SectionList
        sections={groups.map((g) => ({ ...g, data: g.data }))}
        keyExtractor={(r) => r.id}
        stickySectionHeadersEnabled={false}
        refreshing={rentals.isFetching}
        onRefresh={() => { rentals.refetch(); invites.refetch(); updates.refetch(); }}
        contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: 32 }}
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 4 }}>
            {allRentals.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                <Metric label={have.length > 1 ? t('owner.allUnits') : t(have[0]?.label ?? 'owner.units')} count={all.length}
                        icon={have.length === 1 ? kindIcon(have[0].group) : 'home-city-outline'} tone="blue"
                        detail={have.length > 1 ? have.map((g) => `${all.filter((r) => kindGroup(r.kind) === g.group).length} ${t(g.label)}`).join('\n') : undefined} />
                <Metric label={t('bill.totalDue')} paise={sum(null, due)} icon="clock-outline" tone="amber" detail={two(due)} />
                <Metric label={t('tenant.deposit')} paise={sum(null, dep)} icon="shield-lock-outline" tone="green" detail={two(dep)} />
              </View>
            ) : null}
            {allRentals.length > 0 ? <FilterBar items={allRentals} value={filter} onChange={setFilter} /> : null}
            {allRentals.length > 0 ? <DownloadButtons path="/api/v1/tenant/report/export" fileName="paymyrent-my-rentals" /> : null}
            {(updates.data?.items ?? []).length > 0 ? (
              <View style={[card, shadow, { borderLeftWidth: 5, borderLeftColor: brand.teal700, gap: 8 }]} testID="owner-updates">
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Icon source="bell-ring-outline" size={20} color={brand.teal700} />
                  <Text variant="titleSmall" style={{ fontWeight: '800', flex: 1 }}>{t('tenant.updates')}</Text>
                </View>
                {(updates.data.items as any[]).slice(0, 3).map((u) => (
                  <View key={u.id} style={{ gap: 2 }}>
                    <Text variant="bodyMedium">{u.text}</Text>
                    <Text variant="labelSmall" style={{ color: brand.muted }}>{fmtDate(u.created_at)}</Text>
                  </View>
                ))}
              </View>
            ) : null}
            {(invites.data?.items ?? []).map((i: any) => (
              <View key={i.id} style={[card, shadow, { borderLeftWidth: 5, borderLeftColor: brand.amber500 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Icon source="email-fast-outline" size={22} color="#B45309" />
                  <Text variant="titleSmall" style={{ fontWeight: '800', flex: 1 }}>{t('tenant.invitations')}</Text>
                  <VerifyBadge status={i.owner_verification} />
                </View>
                <Text variant="bodyMedium" style={{ marginTop: 6 }}>{`${i.owner_name} · ${i.unit}`}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
                  <Icon source="lock" size={14} color={brand.muted} />
                  <Text variant="bodySmall" style={{ color: brand.muted }}>{`${i.your_mobile} · ${t('tenant.lockedPhone')}`}</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                  <View style={{ flex: 1 }}><AppButton compact variant="outline" label={t('tenant.reject')} icon="close" onPress={() => decide(i.id, 'reject')} /></View>
                  <View style={{ flex: 1 }}><AppButton compact label={t('tenant.accept')} icon="check" testID="accept-invite" onPress={() => decide(i.id, 'accept')} /></View>
                </View>
              </View>
            ))}
          </View>
        }
        ListEmptyComponent={rentals.isLoading || (invites.data?.items ?? []).length ? undefined : (
          <View style={{ alignItems: 'center', padding: 32, gap: 12 }}>
            <View style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: brand.teal100, alignItems: 'center', justifyContent: 'center' }}>
              <Icon source="message-text-lock-outline" size={46} color={brand.teal700} />
            </View>
            <Text style={{ color: brand.muted, textAlign: 'center', lineHeight: 22 }}>{t('tenant.waiting')}</Text>
          </View>
        )}
        renderSectionHeader={({ section }: any) => (
          <View style={[ownerHeader, { backgroundColor: section.color.bg, borderColor: section.color.fg }]}>
            <Avatar name={section.owner.name} size={44} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="labelSmall" style={{ color: section.color.fg, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' }}>{t('role.switchOwner')}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Text variant="titleSmall" style={{ fontWeight: '800', color: section.color.fg }}>{section.owner.name}</Text>
                <VerifyBadge status={section.owner.verification} />
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon source="lock" size={13} color={section.color.fg} />
                <Text variant="bodySmall" style={{ color: section.color.fg }}>{section.owner.yours}</Text>
              </View>
            </View>
            {multi ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: section.color.fg }} /> : null}
          </View>
        )}
        renderItem={({ item, section }: any) => (
          <Pressable onPress={() => router.push(`/(app)/tenant/rental/${item.id}`)}
                     style={({ pressed }) => [card, shadow, { borderLeftWidth: 5, borderLeftColor: section.color.fg, marginBottom: 8 }, pressed && { backgroundColor: brand.teal50, transform: [{ scale: 0.99 }] }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ backgroundColor: section.color.bg, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 }}>
                <Text style={{ fontWeight: '800', color: section.color.fg }}>{item.identifier}</Text>
              </View>
              <Icon source={kindIcon(item.kind)} size={18} color={section.color.fg} />
              <Text variant="titleSmall" style={{ flex: 1, fontWeight: '700' }} numberOfLines={1}>{item.property_name ?? item.address}</Text>
              <Icon source="chevron-right" size={20} color={brand.muted} />
            </View>
            <Text variant="bodySmall" style={{ color: brand.muted, marginTop: 4 }} numberOfLines={1}>{item.floor !== null && item.floor !== undefined ? `${floorLabel(item.floor, t, i18n.language)} · ` : ''}{item.address}</Text>
            <ReliefChip relief={item.relief} who="renter" />
            <Text style={{ fontSize: 30, fontWeight: '800', marginTop: 12, color: payNow(item) > 0 ? '#B45309' : brand.green600 }}>{formatINR(payNow(item))}</Text>
            {Number(item.balance_paise) > payNow(item) ? <Text variant="bodySmall" style={{ color: '#B45309', fontWeight: '700' }}>{t('relief.movesToNext', { amount: formatINR(Number(item.balance_paise) - payNow(item)) })}</Text> : null}
            <Text variant="bodySmall" style={{ color: brand.muted }}>{`${t('bill.rent')} ${formatINR(item.monthly_rent_paise)} · ${t('tenant.deposit')} ${formatINR(item.deposit_held_paise)}${item.status === 'ended' ? ' · ended' : ''}`}</Text>
            <Text variant="bodySmall" style={{ color: brand.muted }}>{`${t('dates.since', { date: fmtDate(item.start_date) })}${item.latest_invoice?.due_date && payNow(item) > 0 ? ` · ${t('dates.nextDue', { date: fmtDate(item.latest_invoice.due_date) })}` : ''}`}</Text>
            {item.status === 'active' && payNow(item) > 0 ? (
              <View style={{ marginTop: 12 }}><AppButton variant="accent" label={`${t('pay.title')} · ${section.owner.name.split(' ')[0]}`} icon="cash-fast" onPress={() => router.push(`/(app)/tenant/pay/${item.id}`)} /></View>
            ) : null}
          </Pressable>
        )}
      />
      </SlideIn>
    </View>
  );
}

const card = { backgroundColor: '#fff', borderRadius: radius.lg, padding: 16 };
const ownerHeader = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, padding: 12, borderRadius: radius.lg, borderWidth: 1.5, marginTop: 10, marginBottom: 10 };
