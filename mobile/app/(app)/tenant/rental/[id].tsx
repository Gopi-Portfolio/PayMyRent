import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Icon, List, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { fmtDate, fmtMonth } from '@/lib/dates';
import { BillView } from '@/components/BillView';
import { RenterRelief } from '@/components/RentRelief';
import { RenterVacate } from '@/components/VacateRequest';
import { ItemsProvided } from '@/components/ItemsProvided';
import { AgreementLink } from '@/components/AgreementLink';
import { DownloadButtons } from '@/components/DownloadButtons';
import { NoteInput } from '@/components/NoteInput';
import { SearchableSelect } from '@/components/SearchableSelect';
import { Avatar, ErrorBanner, Field, Panel, Screen, StatusPill, TabPills } from '@/components/ui';
import { api } from '@/lib/api';
import { submitOrQueue } from '@/lib/offline';
import { Button } from '@/components/Buttons';
import { formatINR, parseRupeesToPaise } from '@/lib/format';
import { brand } from '@/theme';

export default function Rental() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const month = new Date().toISOString().slice(0, 7) + '-01';
  const bill = useQuery({ queryKey: ['bill', id, month], queryFn: () => api<any>(`/api/v1/tenancies/${id}/bill?month=${month}`),
                          refetchInterval: (q) => (q.state.data?.relief?.status === 'requested' ? 15000 : false) });   // waiting for the owner: look again every 15 seconds
  const rentals = useQuery({ queryKey: ['rentals'], queryFn: () => api<any>('/api/v1/tenant/rentals') });
  const rental = (rentals.data?.items ?? []).find((r: any) => r.id === id);
  const hist = useQuery({ queryKey: ['history', id], queryFn: () => api<any>(`/api/v1/tenancies/${id}/history`) });
  const [tab, setTab] = useState('bill');
  const [sub, setSub] = useState({ category: 'electricity', prev: '', curr: '', amount: '' });
  const [err, setErr] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); qc.invalidateQueries(); } catch (e) { setErr(e); } };

  return (
    <Screen>
      {rental ? (
        <Panel>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Avatar name={rental.owner_name} size={48} />
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall" style={{ fontWeight: '800' }}>{rental.owner_name}</Text>
              <Text variant="bodySmall" style={{ color: brand.muted }}>{`${rental.identifier} · ${rental.property_name ?? rental.address}`}</Text>
            </View>
            <StatusPill status={rental.owner_verification === 'verified' ? 'verified' : rental.owner_verification === 'submitted' ? 'pending' : rental.status} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: brand.teal50, borderRadius: 12, padding: 10 }}>
            <Icon source="lock" size={16} color={brand.teal700} />
            <Text variant="bodySmall" style={{ flex: 1, color: brand.teal700, fontWeight: '700' }}>{`${rental.your_mobile} · ${t('tenant.lockedPhone')}`}</Text>
          </View>
        </Panel>
      ) : null}
      <TabPills value={tab} onChange={setTab} tabs={[
        { value: 'bill', label: t('bill.totalDue'), icon: 'receipt-text-outline' }, { value: 'enter', label: t('bill.electricity'), icon: 'flash-outline' },
        { value: 'history', label: t('bill.paid'), icon: 'history' }, { value: 'notes', label: t('tenancy.notesTab'), icon: 'note-text-outline' }]} />
      <ErrorBanner error={err || bill.error} />
      {tab === 'bill' ? <><AgreementLink tenancyId={String(id)} endDate={rental?.end_date} /><ItemsProvided text={rental?.items_provided} /><BillView bill={bill.data} /><RenterRelief tenancyId={String(id)} month={month} bill={bill.data} /><RenterVacate rental={rental} /></> : null}
      {tab === 'enter' ? (
        <>
          <Text variant="bodySmall">{t('bill.submitReading')} — {t('bill.proposed')}</Text>
          <SearchableSelect label={t('bill.charge')} value={sub.category} onChange={(v) => setSub({ ...sub, category: v })}
            options={['electricity', 'water', 'misc', 'maintenance'].map((c) => ({ value: c, label: t(`bill.${c}`) }))} />
          <Field label={t('bill.prevReading')} value={sub.prev} onChangeText={(v) => setSub({ ...sub, prev: v })} kind="reading" />
          <Field label={t('bill.currReading')} value={sub.curr} onChangeText={(v) => setSub({ ...sub, curr: v })} kind="reading"
                 error={sub.prev && sub.curr && Number(sub.curr) < Number(sub.prev) ? 'reading_lower' : undefined} />
          <Field label={t('pay.amount')} value={sub.amount} onChangeText={(v) => setSub({ ...sub, amount: v })} kind="amount" />
          <Button mode="contained" disabled={!parseRupeesToPaise(sub.amount) || !!(sub.prev && sub.curr && Number(sub.curr) < Number(sub.prev))} onPress={() => run(() => api(`/api/v1/tenancies/${id}/charge-submissions`, {
            body: { period_month: month, category: sub.category, amount: sub.amount,
                    reading_previous: sub.prev ? Number(sub.prev) : null, reading_current: sub.curr ? Number(sub.curr) : null } }))}>
            {t('common.save')}
          </Button>
        </>
      ) : null}
      {tab === 'history' ? (
        <>
          <DownloadButtons path={`/api/v1/tenancies/${id}/statement`} fileName="rentmeezy-statement" />
          {(hist.data?.months ?? []).map((m: any) => (
            <Panel key={m.period_month}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}><Text style={{ fontWeight: '800' }}>{fmtMonth(m.period_month)}</Text><Text variant="bodySmall" style={{ color: brand.muted }}>{`${formatINR(m.total_paise)} · ${formatINR(m.open_paise)} open · ${t('dates.dueOn', { date: fmtDate(m.due_date) })}`}</Text></View>
              <StatusPill status={m.status} /></View></Panel>
          ))}
          {(hist.data?.payments ?? []).map((p: any) => (
            <List.Item key={p.id} title={`${formatINR(p.amount_paise)} · ${fmtDate(p.paid_on)}`}
              description={`${p.verification === 'owner_recorded' ? t('pay.cashLabel') : p.verification} · ${p.status}${p.tenant_ack ? ` · ${p.tenant_ack}` : ''}`}
              right={() => (p.verification === 'owner_recorded' && !p.tenant_ack ? (
                <Button compact onPress={() => run(() => api(`/api/v1/tenant/payments/${p.id}/ack`, { body: { response: 'disputed', reason: 'Amount does not match what I paid' } }))}>
                  {t('pay.dispute')}
                </Button>) : null)} />
          ))}
        </>
      ) : null}
      {tab === 'notes' ? (
        <NoteInput onSubmit={(body, method) => run(() => submitOrQueue({ kind: 'note.create', label: t('offline.itemNote', { text: body.slice(0, 40) }), path: `/api/v1/tenancies/${id}/notes`, body: { target_type: 'tenancy', target_id: id, body, input_method: method } }))} />
      ) : null}
    </Screen>
  );
}
