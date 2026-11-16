// Allot Renter: the renters added but not yet given a place. A small button next to each renter opens a panel right under them to pick a
// property and a unit (vacant ones first), set the rent, and press Assign. Assign creates the rental (the renter still accepts in the app) and
// tells the renter by SMS, WhatsApp and email at the mobile number and email recorded for them.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton, Button } from '@/components/Buttons';
import { type Place, PlaceSelect, isLocked } from '@/components/PlaceSelect';
import { SearchableSelect } from '@/components/SearchableSelect';
import { Avatar, ErrorBanner, Field, Panel, Screen } from '@/components/ui';
import { addMonthsDMY, dmyToIso, todayDMY } from '@/lib/dates';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { submitOrQueue } from '@/lib/offline';
import { markUnitRented } from '@/lib/optimistic';
import { queryClient } from '@/lib/queryClient';
import { amountSchema, dueDaySchema } from '@/lib/validation';
import { brand, radius } from '@/theme';

type Renter = { id: string; name: string; phone: string; email: string | null; address: string | null; id_type: string };
const firstError = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? undefined : r.error!.issues[0].message);

function AllotPanel({ renter, owner, onDone }: { renter: Renter; owner: string | null; onDone: (msg: string) => void }) {
  const { t } = useTranslation();
  const props = useQuery({ queryKey: ['properties', owner], queryFn: () => api<any>('/api/v1/owner/properties', { ownerAccount: owner }) });
  const unitsQ = useQuery({ queryKey: ['units', owner, 'active'], queryFn: () => api<any>('/api/v1/owner/units?status=active', { ownerAccount: owner }) });
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const [f, setF] = useState({ rent: '', due: '5', start: todayDMY(), end: addMonthsDMY(todayDMY(), 11), deposit: '' });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const items = props.data?.items ?? [];
  const chosen = propertyId ?? items[0]?.id;
  const units: Place[] = (unitsQ.data?.items ?? []).filter((u: any) => u.property_id === chosen);
  const e = { rent: firstError(amountSchema.safeParse(f.rent)), due: firstError(dueDaySchema.safeParse(f.due)), start: dmyToIso(f.start) ? undefined : 'date_invalid',
              end: !dmyToIso(f.end) ? 'date_invalid' : dmyToIso(f.start) && dmyToIso(f.end)! <= dmyToIso(f.start)! ? 'end_before_start' : undefined,
              deposit: f.deposit.trim() ? firstError(amountSchema.safeParse(f.deposit)) : undefined };
  const ready = !!place && !isLocked(place) && !Object.values(e).some(Boolean);

  async function assign() {
    setTouched(true);
    if (!ready || !place) return;
    setBusy(true); setErr(null);
    try {
      const body = { unit_id: place.id, monthly_rent: f.rent, due_day: Number(f.due), start_date: dmyToIso(f.start), end_date: dmyToIso(f.end), security_deposit: f.deposit || '0' };
      const sent = await submitOrQueue({
        kind: 'renter.allot', label: t('renter.itemAllot', { name: renter.name, unit: place.identifier }), path: `/api/v1/owner/renters/${renter.id}/allot`, body, ownerAccount: owner,
        optimistic: (item) => {
          markUnitRented(owner, place.id, renter.name, item.id);
          queryClient.setQueryData<{ items: Renter[] }>(['renters', owner, 'new'], (old) => (old ? { ...old, items: old.items.filter((r) => r.id !== renter.id) } : old));
        },
      });
      if (!sent.queued) {
        ['renters', 'tenancies', 'dash', 'units', 'vacant'].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
        onDone(t('renter.assigned', { name: renter.name, unit: place.identifier }));
      } else onDone(t('renter.assignedLater', { name: renter.name, unit: place.identifier }));
    } catch (x) { setErr(x); } finally { setBusy(false); }
  }

  return (
    <View style={{ gap: 12, marginTop: 10, paddingTop: 12, borderTopWidth: 1, borderTopColor: brand.line }} testID={`allot-panel-${renter.id}`}>
      {!items.length ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: '#B45309', lineHeight: 21 }}>{t('property.addYourProperty')}</Text>
          <Button mode="outlined" icon="home-plus-outline" onPress={() => router.push('/(app)/owner/add-property')}>{t('property.add')}</Button>
        </View>
      ) : (
        <>
          {items.length > 1 ? (
            <SearchableSelect label={t('tenancy.property')} value={chosen} options={items.map((p: any) => ({ value: p.id, label: p.name || p.address, subtitle: p.address }))}
                              onChange={(v) => { setPropertyId(v); setPlace(null); }} />
          ) : (
            <View style={{ backgroundColor: brand.teal50, borderRadius: radius.md, padding: 12 }}>
              <Text style={{ fontWeight: '800' }}>{items[0].name || items[0].address}</Text>
              <Text variant="bodySmall" style={{ color: brand.muted }}>{items[0].address}</Text>
            </View>
          )}
          {units.length ? <PlaceSelect places={units} selectedId={place?.id ?? null} onPick={setPlace} />
            : <Text style={{ color: '#B45309', lineHeight: 21 }} testID="no-places">{t('tenancy.noPlaces')}</Text>}
          <Button mode="outlined" icon="door-open" onPress={() => router.push({ pathname: '/(app)/owner/add-property', params: chosen ? { propertyId: String(chosen) } : {} })} testID="add-unit-link">{t('property.addPlace')}</Button>
          <Field label={t('tenancy.rent')} value={f.rent} onChangeText={set('rent')} kind="amount" error={touched ? e.rent : undefined} testID="allot-rent" />
          <Field label={t('tenancy.advanceReceived')} value={f.deposit} onChangeText={set('deposit')} kind="amount" error={touched ? e.deposit : undefined} testID="allot-advance" />
          <Field label={t('tenancy.dueDay')} value={f.due} onChangeText={set('due')} kind="day" maxNumber={31} min={1} error={touched ? e.due : undefined} testID="allot-due" />
          <Field label={`${t('tenancy.startDate')} (DD-MM-YYYY)`} value={f.start} onChangeText={set('start')} kind="date" error={touched ? e.start : undefined} testID="allot-start" />
          <Field label={`${t('tenancy.endDate')} (DD-MM-YYYY)`} value={f.end} onChangeText={set('end')} kind="date" error={touched ? e.end : undefined} testID="allot-end" />
          <Text style={{ color: brand.muted, lineHeight: 20 }} testID="assign-tells">{t('renter.assignTells', { phone: renter.phone })}</Text>
          <ErrorBanner error={err} />
          <AppButton label={t('renter.assign')} icon="send-check" onPress={assign} loading={busy} disabled={busy || !place} testID="assign-button" />
        </>
      )}
    </View>
  );
}

