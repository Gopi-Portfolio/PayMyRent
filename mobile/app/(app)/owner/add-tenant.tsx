// Manual onboarding in two short steps. Step 1 reuses an existing building address.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Banner, Icon, List, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { addMonthsDMY, dmyToIso, todayDMY } from '@/lib/dates';
import { SearchableSelect } from '@/components/SearchableSelect';
import { ErrorBanner, Field, Screen } from '@/components/ui';
import { goBack } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { Button } from '@/components/Buttons';
import { brand, radius, shadow } from '@/theme';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { EMPTY_PAY_HOW, PayHow, type PayHowValue, payHowBody, payHowReady, useKnownUpi } from '@/components/PayHow';
import { type Place, PlaceSelect, isLocked } from '@/components/PlaceSelect';
import { amountSchema, dueDaySchema, mobileSchema, nameSchema } from '@/lib/validation';

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
  // no active plan: the server would refuse the renter only after the whole form is filled in, so say so first
  const subQ = useQuery({ queryKey: ['subscription', owner], queryFn: () => api<any>('/api/v1/subscription', { ownerAccount: owner }) });
  const planState: string | undefined = subQ.data?.state;
  const planBlocked = planState === 'none' || planState === 'read_only';
  const params = useLocalSearchParams<{ unitId?: string; identifier?: string; rent?: string }>();
  const vacantUnit = params.unitId ? { id: String(params.unitId), identifier: String(params.identifier ?? '') } : null;    // picked from the vacant list
  const [step, setStep] = useState(vacantUnit ? 2 : 1);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [place, setPlace] = useState<Place | null>(null);        // the place picked from the property's list: nothing new is typed here
  const [f, setF] = useState({ name: '', mobile: '', rent: params.rent ? String(params.rent) : '', due: '5', start: todayDMY(), end: addMonthsDMY(todayDMY(), 11), deposit: '',
                               email: '', arrears: '', items: '', increase: '' });
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
  // an owner with no usual way of receiving rent yet is asked on this form; everyone else has it already chosen and can change it under More Details
  const needsPayChoice = knownQ !== undefined && !(knownQ.default_pay_method ?? knownQ.last_pay_method);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  // a yes or no from the server: is the person with this number a renter whose photo ID is verified? (nothing else about them is shown)
  const mobileOk = !firstError(mobileSchema.safeParse(f.mobile));
  const idCheck = useQuery({ queryKey: ['renter-check', f.mobile], enabled: mobileOk, staleTime: 5 * 60_000, retry: false,
                             queryFn: () => api<{ id_verified: boolean }>(`/api/v1/owner/renter-check?mobile=${encodeURIComponent(f.mobile)}`, { ownerAccount: owner }) });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });

  const e2 = { name: firstError(nameSchema.safeParse(f.name)), mobile: firstError(mobileSchema.safeParse(f.mobile)),
               rent: firstError(amountSchema.safeParse(f.rent)), due: firstError(dueDaySchema.safeParse(f.due)),
               // the advance received must be entered and be more than zero
               deposit: !f.deposit.trim() ? 'required' : Number(f.deposit.replace(/,/g, '')) > 0 ? firstError(amountSchema.safeParse(f.deposit)) : 'must_be_positive',
               start: dmyToIso(f.start) ? undefined : 'date_invalid',
               // both dates are required, and the end comes after the start
               end: !dmyToIso(f.end) ? (f.end.trim() ? 'date_invalid' : 'required') : dmyToIso(f.start) && dmyToIso(f.end)! <= dmyToIso(f.start)! ? 'end_before_start' : undefined };
  // the places of the chosen property: a free one can be picked; an occupied one is shown locked until its renter is vacated.
  // New places are added on the Add Property screen, never here.
  const chosenProperty = propertyId ?? props.data?.items?.[0]?.id;
  const propertyUnits: Place[] = (unitsQ.data?.items ?? []).filter((u: any) => u.property_id === chosenProperty);
  const freePlaces = propertyUnits.filter((u) => !isLocked(u));
  const step1ok = !!props.data?.items?.length && !!place && !isLocked(place) && !planBlocked;
  const step2ok = Object.values(e2).every((x) => !x) && payHowReady(payHow, knownUpi, defaultUpi);

  async function submit() {
    setTouched(true);
    if (!step2ok) { if (e2.due || e2.start || e2.end || !payHowReady(payHow, knownUpi, defaultUpi)) setMore(true); return; }       // open the details that need fixing
    setBusy(true); setErr(null);
    try {
      const out = await api<any>('/api/v1/owner/tenancies', { ownerAccount: owner, body: {
        unit_id: vacantUnit?.id ?? place?.id ?? null, property_id: null, unit_identifier: '',
        tenant_name: f.name, tenant_mobile: f.mobile, monthly_rent: f.rent, due_day: Number(f.due), start_date: dmyToIso(f.start), end_date: dmyToIso(f.end),
        increment_percent: f.increase ? Number(f.increase) : null, items_provided: f.items.trim() || null,
        security_deposit: f.deposit, tenant_email: f.email || null, opening_arrears: f.arrears || null, ...payHowBody(payHow, knownUpi, defaultUpi) } });
      qc.invalidateQueries({ queryKey: ['tenancies'] });
      qc.invalidateQueries({ queryKey: ['upi-ids'] });
      qc.invalidateQueries({ queryKey: ['dash'] });
      qc.invalidateQueries({ queryKey: ['units'] });
      qc.invalidateQueries({ queryKey: ['vacant'] });
      // the server texts the number (and notifies a registered renter) by itself: nothing for the owner to send
      goBack();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const options = [...(props.data?.items ?? []).map((p: any) => ({ value: p.id, label: p.name || p.address, subtitle: p.address })),
                   { value: NEW, label: '+ ' + t('tenancy.property') }];

  if (me && (!ver || ver === 'rejected')) return <Redirect href="/(onboarding)/owner-details" />;
  return (
    <Screen>
      {planBlocked ? (
        <Banner visible icon="lock" actions={[{ label: t('pricing.cta'), onPress: () => router.push('/(onboarding)/plan') }]} testID="plan-needed">
          {planState === 'none' ? t('owner.subscriptionNeeded') : t('owner.readOnly')}
        </Banner>
      ) : null}
      {/* which step this is and what it is for, so it is clear what to do on each screen */}
      <View style={{ gap: 2 }} testID="step-header">
        {vacantUnit ? null : <Text variant="labelLarge" style={{ color: brand.teal700, fontWeight: '800' }}>{t('tenancy.stepOf', { n: step })}</Text>}
        <Text variant="titleLarge" style={{ fontWeight: '800', color: brand.ink }} accessibilityRole="header">{step === 1 ? t('tenancy.step1Title') : t('tenancy.step2Title')}</Text>
        {step === 1 ? <Text style={{ color: brand.muted, lineHeight: 21 }}>{t('tenancy.step1Help')}</Text> : null}
      </View>
      {step === 1 ? (
        <>
          {!props.data?.items?.length ? (
            <View style={{ gap: 10 }}>
              <Text style={{ color: '#B45309', lineHeight: 21 }}>{t('property.addYourProperty')}</Text>
              <Button mode="outlined" icon="home-plus-outline" onPress={() => router.push('/(app)/owner/add-property')}>{t('property.add')}</Button>
            </View>
          ) : props.data.items.length > 1 ? (
            <SearchableSelect label={t('tenancy.property')} value={propertyId ?? props.data.items[0].id} options={options.filter((o) => o.value !== NEW)} onChange={(v) => { setPropertyId(v); setPlace(null); }} />
          ) : (
            <View style={{ backgroundColor: '#fff', borderRadius: radius.md, padding: 12, borderWidth: 1, borderColor: brand.line }}>
              <Text style={{ fontWeight: '800' }}>{props.data.items[0].name || props.data.items[0].address}</Text>
              <Text variant="bodySmall" style={{ color: brand.muted }}>{props.data.items[0].address}</Text>
            </View>
          )}
          {propertyUnits.length > 0 ? (
            <PlaceSelect places={propertyUnits} selectedId={place?.id ?? null} onPick={setPlace} />
          ) : (
            <Text style={{ color: '#B45309', lineHeight: 21 }} testID="no-places">{t('tenancy.noPlaces')}</Text>
          )}
          <Button mode="contained" icon="account-plus" disabled={!step1ok} onPress={() => { setTouched(false); setStep(2); }} contentStyle={{ height: 52 }} testID="step1-continue">
            {place ? t('tenancy.addRenterTo', { unit: place.identifier }) : t('owner.addTenant')}
          </Button>
          {/* why Continue is greyed out */}
          {!step1ok && !planBlocked && propertyUnits.length > 0 ? <Text style={{ color: '#B45309', fontWeight: '700', textAlign: 'center' }} testID="choose-unit-hint">{t('tenancy.chooseUnitFirst')}</Text> : null}
          {/* nothing new is typed here: Add a Unit and Add Property open the Add Property screen, the one place where properties and units are entered.
              When the plan's property limit is reached, the second button says so and takes the owner to the plans instead. */}
          {(() => {
            const acct = me?.owner_accounts.find((o) => o.owner_account_id === owner);
            const cap = acct?.property_capacity ?? 1, used = acct?.property_count ?? props.data?.items?.length ?? 0;
            const room = cap > used;
            return (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Button mode="outlined" icon="door-open" onPress={() => router.push({ pathname: '/(app)/owner/add-property', params: chosenProperty ? { propertyId: String(chosenProperty) } : {} })} testID="add-place-link">
                    {t('property.addPlace')}
                  </Button>
                </View>
                <View style={{ flex: 1 }}>
                  {room ? (
                    <Button mode="outlined" icon="home-plus-outline" onPress={() => router.push('/(app)/owner/add-property')} testID="add-property-link">
                      {t('property.add')}
                    </Button>
                  ) : (
                    <Button mode="outlined" icon="arrow-up-circle-outline" onPress={() => router.push('/(onboarding)/plan')} testID="upgrade-plan-link">
                      {t('property.upgradeForMore')}
                    </Button>
                  )}
                </View>
              </View>
            );
          })()}
          {/* bulk Excel import: not needed every time, so it sits at the bottom as a quiet row */}
          <Pressable onPress={() => router.push('/(app)/owner/import')} accessibilityRole="button" testID="import-excel-from-add"
                     style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.md,
                                                borderWidth: 1, borderColor: brand.line, borderStyle: 'dashed', backgroundColor: pressed ? brand.green100 : 'transparent' }]}>
            <Icon source="file-excel-outline" size={20} color={brand.green600} />
            <Text variant="bodyMedium" style={{ flex: 1, color: brand.muted, fontWeight: '700' }}>{t('import.title')}</Text>
            <Icon source="chevron-right" size={18} color={brand.muted} />
          </Pressable>
        </>
      ) : (
        <>
          {vacantUnit ? <Text variant="titleMedium" style={{ fontWeight: '800' }}>{`${t('property.addRenter')} · ${vacantUnit.identifier}`}</Text> : null}
          {/* the quick form: only what is needed to assign the renter. Everything else has a sensible default and sits under More Details. */}
          <Field label={t('tenancy.tenantName')} value={f.name} onChangeText={set('name')} kind="name" error={touched ? e2.name : undefined} testID="quick-name" />
          <Field label={t('tenancy.tenantMobile')} value={f.mobile} onChangeText={set('mobile')} kind="mobile" error={touched ? e2.mobile : undefined} testID="quick-mobile" />
          {idCheck.data?.id_verified ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', backgroundColor: brand.green100, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4, marginTop: -6 }} testID="id-verified">
              <Icon source="check-decagram" size={16} color={brand.green600} />
              <Text style={{ color: brand.green600, fontWeight: '800', fontSize: 12 }}>{t('tenancy.idVerified')}</Text>
            </View>
          ) : null}
          <Field label={t('tenancy.rent')} value={f.rent} onChangeText={set('rent')} kind="amount" error={touched ? e2.rent : undefined} testID="quick-rent" />
          <Field label={t('tenancy.advanceReceived', { defaultValue: 'Advance Received (₹)' })} value={f.deposit} onChangeText={set('deposit')} kind="amount" error={touched ? e2.deposit : undefined} testID="quick-advance" />
          {needsPayChoice ? <PayHow value={payHow} onChange={setPayHow} showErrors={touched} /> : null}
          <List.Accordion title={t('tenancy.moreDetails')} expanded={more} onPress={() => setMore(!more)} testID="more-details">
            <View style={{ gap: 12, paddingVertical: 12 }}>
              <Field label={t('tenancy.dueDay')} value={f.due} onChangeText={set('due')} kind="day" maxNumber={31} min={1} error={touched ? e2.due : undefined} />
              <Field label={`${t('tenancy.startDate')} (DD-MM-YYYY)`} value={f.start} onChangeText={set('start')} kind="date" error={touched ? e2.start : undefined} />
              <Field label={`${t('tenancy.endDate', { defaultValue: 'End Date' })} (DD-MM-YYYY)`} value={f.end} onChangeText={set('end')} kind="date" error={touched ? e2.end : undefined} testID="end-date-input" />
              <Field label={t('tenancy.itemsProvided')} value={f.items} onChangeText={set('items')} multiline lines={4} maxLength={2000} testID="items-provided-input" />
              <Text variant="bodySmall" style={{ color: brand.muted, marginTop: -6 }}>{t('tenancy.itemsHelp')}</Text>
              {needsPayChoice ? null : <PayHow value={payHow} onChange={setPayHow} showErrors={touched} />}
              <Field label={t('agreement.yearlyIncrease')} value={f.increase} onChangeText={set('increase')} kind="percent" maxNumber={100} testID="yearly-increase" />
              <Field label={t('common.email')} value={f.email} onChangeText={set('email')} kind="email" />
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
