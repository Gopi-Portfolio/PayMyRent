// Manual onboarding in two short steps. Step 1 reuses an existing building address.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, Share, View } from 'react-native';
import { Icon, List, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { dmyToIso, todayDMY } from '@/lib/dates';
import { SearchableSelect } from '@/components/SearchableSelect';
import { ErrorBanner, Field, Screen } from '@/components/ui';
import { goBack } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { Button } from '@/components/Buttons';
import { brand, radius, shadow } from '@/theme';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { FloorSelect } from '@/components/FloorSelect';
import { EMPTY_PAY_HOW, PayHow, type PayHowValue, payHowBody, payHowReady, useKnownUpi } from '@/components/PayHow';
import { PlaceSelect } from '@/components/PlaceSelect';
import { KIND_GROUPS, type KindGroup, floorChip, floorLabel, kindIcon } from '@/lib/units';
import { addressSchema, amountSchema, dueDaySchema, mobileSchema, nameSchema, placeSchema } from '@/lib/validation';

const NEW = '__new__';
const firstError = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? undefined : r.error!.issues[0].message);

export default function AddTenant() {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const ver = me?.owner_accounts.find((o) => o.owner_account_id === owner)?.verification;
  const qc = useQueryClient();
  const props = useQuery({ queryKey: ['properties', owner], queryFn: () => api<any>('/api/v1/owner/properties', { ownerAccount: owner }) });
  const unitsQ = useQuery({ queryKey: ['units', owner, 'active'], queryFn: () => api<any>('/api/v1/owner/units?status=active', { ownerAccount: owner }) });
  const params = useLocalSearchParams<{ unitId?: string; identifier?: string; rent?: string }>();
  const vacantUnit = params.unitId ? { id: String(params.unitId), identifier: String(params.identifier ?? '') } : null;    // picked from the vacant list
  const [step, setStep] = useState(vacantUnit ? 2 : 1);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [unit, setUnit] = useState(vacantUnit?.identifier ?? '');
  const [f, setF] = useState({ name: '', mobile: '', rent: params.rent ? String(params.rent) : '', due: '5', start: todayDMY(), deposit: '0',
                               email: '', arrears: '', items: '', increase: '' });
  const [floor, setFloor] = useState<number | null>(null);        // the floor of a NEW unit: Ground to 10th, optional
  const [kind, setKind] = useState<KindGroup>('commercial');          // the type of a NEW unit; an existing unit keeps its own type
  const [more, setMore] = useState(false);
  const [payHow, setPayHow] = useState<PayHowValue>(EMPTY_PAY_HOW);     // how the owner wants to receive rent from THIS tenant (asked every time)
  const knownQ = useKnownUpi().data;
  const knownUpi = knownQ?.upi_ids ?? [];
  const defaultUpi = knownQ?.default_upi_id ?? null;
  // the owner's last choice is already selected (they can still pick another); nothing is chosen for a first-time owner
  React.useEffect(() => {
    const m = knownQ?.default_pay_method ?? knownQ?.last_pay_method;       // the owner's usual way (Profile), else their last choice
    if (m && !(m === 'online' && !knownQ?.online_available)) setPayHow((x) => (x.method ? x : { ...x, method: m as PayHowValue['method'] }));
  }, [knownQ?.default_pay_method, knownQ?.last_pay_method]);     // the UPI ID in the owner's profile: used for every tenant unless this one gets its own
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });

  const usingNew = false;                                   // a property is registered (with proof) and verified first; renters are added to it
  const e1 = { address: usingNew ? firstError(addressSchema.safeParse(address)) : undefined, unit: firstError(placeSchema.safeParse(unit)) };
  const e2 = { name: firstError(nameSchema.safeParse(f.name)), mobile: firstError(mobileSchema.safeParse(f.mobile)),
               rent: firstError(amountSchema.safeParse(f.rent)), due: firstError(dueDaySchema.safeParse(f.due)),
               deposit: firstError(amountSchema.safeParse(f.deposit || '0')),
               start: dmyToIso(f.start) ? undefined : 'date_invalid' };
  // units of the chosen property: an occupied one is shown locked and cannot be given to another renter until its renter is vacated
  const normUnit = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const chosenProperty = propertyId ?? props.data?.items?.[0]?.id;
  const propertyUnits: any[] = (unitsQ.data?.items ?? []).filter((u: any) => u.property_id === chosenProperty);
  // a place is building + floor + number: the same number on another floor is a different place; with no floor chosen and one place carrying the number, that place is meant
  const sameNumber = unit.trim() ? propertyUnits.filter((u: any) => normUnit(u.identifier) === normUnit(unit)) : [];
  const exact = sameNumber.find((u: any) => (u.floor ?? null) === floor) ?? (floor === null && sameNumber.length === 1 ? sameNumber[0] : undefined);
  const needFloor = floor === null && sameNumber.length > 1;
  const occupied = exact && !exact.vacant && exact.tenancy_id ? exact : undefined;
  const step1ok = !e1.unit && !!props.data?.items?.length && !occupied && !needFloor;
  const step2ok = Object.values(e2).every((x) => !x) && payHowReady(payHow, knownUpi, defaultUpi);
  const serverField = (name: string) => (err instanceof ApiError ? err.fields?.find((x) => x.field === name)?.code : undefined);

  async function submit() {
    setTouched(true);
    if (!step2ok) return;
    setBusy(true); setErr(null);
    try {
      const out = await api<any>('/api/v1/owner/tenancies', { ownerAccount: owner, body: {
        unit_id: vacantUnit?.id ?? null, property_id: vacantUnit ? null : (propertyId && propertyId !== NEW ? propertyId : props.data?.items?.[0]?.id ?? null),
        unit_identifier: vacantUnit ? '' : unit,
        tenant_name: f.name, tenant_mobile: f.mobile, monthly_rent: f.rent, due_day: Number(f.due), start_date: dmyToIso(f.start),
        increment_percent: f.increase ? Number(f.increase) : null, unit_kind: kind, unit_floor: floor, items_provided: f.items.trim() || null,
        security_deposit: f.deposit || '0', tenant_email: f.email || null, opening_arrears: f.arrears || null, ...payHowBody(payHow, knownUpi, defaultUpi) } });
      qc.invalidateQueries({ queryKey: ['tenancies'] });
      qc.invalidateQueries({ queryKey: ['upi-ids'] });
      qc.invalidateQueries({ queryKey: ['dash'] });
      qc.invalidateQueries({ queryKey: ['units'] });
      qc.invalidateQueries({ queryKey: ['vacant'] });
      if (!out.tenant_registered) await Share.share({ message: out.share_text });
      goBack();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const options = [...(props.data?.items ?? []).map((p: any) => ({ value: p.id, label: p.name || p.address, subtitle: p.address })),
                   { value: NEW, label: '+ ' + t('tenancy.property') }];

  if (me && (!ver || ver === 'rejected')) return <Redirect href="/(onboarding)/owner-details" />;
  return (
    <Screen>
      <Text variant="labelLarge" style={{ color: brand.muted }}>{`${step}/2`}</Text>
      {step === 1 ? (
        <>
          {!props.data?.items?.length ? (
            <View style={{ gap: 10 }}>
              <Text style={{ color: '#B45309', lineHeight: 21 }}>{t('property.addYourProperty')}</Text>
              <Button mode="outlined" icon="home-plus-outline" onPress={() => router.push('/(app)/owner/add-property')}>{t('property.add')}</Button>
            </View>
          ) : props.data.items.length > 1 ? (
            <SearchableSelect label={t('tenancy.property')} value={propertyId ?? props.data.items[0].id} options={options.filter((o) => o.value !== NEW)} onChange={setPropertyId} />
          ) : (
            <View style={{ backgroundColor: '#fff', borderRadius: radius.md, padding: 12, borderWidth: 1, borderColor: brand.line }}>
              <Text style={{ fontWeight: '800' }}>{props.data.items[0].name || props.data.items[0].address}</Text>
              <Text variant="bodySmall" style={{ color: brand.muted }}>{props.data.items[0].address}</Text>
            </View>
          )}
          {propertyUnits.length > 0 ? (
            <PlaceSelect places={propertyUnits} selectedId={exact?.id ?? null} onPick={(u) => { setUnit(u.identifier); setFloor(u.floor ?? null); }} />
          ) : null}
          {!vacantUnit && !exact ? (
            <View style={{ gap: 6 }} testID="unit-kind">
              <Text variant="labelLarge" style={{ color: brand.muted, fontWeight: '700' }}>{t('tenancy.placeType')}</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {KIND_GROUPS.map((g) => {
                  const on = kind === g.group;
                  return (
                    <Pressable key={g.group} onPress={() => setKind(g.group)} accessibilityRole="button" accessibilityState={{ selected: on }} testID={`kind-${g.group}`}
                               style={{ flex: 1, alignItems: 'center', gap: 4, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1.5, borderColor: on ? brand.teal700 : brand.line, backgroundColor: on ? brand.teal50 : '#fff' }}>
                      <Icon source={kindIcon(g.group)} size={22} color={on ? brand.teal700 : brand.muted} />
                      <Text style={{ fontWeight: '800', color: on ? brand.teal700 : brand.ink, fontSize: 12 }} numberOfLines={1}>{t(`tenancy.kind_${g.group}`)}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text variant="bodySmall" style={{ color: brand.muted }}>{t(kind === 'commercial' ? 'tenancy.kindCommercialHelp' : 'tenancy.kindResidentialHelp')}</Text>
            </View>
          ) : null}
          <Field label={kind === 'commercial' ? t('tenancy.unitCommercial') : t('tenancy.unit')} value={unit} onChangeText={setUnit} kind="place"
                 testID="unit-name" error={touched ? e1.unit ?? serverField('unit_identifier') : undefined} />
          <Text variant="bodySmall" style={{ color: brand.muted, marginTop: -6 }}>{t(kind === 'commercial' ? 'tenancy.unitCommercialHelp' : 'tenancy.unitHelp')}</Text>
          {!vacantUnit ? (
            <>
              <FloorSelect value={floor} onChange={setFloor} />
              <Text variant="bodySmall" style={{ color: needFloor ? '#B45309' : brand.muted, fontWeight: needFloor ? '700' : '400', marginTop: -6 }} testID={needFloor ? 'floor-needed' : 'floor-help'}>
                {needFloor ? t('tenancy.chooseFloor') : t('tenancy.floorHelp')}
              </Text>
            </>
          ) : null}
          {occupied ? <Text style={{ color: brand.red600, fontWeight: '700' }} testID="unit-occupied">{t('tenancy.unitOccupied', { unit: `${occupied.identifier}${occupied.floor !== null && occupied.floor !== undefined ? ` (${floorLabel(occupied.floor, t, i18n.language)})` : ''}`, name: occupied.tenant_name ?? '' })}</Text> : null}
          <Button mode="contained" disabled={!!occupied || needFloor} onPress={() => { setTouched(true); if (step1ok) { setTouched(false); setStep(2); } }} contentStyle={{ height: 52 }}>
            {t('common.continue')}
          </Button>
          {/* bulk Excel import: not needed every time, so it sits at the bottom as a quiet row */}
          <Pressable onPress={() => router.push('/(app)/owner/import')} accessibilityRole="button" testID="import-excel-from-add"
                     style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.md,
                                                borderWidth: 1, borderColor: brand.line, borderStyle: 'dashed', backgroundColor: pressed ? brand.green100 : 'transparent' }]}>
            <Icon source="file-excel-outline" size={20} color={brand.green600} />
            <Text variant="bodyMedium" style={{ flex: 1, color: brand.muted, fontWeight: '700' }}>{t('owner.import')} · .xlsx</Text>
            <Icon source="chevron-right" size={18} color={brand.muted} />
          </Pressable>
        </>
      ) : (
        <>
          {vacantUnit ? <Text variant="titleMedium" style={{ fontWeight: '800' }}>{`${t('property.addRenter')} · ${vacantUnit.identifier}`}</Text> : null}
          <Field label={t('tenancy.tenantName')} value={f.name} onChangeText={set('name')} kind="name" error={touched ? e2.name : undefined} />
          <Field label={t('tenancy.tenantMobile')} value={f.mobile} onChangeText={set('mobile')} kind="mobile" error={touched ? e2.mobile : undefined} />
          <Field label={t('tenancy.rent')} value={f.rent} onChangeText={set('rent')} kind="amount" error={touched ? e2.rent : undefined} />
          <Field label={t('tenancy.dueDay')} value={f.due} onChangeText={set('due')} kind="day" maxNumber={31} min={1} error={touched ? e2.due : undefined} />
          <Field label={`${t('tenancy.startDate')} (DD-MM-YYYY)`} value={f.start} onChangeText={set('start')} kind="date" error={touched ? e2.start : undefined} />
          <Field label={t('tenancy.deposit')} value={f.deposit} onChangeText={set('deposit')} kind="amount" error={touched ? e2.deposit : undefined} />
          <Field label={t('tenancy.itemsProvided')} value={f.items} onChangeText={set('items')} multiline lines={4} maxLength={2000} testID="items-provided-input" />
          <Text variant="bodySmall" style={{ color: brand.muted, marginTop: -6 }}>{t('tenancy.itemsHelp')}</Text>
          <PayHow value={payHow} onChange={setPayHow} showErrors={touched} />
          <List.Accordion title={t('common.optional')} expanded={more} onPress={() => setMore(!more)}>
            <View style={{ gap: 12, paddingVertical: 12 }}>
              <Field label={t('agreement.yearlyIncrease')} value={f.increase} onChangeText={set('increase')} kind="percent" maxNumber={100} testID="yearly-increase" />
              <Field label="Email" value={f.email} onChangeText={set('email')} kind="email" />
              <Field label={t('bill.arrears')} value={f.arrears} onChangeText={set('arrears')} kind="amount" />
            </View>
          </List.Accordion>
          <ErrorBanner error={err} />
          <Button mode="contained" onPress={submit} loading={busy} disabled={busy} contentStyle={{ height: 52 }} testID="submit-tenancy">
            {t('common.save')}
          </Button>
          {vacantUnit ? null : <Button onPress={() => setStep(1)}>{'‹ 1/2'}</Button>}
        </>
      )}
    </Screen>
  );
}