export default function AllotRenter() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const ver = me?.owner_accounts.find((o) => o.owner_account_id === owner)?.verification;
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ open?: string }>();
  const q = useQuery({ queryKey: ['renters', owner, 'new'], queryFn: () => api<{ items: Renter[] }>('/api/v1/owner/renters?allotted=false', { ownerAccount: owner }) });
  const [open, setOpen] = useState<string | null>(params.open ? String(params.open) : null);
  const [done, setDone] = useState<string | null>(null);

  if (me && (!ver || ver === 'rejected')) return <Redirect href="/(onboarding)/owner-details" />;
  const items = q.data?.items ?? [];
  return (
    <Screen>
      <View style={{ gap: 2 }}>
        <Text variant="titleLarge" style={{ fontWeight: '800', color: brand.ink }} accessibilityRole="header">{t('renter.allotTitle')}</Text>
        <Text style={{ color: brand.muted, lineHeight: 21 }}>{t('renter.allotIntro')}</Text>
      </View>
      {done ? (
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: brand.green100, borderRadius: radius.md, padding: 12 }} testID="allot-done">
          <Icon source="check-circle" size={22} color={brand.green600} />
          <Text style={{ flex: 1, color: brand.green600, fontWeight: '700', lineHeight: 20 }}>{done}</Text>
        </View>
      ) : null}
      {items.map((r) => (
        <Panel key={r.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }} testID={`renter-row-${r.id}`}>
            <Avatar name={r.name} size={44} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '800' }} numberOfLines={1}>{r.name}</Text>
              <Text variant="bodySmall" style={{ color: brand.muted }} numberOfLines={1}>{[r.phone, r.email].filter(Boolean).join(' · ')}</Text>
              {r.address ? <Text variant="bodySmall" style={{ color: brand.muted }} numberOfLines={1}>{r.address}</Text> : null}
            </View>
            <AppButton compact icon={open === r.id ? 'chevron-up' : 'home-plus'} label={t('renter.addPlace')} variant={open === r.id ? 'outline' : 'primary'}
                       onPress={() => setOpen(open === r.id ? null : r.id)} testID={`allot-open-${r.id}`} />
          </View>
          {open === r.id ? <AllotPanel renter={r} owner={owner} onDone={(m) => { setDone(m); setOpen(null); qc.invalidateQueries({ queryKey: ['renters'] }); }} /> : null}
        </Panel>
      ))}
      {!items.length && !q.isLoading ? <Text style={{ color: brand.muted, textAlign: 'center', padding: 20, lineHeight: 22 }} testID="no-renters">{t('renter.noneWaiting')}</Text> : null}
      <Button mode="outlined" icon="account-plus" onPress={() => router.push('/(app)/owner/add-tenant')} testID="allot-add-renter">{t('owner.addTenant')}</Button>
    </Screen>
  );
}
