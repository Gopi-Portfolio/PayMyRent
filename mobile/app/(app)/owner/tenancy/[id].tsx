import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { Dialog, Icon, List, Portal, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { dmyToIso, fmtDate, todayDMY } from '@/lib/dates';
import { BillView } from '@/components/BillView';
import { NoteInput } from '@/components/NoteInput';
import { SearchableSelect } from '@/components/SearchableSelect';
import { AmountHero, Avatar, ErrorBanner, Field, Money, Panel, Screen, StatusPill, TabPills } from '@/components/ui';
import { goBack } from '@/components/ui';
import { DownloadButtons } from '@/components/DownloadButtons';
import { OwnerRelief } from '@/components/RentRelief';
import { ItemsProvided } from '@/components/ItemsProvided';
import { AgreementLink } from '@/components/AgreementLink';
import { OwnerPayHow } from '@/components/PayHow';
import { MessageLink } from '@/components/MessageLink';
import { api, newIdempotencyKey } from '@/lib/api';
import { Button } from '@/components/Buttons';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { submitOrQueue } from '@/lib/offline';
import { MAX_ENTRY_PAISE, capToDue, formatINR, parseRupeesToPaise } from '@/lib/format';
import { brand } from '@/theme';

export default function OwnerTenancy() {
  const { t } = useTranslation();
  const { id, remove } = useLocalSearchParams<{ id: string; remove?: string }>();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const qc = useQueryClient();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7) + '-01');
  const detail = useQuery({ queryKey: ['tenancy', id], queryFn: () => api<any>(`/api/v1/owner/tenancies/${id}`, { ownerAccount: owner }) });
  const bill = useQuery({ queryKey: ['bill', id, month], queryFn: () => api<any>(`/api/v1/tenancies/${id}/bill?month=${month}`) });
  const [tab, setTab] = useState('bill');
  const [cat, setCat] = useState<string | null>('electricity');
  const [amt, setAmt] = useState('');
  const [dep, setDep] = useState({ type: 'applied_to_dues', amount: '', reason: '' });
  const [endOpen, setEndOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  // opened from Remove Renter on the home screen: the removal is already open (an invited renter gets the confirmation, a living-in renter the end form)
  const askedRemove = useRef(false);
  React.useEffect(() => {
    const st = detail.data?.tenancy?.status;
    if (remove !== '1' || askedRemove.current || !st) return;
    askedRemove.current = true;
    if (st === 'invited') setRemoveOpen(true); else if (st === 'active') setEndOpen(true);
  }, [remove, detail.data?.tenancy?.status]);   // 'wrong number? remove this renter' confirmation
  const [vac, setVac] = useState({ date: todayDMY(), deposit: '', handover: '' });
  const [terms, setTerms] = useState({ rent: '', from: todayDMY(), due: '', grace: '', advance: '', items: '', increase: '' });
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(savedTimer.current), []);
  const [monthText, setMonthText] = useState(todayDMY());
  const [err, setErr] = useState<unknown>(null);
  const idem = useRef(newIdempotencyKey());
  // the most each deposit action can be for, from the server's own numbers: a refund or an adjustment cannot be more than is held,
  // an adjustment cannot be more than is due, and the advance received cannot go past the advance agreed (when one is agreed)
  const dDetail = detail.data;
  const depositLimit = (type: string): number => {
    const held = Math.max(dDetail?.deposit_held_paise ?? 0, 0);
    const due = Math.max(dDetail?.payable_now_paise ?? dDetail?.balance_paise ?? 0, 0);
    const agreed = dDetail?.tenancy?.deposit_agreed_paise ?? 0;
    if (type === 'refund') return held;
    if (type === 'applied_to_dues') return Math.min(held, due);
    return agreed > 0 ? Math.max(agreed - held, 0) : MAX_ENTRY_PAISE;
  };
  const depLimit = depositLimit(dep.type);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['bill', id] }); qc.invalidateQueries({ queryKey: ['tenancy', id] }); qc.invalidateQueries({ queryKey: ['dash'] }); qc.invalidateQueries({ queryKey: ['units'] }); qc.invalidateQueries({ queryKey: ['vacant'] }); };

  async function run(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); refresh(); } catch (e) { setErr(e); }
  }
  const d = detail.data;
  const loadedFor = useRef<string | null>(null);
  React.useEffect(() => {   // fill the Terms form once from the saved values
    if (!d || loadedFor.current === `${id}:${d.tenancy.version}`) return;
    loadedFor.current = `${id}:${d.tenancy.version}`;
    setTerms((x) => ({ ...x, rent: String((d.current_rent_paise ?? d.tenancy.monthly_rent_paise) / 100), due: String(d.tenancy.due_day ?? ''),
                       grace: String(d.tenancy.grace_days ?? 0), advance: String((d.tenancy.deposit_agreed_paise ?? 0) / 100), items: d.tenancy.items_provided ?? '', increase: d.tenancy.increment_percent ? String(Number(d.tenancy.increment_percent)) : '' }));
  }, [d, id]);
  const enabled = (d?.charge_config ?? []).filter((c: any) => c.enabled).map((c: any) => c.category);

  return (
    <Screen>
      {d ? (
        <Panel>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Avatar name={d.contact?.name ?? d.unit.identifier} size={52} />
            <View style={{ flex: 1 }}>
              <Text variant="titleMedium" style={{ fontWeight: '800' }}>{d.contact?.name ?? d.unit.identifier}</Text>
              <Text variant="bodySmall" style={{ color: '#5B6B67' }}>{`${d.unit.identifier} · ${t('dates.since', { date: fmtDate(d.tenancy.start_date) })}${d.tenancy.end_date ? ` – ${fmtDate(d.tenancy.end_date)}` : ''}`}</Text>
            </View>
            <StatusPill status={d.tenancy.status} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: brand.teal50, borderRadius: 12, padding: 10 }}>
            <Icon source="lock" size={16} color={brand.teal700} />
            <Text variant="bodySmall" style={{ flex: 1, color: brand.teal700, fontWeight: '700' }}>{`${d.contact?.phone ?? d.tenancy.invited_phone} · ${t('tenant.lockedPhone')}`}</Text>
          </View>
          {d.tenancy.status === 'active' && !endOpen ? (
            <Button textColor="crimson" icon="account-remove-outline" onPress={() => setEndOpen(true)} testID="remove-renter">{t('tenancy.removeRenter')}</Button>
          ) : null}
          {d.tenancy.status === 'active' ? (
            <Button mode="contained" icon="hand-coin" onPress={() => router.push({ pathname: '/(app)/owner/record-payment', params: { tenancyId: String(id) } })} testID="record-payment">
              {t('renter.recordPayment')}
            </Button>
          ) : null}
          {d.tenancy.status === 'invited' ? (
            <Button icon="message-text-outline" onPress={() => run(() => api(`/api/v1/owner/tenancies/${id}/resend-invite`, { method: 'POST', ownerAccount: owner }))} testID="resend-invite">
              {t('tenancy.resendInvite', { defaultValue: 'Send invitation again' })}
            </Button>
          ) : null}
          {d.tenancy.status === 'invited' ? (
            <Button icon="account-remove-outline" textColor="crimson" onPress={() => setRemoveOpen(true)} testID="remove-invite">
              {t('tenancy.wrongNumber')}
            </Button>
          ) : null}
        </Panel>
      ) : null}
      {endOpen ? (() => {
            const iso = dmyToIso(vac.date);
            const okDate = !!iso && iso <= new Date().toISOString().slice(0, 10) && iso > String(d?.tenancy.start_date ?? '');
            return (
              <Panel>
                <Text variant="titleMedium" style={{ fontWeight: '800', color: 'crimson' }}>{t('tenancy.vacateTitle')}</Text>
                <Text variant="bodySmall" style={{ color: '#5B6B67', marginBottom: 8 }}>{t('tenancy.vacateHelp')}</Text>
                <Text style={{ fontWeight: '700', marginBottom: 8 }}>{t('tenancy.vacateInfo', { held: formatINR(d?.deposit_held_paise ?? 0), due: formatINR(Math.max(d?.balance_paise ?? 0, 0)) })}</Text>
                <Field label={t('tenancy.vacatedOn')} value={vac.date} onChangeText={(v) => setVac({ ...vac, date: v })} kind="date" error={okDate ? undefined : 'date_invalid'} />
                <Field label={t('tenancy.depositNote')} value={vac.deposit} onChangeText={(v) => setVac({ ...vac, deposit: v })} kind="reason" />
                <Field label={t('tenancy.handoverNote')} value={vac.handover} onChangeText={(v) => setVac({ ...vac, handover: v })} kind="reason" />
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 6 }}>
                  <Button style={{ flex: 1 }} onPress={() => setEndOpen(false)}>{t('common.cancel')}</Button>
                  <Button style={{ flex: 2 }} mode="contained" disabled={!okDate} testID="vacate-confirm" onPress={() => run(async () => {
                    await api(`/api/v1/owner/tenancies/${id}/end?end_date=${iso}`, { ownerAccount: owner, body: { deposit_note: vac.deposit.trim() || null, handover_note: vac.handover.trim() || null } });
                    setEndOpen(false); goBack();
                  })}>{t('tenancy.vacateConfirm')}</Button>
                </View>
              </Panel>
            );
          })() : null}
      {d ? <OwnerPayHow tenancyId={String(id)} method={d.tenancy.pay_method} upi={d.tenancy.pay_upi_id} effective={d.effective_pay_method} active={d.tenancy.status === 'active' || d.tenancy.status === 'invited'} /> : null}
      <TabPills value={tab} onChange={setTab} tabs={[
        { value: 'bill', label: t('bill.totalDue'), icon: 'receipt-text-outline' }, { value: 'charges', label: t('bill.misc'), icon: 'plus-circle-outline' },
        { value: 'terms', label: t('terms.tab'), icon: 'pencil-outline' }, { value: 'deposit', label: t('tenant.deposit'), icon: 'shield-lock-outline' }, { value: 'notes', label: t('tenancy.notesTab'), icon: 'note-text-outline' }]} />
      <ErrorBanner error={err || bill.error} />
      {tab === 'bill' ? (
        <>
          <Field label={t('bill.billDate')} value={monthText} onChangeText={(v) => { setMonthText(v); const iso = dmyToIso(v); if (iso) setMonth(`${iso.slice(0, 7)}-01`); }} kind="date" />
          <OwnerRelief tenancyId={String(id)} month={month} bill={bill.data} owner={owner} />
          <AgreementLink tenancyId={String(id)} endDate={d?.tenancy.end_date} />
          <MessageLink tenancyId={String(id)} />
          <ItemsProvided text={d?.tenancy.items_provided} />
          <BillView bill={bill.data} />
          <DownloadButtons path={`/api/v1/tenancies/${id}/statement`} fileName="rentmeezy-statement" ownerAccount={owner} />
          <Button icon="file-document" onPress={() => run(() => api(`/api/v1/owner/tenancies/${id}/invoices?month=${month}`, { method: 'POST', ownerAccount: owner }))}>
            {t('bill.generate')}
          </Button>
          {bill.data?.submissions?.filter((s: any) => s.status === 'proposed').map((s: any) => (
            <List.Item key={s.id} title={`${t(`bill.${s.category}`)} · ${s.reading_previous ?? ''}→${s.reading_current ?? ''}`}
              description={t('bill.proposed')} right={() => (
                <>
                  <Button onPress={() => run(() => api(`/api/v1/owner/charge-submissions/${s.id}/review`, { ownerAccount: owner, body: { approve: true } }))}>✓</Button>
                  <Button onPress={() => run(() => api(`/api/v1/owner/charge-submissions/${s.id}/review`, { ownerAccount: owner, body: { approve: false, reason: 'rejected' } }))}>✕</Button>
                </>
              )} />
          ))}
        </>
      ) : null}
      {tab === 'terms' ? (
        <>
          <Text variant="bodySmall" style={{ color: '#5B6B67' }}>{t('terms.hint')}</Text>
          <Field label={t('tenancy.rent')} value={terms.rent} onChangeText={(v) => setTerms({ ...terms, rent: v })} kind="amount" />
          <Field label={t('terms.effective')} value={terms.from} onChangeText={(v) => setTerms({ ...terms, from: v })} kind="date" />
          <Field label={t('tenancy.dueDay')} value={terms.due} onChangeText={(v) => setTerms({ ...terms, due: v })} kind="day" maxNumber={31} min={1} />
          <Field label={t('terms.grace')} value={terms.grace} onChangeText={(v) => setTerms({ ...terms, grace: v })} kind="day" maxNumber={60} min={0} />
          <Field label={t('terms.advance')} value={terms.advance} onChangeText={(v) => setTerms({ ...terms, advance: v })} kind="amount" />
          <Field label={t('agreement.yearlyIncrease')} value={terms.increase} onChangeText={(v) => setTerms({ ...terms, increase: v })} kind="percent" maxNumber={100} testID="terms-increase" />
          <Text variant="bodySmall" style={{ color: '#5B6B67', marginTop: -6 }}>{t('agreement.yearlyIncreaseHelp')}</Text>
          <Field label={t('tenancy.itemsProvided')} value={terms.items} onChangeText={(v) => setTerms({ ...terms, items: v })} multiline lines={4} maxLength={2000} testID="terms-items" />
          <Text variant="bodySmall" style={{ color: '#5B6B67', marginTop: -6 }}>{t('tenancy.itemsHelp')}</Text>
          {saved ? <Text style={{ color: brand.green600, fontWeight: '700' }}>{t('terms.saved')}</Text> : null}
          <Button mode="contained" icon="content-save-outline" disabled={parseRupeesToPaise(terms.rent) === null || !dmyToIso(terms.from) || !terms.due || +terms.due < 1 || +terms.due > 31 || +terms.grace > 60}
                  onPress={() => run(async () => {
            await submitOrQueue({ kind: 'tenancy.update', label: t('offline.itemTerms'), path: `/api/v1/owner/tenancies/${id}`, method: 'PATCH', ownerAccount: owner, coalesceKey: `tenancy:${id}`, body: {
              version: d.tenancy.version, monthly_rent: terms.rent, rent_effective_month: dmyToIso(terms.from), due_day: +terms.due,
              grace_days: +(terms.grace || 0), security_deposit: terms.advance || '0', items_provided: terms.items, increment_percent: Number(terms.increase || 0) } });
            setSaved(true); clearTimeout(savedTimer.current); savedTimer.current = setTimeout(() => setSaved(false), 3000);
          })}>{t('common.save')}</Button>
        </>
      ) : null}
      {tab === 'charges' ? (
        <>
          <SearchableSelect label={t('bill.charge')} value={cat} onChange={setCat}
            options={[...enabled, 'other'].map((c: string) => ({ value: c, label: t(`bill.${c}`, { defaultValue: c }) }))} />
          <Field label={t('pay.amount')} value={amt} onChangeText={setAmt} kind="amount" />
          <Button mode="contained" disabled={!parseRupeesToPaise(amt)} onPress={() => run(async () => {
            await submitOrQueue({ kind: 'charge.create', label: t('offline.itemCharge', { amount: `₹${amt}` }), path: `/api/v1/owner/tenancies/${id}/charges`, ownerAccount: owner, body: { period_month: month, category: cat, amount: amt } });
            setAmt('');
          })}>{t('common.save')}</Button>
        </>
      ) : null}
      {tab === 'deposit' ? (
        <>
          <AmountHero label={t('tenant.deposit')} paise={d?.deposit_held_paise ?? 0} icon="shield-lock-outline" tone="green" />
          <Text variant="bodySmall" style={{ color: '#5B6B67' }}>{`${t('terms.advance')}: ${formatINR(d?.tenancy.deposit_agreed_paise ?? 0)}`}</Text>
          <SearchableSelect label={t('deposit.action')} value={dep.type} onChange={(v) => setDep({ ...dep, type: v, amount: capToDue(dep.amount, depositLimit(v)).text })}
            options={[{ value: 'received', label: t('deposit.received') }, { value: 'applied_to_dues', label: t('deposit.adjust') }, { value: 'refund', label: t('deposit.refund') }]} />
          {depLimit === 0 ? <Text style={{ color: '#B45309', fontWeight: '700' }} testID="deposit-nothing">{t(`deposit.none_${dep.type}`)}</Text> : null}
          <Field label={t('pay.amount')} value={dep.amount} onChangeText={(v) => setDep({ ...dep, amount: v })} kind="amount" maxPaise={depLimit} />
          <Field label={t('deposit.reason')} value={dep.reason} onChangeText={(v) => setDep({ ...dep, reason: v })} kind="reason" />
          <Button mode="contained" disabled={!parseRupeesToPaise(dep.amount) || (parseRupeesToPaise(dep.amount) ?? 0) > depLimit} onPress={() => run(async () => {
            await api(`/api/v1/owner/tenancies/${id}/deposit`, { ownerAccount: owner, body: { ...dep, idempotency_key: idem.current } });
            idem.current = newIdempotencyKey();
            setDep({ ...dep, amount: '', reason: '' });
          })}>{t('common.confirm')}</Button>
          {!endOpen ? <Button textColor="crimson" icon="door-open" onPress={() => setEndOpen(true)} testID="vacate-open">{t('tenancy.end')}</Button> : null}
        </>
      ) : null}
      {tab === 'notes' ? (
        <NoteInput onSubmit={(body, method) => run(() => submitOrQueue({ kind: 'note.create', label: t('offline.itemNote', { text: body.slice(0, 40) }), path: `/api/v1/tenancies/${id}/notes`,
          body: { target_type: 'tenancy', target_id: id, body, input_method: method } }))} />
      ) : null}
      <Portal>
        <Dialog visible={removeOpen} onDismiss={() => setRemoveOpen(false)}>
          <Dialog.Title>{t('tenancy.removeTitle')}</Dialog.Title>
          <Dialog.Content>
            <Text>{t('tenancy.removeBody', {
              who: d?.contact?.name ?? '', phone: d?.contact?.phone ?? d?.tenancy.invited_phone ?? '', unit: d?.unit.identifier ?? '' })}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setRemoveOpen(false)}>{t('common.cancel')}</Button>
            <Button textColor="crimson" onPress={async () => {
              setRemoveOpen(false);
              try { await api(`/api/v1/owner/tenancies/${id}/cancel-invite`, { method: 'POST', ownerAccount: owner }); refresh(); goBack(); } catch (e) { setErr(e); }
            }} testID="remove-invite-confirm">{t('tenancy.remove', { defaultValue: 'Remove' })}</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </Screen>
  );
}
