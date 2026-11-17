// Tenant home: nothing appears until an owner adds you. Rentals are grouped by OWNER (each with its own colour,
// verification badge and the locked mobile mapping), so several landlords are never mixed up.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, SectionList, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { DownloadButtons } from '@/components/DownloadButtons';
import { PayFlow } from '@/components/PayFlow';
import { ReliefChip } from '@/components/RentRelief';
import { RoleIcon } from '@/components/RoleIcon';
import { KindBadge } from '@/components/KindBadge';
import { KIND_GROUPS, floorLabel, kindGroup, kindIcon } from '@/lib/units';
import { DemoBanner, ErrorBanner, Metric, SlideIn } from '@/components/ui';
import { SearchableSelect } from '@/components/SearchableSelect';
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
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: ok ? brand.green100 : brand.amber100, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Icon source={ok ? 'shield-check' : 'shield-half-full'} size={13} color={ok ? brand.green600 : brand.amber700} />
      <Text style={{ fontSize: 11, fontWeight: '800', color: ok ? brand.green600 : brand.amber700 }}>{t(ok ? 'ownerDetails.verified' : 'ownerDetails.submitted')}</Text>
    </View>
  );
}

export default function TenantHome() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [pickKey, setPickKey] = useState(0);                // the Rentals tile opens the dropdown
  const [sel, setSel] = useState<string | null>(null);     // the rental shown when there are several (a dropdown picks it)
  const [paying, setPaying] = useState<any>(null);   // the rental being paid: the Pay sheet opens over this page, no new screen
  const rentals = useQuery({ queryKey: ['rentals'], refetchInterval: 30000, queryFn: () => api<any>('/api/v1/tenant/rentals') });   // the owner's answer and changes show up by themselves
  const invites = useQuery({ queryKey: ['invites'], queryFn: () => api<any>('/api/v1/tenant/invitations') });
  const decide = async (id: string, d: 'accept' | 'reject') => {
    await api(`/api/v1/tenant/invitations/${id}/${d}`, { method: 'POST' });
    qc.invalidateQueries();
  };

  // one rental on screen at a time. With one rental there is nothing to choose; with several a dropdown picks it, opening on the first that has a balance due.
  const allRentals: any[] = rentals.data?.items ?? [];
  const firstDue = allRentals.find((r) => r.status === 'active' && payNow(r) > 0) ?? allRentals[0];
  const current = allRentals.find((r) => r.id === sel) ?? firstDue;
  const ownerIds: string[] = [];
  for (const r of allRentals) if (!ownerIds.includes(r.owner_ref)) ownerIds.push(r.owner_ref);
  const groups: { owner: any; color: (typeof OWNER_COLORS)[number]; data: any[] }[] = current ? [{
    owner: { id: current.owner_ref, name: current.owner_name, verification: current.owner_verification, yours: current.your_mobile },
    color: OWNER_COLORS[Math.max(ownerIds.indexOf(current.owner_ref), 0) % OWNER_COLORS.length], data: [current] }] : [];
  const multi = false;
  const shown = allRentals;                                    // the totals and tiles cover ALL my rentals
  const rentalOptions = allRentals.map((r) => ({
    value: r.id as string, label: `${r.owner_name} · ${r.identifier}`,
    subtitle: r.status === 'ended' ? t('tenant.endedTag') : payNow(r) > 0 ? formatINR(payNow(r)) : '✓',
  }));

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
        onRefresh={() => { rentals.refetch(); invites.refetch(); }}
        contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: 32 }}
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 4 }}>
            {allRentals.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                <Metric label={have.length > 1 ? t('owner.allUnits') : t(have[0]?.label ?? 'owner.units')} count={all.length}
                        onPress={() => (allRentals.length > 1 ? setPickKey((k) => k + 1) : current ? router.push(`/(app)/tenant/rental/${current.id}`) : undefined)}
                        icon={have.length === 1 ? kindIcon(have[0].group) : 'home-city-outline'} tone="blue"
                        detail={have.length > 1 ? have.map((g) => `${all.filter((r) => kindGroup(r.kind) === g.group).length} ${t(g.label)}`).join('\n') : undefined} />
                <Metric label={t('bill.totalDue')} paise={sum(null, due)} icon="clock-outline" tone="amber" detail={two(due)}
                        onPress={() => {
                          const owing = all.filter((r) => r.status === 'active' && due(r) > 0);
                          if (owing.length === 1) setPaying({ id: owing[0].id, unit: owing[0].identifier, owner: owing[0].owner_name });   // one rental owes: the Pay sheet
                          else if (owing.length > 1) router.push('/(app)/tenant/pay');                                                     // several: pay them together
                        }} />
                <Metric label={t('tenant.deposit')} paise={sum(null, dep)} icon="shield-lock-outline" tone="green" detail={two(dep)}
                        onPress={() => (current ? router.push(`/(app)/tenant/rental/${current.id}`) : undefined)} />
              </View>
            ) : null}
            {allRentals.length > 1 ? (
              <SearchableSelect label={t('tenant.chooseRental', { defaultValue: 'Choose a rental' })} value={current?.id ?? null} options={rentalOptions} onChange={setSel} testID="rental-select" openKey={pickKey} />
            ) : null}
            {allRentals.length > 0 ? <DownloadButtons path="/api/v1/tenant/report/export" fileName="rentmeezy-my-rentals" /> : null}
            {(invites.data?.items ?? []).map((i: any) => (
              <View key={i.id} style={[card, shadow, { borderLeftWidth: 5, borderLeftColor: brand.amber500 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Icon source="email-fast-outline" size={22} color={brand.amber700} />
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
        // the owner on ONE line: the owner's own icon (not the first letter of the name), the name, and the mobile number this rental is locked to in small type
        renderSectionHeader={({ section }: any) => (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, marginTop: 8, marginBottom: 8 }} testID="owner-line">
            <RoleIcon role="owner" gender={null} size={24} />
            <Text variant="titleSmall" style={{ fontWeight: '800', color: section.color.fg, flexShrink: 1 }} numberOfLines={1}>{section.owner.name}</Text>
            <Icon source="lock" size={11} color={brand.muted} />
            <Text style={{ fontSize: 11, color: brand.muted, flexShrink: 0 }} numberOfLines={1}>{section.owner.yours}</Text>
          </View>
        )}
        renderItem={({ item, section }: any) => (
          <Pressable onPress={() => router.push(`/(app)/tenant/rental/${item.id}`)}
                     style={({ pressed }) => [card, shadow, { borderLeftWidth: 5, borderLeftColor: section.color.fg, marginBottom: 8 }, pressed && { backgroundColor: brand.teal50, transform: [{ scale: 0.99 }] }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ backgroundColor: section.color.bg, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 4 }}>
                <Text style={{ fontWeight: '800', color: section.color.fg }}>{item.identifier}</Text>
              </View>
              <KindBadge kind={item.kind} size={22} />
              <Text variant="titleSmall" style={{ flex: 1, fontWeight: '700' }} numberOfLines={1}>{item.property_name ?? item.address}</Text>
              <Icon source="chevron-right" size={20} color={brand.muted} />
            </View>
            <Text variant="bodySmall" style={{ color: brand.muted, marginTop: 4 }} numberOfLines={1}>{item.floor !== null && item.floor !== undefined ? `${floorLabel(item.floor, t, i18n.language)} · ` : ''}{item.address}</Text>
            <ReliefChip relief={item.relief} who="renter" />
            <Text style={{ fontSize: 30, fontWeight: '800', marginTop: 12, color: payNow(item) > 0 ? brand.amber700 : brand.green600 }}>{formatINR(payNow(item))}</Text>
            {Number(item.balance_paise) > payNow(item) ? <Text variant="bodySmall" style={{ color: brand.amber700, fontWeight: '700' }}>{t('relief.movesToNext', { amount: formatINR(Number(item.balance_paise) - payNow(item)) })}</Text> : null}
            <Text variant="bodySmall" style={{ color: brand.muted }}>{`${t('bill.rent')} ${formatINR(item.monthly_rent_paise)} · ${t('tenant.deposit')} ${formatINR(item.deposit_held_paise)}${item.status === 'ended' ? ` · ${t('tenant.endedTag')}` : ''}`}</Text>
            <Text variant="bodySmall" style={{ color: brand.muted }}>{`${t('dates.since', { date: fmtDate(item.start_date) })}${item.latest_invoice?.due_date && payNow(item) > 0 ? ` · ${t('dates.nextDue', { date: fmtDate(item.latest_invoice.due_date) })}` : ''}`}</Text>
            {item.status === 'active' ? (
              <View style={{ marginTop: 10 }}><AppButton compact variant="outline" icon="message-text-outline" label={t('message.toOwnerButton', { defaultValue: 'Message the owner' })} onPress={() => router.push(`/(app)/tenant/message?tenancyId=${item.id}`)} testID="message-owner" /></View>
            ) : null}
            {item.status === 'active' && payNow(item) > 0 ? (
              <View style={{ marginTop: 12 }}><AppButton variant="accent" label={`${t('pay.title')} · ${section.owner.name.split(' ')[0]}`} icon="cash-fast" onPress={() => setPaying({ id: item.id, unit: item.identifier, owner: section.owner.name })} testID="pay-open" /></View>
            ) : null}
          </Pressable>
        )}
      />
      </SlideIn>
      <Modal visible={!!paying} animationType="slide" transparent onRequestClose={() => setPaying(null)} statusBarTranslucent>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }} onPress={() => setPaying(null)} accessibilityLabel={t('common.cancel')} />
        <View style={{ maxHeight: '88%', backgroundColor: brand.canvas, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 10 }}>
          <View style={{ alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: brand.line, marginBottom: 6 }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingBottom: 6 }}>
            <Text variant="titleMedium" style={{ flex: 1, fontWeight: '800' }} numberOfLines={1}>{`${t('pay.title')} · ${paying?.unit ?? ''} · ${paying?.owner ?? ''}`}</Text>
            <Pressable onPress={() => setPaying(null)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.cancel')}><Icon source="close" size={26} color={brand.muted} /></Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
                      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 36 }}>
            {paying ? <PayFlow id={paying.id} onClose={() => { setPaying(null); rentals.refetch(); }} /> : null}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const card = { backgroundColor: '#fff', borderRadius: radius.lg, padding: 16 };
